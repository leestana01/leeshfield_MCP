// MCP 서버 구성 — leeshfield 영상 생성 플랫폼 툴 15종.
// 각 요청마다 새 인스턴스를 만든다(stateless Streamable HTTP).

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenInfo } from "./auth.js";
import { checkPromptFormat, guideModels, readGuide } from "./guides.js";
import {
  DEFAULT_MODEL,
  DEFAULT_RESOLUTION,
  MODEL_POLICY,
  type ModelWire,
  sortDefaultFirst,
  withModelDefaults,
} from "./model-defaults.js";
import {
  LeeshfieldError,
  apiDelete,
  apiGet,
  apiGetBytes,
  apiPatch,
  apiPostForm,
  apiPostJson,
} from "./leeshfield.js";

/** 업로드 원본 다운로드 상한 — leeshfield 인그레스 한도(512m)보다 보수적으로 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/* ─────────────────────────────────────────────────────────
   응답 헬퍼 — 툴 결과는 JSON 텍스트로 통일
   ───────────────────────────────────────────────────────── */

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function okWith(...content: ToolContent[]) {
  return { content };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) },
    ],
  };
}

async function run<T>(handler: () => Promise<T>) {
  try {
    return await handler();
  } catch (err) {
    if (err instanceof LeeshfieldError) {
      return fail(err.message, { status: err.status, ...err.body });
    }
    console.error("[tool] 처리 실패", err);
    return fail(err instanceof Error ? err.message : "알 수 없는 오류");
  }
}

/* ─────────────────────────────────────────────────────────
   leeshfield 응답 축약 — 토큰 낭비를 줄이기 위해 필요한 필드만
   ───────────────────────────────────────────────────────── */

interface JobViewWire {
  id: string;
  status: string;
  statusLabel: string;
  progressStage: string | null;
  failureMessage: string | null;
  refunded: boolean | null;
  retryable: boolean;
  request: Record<string, unknown>;
  estimatedCredits: number | null;
  actualCredits: number | null;
  results: { url: string | null; source: string; index: number }[];
  queuePosition: number | null;
  createdAt: string;
  updatedAt: string;
}

function compactJob(job: JobViewWire, includeRequest = true) {
  return {
    id: job.id,
    status: job.status,
    statusLabel: job.statusLabel,
    progressStage: job.progressStage,
    failureMessage: job.failureMessage,
    refunded: job.refunded,
    retryable: job.retryable,
    ...(includeRequest ? { request: job.request } : {}),
    estimatedCredits: job.estimatedCredits,
    actualCredits: job.actualCredits,
    results: job.results.map((r) => ({ index: r.index, url: r.url })),
    queuePosition: job.queuePosition,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/* ─────────────────────────────────────────────────────────
   서버 팩토리
   ───────────────────────────────────────────────────────── */

export function createServer(auth: TokenInfo): McpServer {
  // instructions는 클라이언트가 초기화 때 한 번 받아 컨텍스트에 싣는다 —
  // 툴 설명보다 먼저 읽히므로 "고르기 전에 물어라"를 여기에 둔다.
  const server = new McpServer(
    { name: "leeshfield", version: "0.1.0" },
    {
      instructions:
        "leeshfield는 크레딧이 실제로 차감되는 영상 생성 플랫폼이다. " +
        `모델 선택 정책: ${MODEL_POLICY}`,
    },
  );
  const token = auth.token;

  server.registerTool(
    "whoami",
    {
      title: "내 계정·잔액 조회",
      description:
        "로그인한 leeshfield 계정과 활성 워크스페이스의 크레딧 잔액을 조회한다. " +
        "생성 전 잔액 확인에 사용한다.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const wallet = await apiGet<{
          workspaceId: string;
          balance: number;
          reserved: number;
        }>(token, "/api/wallet");
        return ok({
          email: auth.email,
          name: auth.name,
          workspaceId: wallet.workspaceId,
          balanceCredits: wallet.balance,
          reservedCredits: wallet.reserved,
        });
      }),
  );

  server.registerTool(
    "list_models",
    {
      title: "생성 모델 카탈로그",
      description:
        "사용 가능한 영상 생성 모델과 각 모델의 지원 해상도·화면비·길이 범위·첨부 한도를 조회한다. " +
        "generate_video 파라미터를 정하기 전에 호출한다. " +
        `프롬프트 형식이 따로 정해진 모델(${guideModels().join(", ")})은 ` +
        "get_prompt_guide를 먼저 읽어야 제출이 통과된다. " +
        "⚠️ 이 목록은 선택지일 뿐 추천 순위가 아니다 — " +
        MODEL_POLICY,
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const res = await apiGet<{ models: ModelWire[] }>(token, "/api/models");
        return ok({
          models: sortDefaultFirst(res.models).map((m) => ({
            ...m,
            ...(m.id === DEFAULT_MODEL
              ? { isDefault: true, defaultResolution: DEFAULT_RESOLUTION }
              : {}),
          })),
          modelSelectionPolicy: MODEL_POLICY,
        });
      }),
  );

  server.registerTool(
    "get_prompt_guide",
    {
      title: "모델별 프롬프트 작성 가이드",
      description:
        "특정 모델이 요구하는 프롬프트 형식 가이드 원문을 반환한다. " +
        `현재 전용 가이드가 있는 모델: ${guideModels().join(", ")}. ` +
        "이 모델들은 자유 서술이 아니라 고정된 섹션 스키마를 요구하므로, generate_video 호출 전에 " +
        "반드시 이 툴로 가이드를 먼저 읽고 그 형식대로 프롬프트를 작성해야 한다 " +
        "(형식이 어긋나면 generate_video가 제출을 거부한다). " +
        "variant는 참조 자산(attachments) 사용 여부로 고른다.",
      inputSchema: {
        model: z.string().describe("모델 id (list_models 참조)"),
        variant: z
          .enum(["base", "reference"])
          .optional()
          .describe(
            "base = attachments 없이 텍스트만 (기본). reference = attachments로 참조 자산을 넣는 경우",
          ),
      },
    },
    async ({ model, variant }) =>
      run(async () => {
        const resolved = readGuide(model, variant ?? "base");
        if (!resolved) {
          return fail(
            `'${model}'에는 전용 프롬프트 가이드가 없습니다. 일반적인 자연어 프롬프트로 작성하세요.`,
            { modelsWithGuide: guideModels() },
          );
        }
        return okWith(
          {
            type: "text",
            text: JSON.stringify(
              {
                model: resolved.model,
                variant: resolved.variant,
                whenToUse: resolved.whenToUse,
                requiredSections: resolved.requiredSections,
              },
              null,
              2,
            ),
          },
          { type: "text", text: resolved.text },
        );
      }),
  );

  server.registerTool(
    "list_assets",
    {
      title: "자산 목록 조회",
      description:
        "워크스페이스의 자산(이미지·영상·오디오) 목록을 조회한다. 응답 total로 전체 개수를 " +
        "알 수 있고 offset으로 페이지를 넘긴다. 자산의 실제 내용(이미지·영상 프레임)을 보려면 " +
        "get_asset을 호출한다. generate_video의 attachments에 넣을 assetId/handle 탐색에도 사용.",
      inputSchema: {
        kind: z.enum(["image", "video", "audio"]).optional().describe("자산 유형 필터"),
        q: z.string().optional().describe("이름·핸들 부분일치 검색어"),
        tag: z.string().optional().describe("태그 정확일치 필터"),
        limit: z.number().int().min(1).max(200).optional().describe("최대 개수 (기본 50)"),
        offset: z.number().int().min(0).optional().describe("건너뛸 개수 (페이지네이션)"),
      },
    },
    async ({ kind, q, tag, limit, offset }) =>
      run(async () => ok(await apiGet(token, "/api/assets", { kind, q, tag, limit, offset }))),
  );

  server.registerTool(
    "get_asset",
    {
      title: "자산 상세·미리보기",
      description:
        "자산 하나의 상세 메타데이터와 함께 실제 내용을 이미지로 반환한다 " +
        "(이미지는 축소본, 영상은 대표 프레임). 어떤 자산인지 눈으로 확인하고 " +
        "generate_video 참조 여부를 판단할 때 사용한다. 오디오는 메타데이터만 반환된다.",
      inputSchema: {
        asset: z.string().describe("자산 id(ast_...) 또는 handle"),
        includePreview: z
          .boolean()
          .optional()
          .describe("미리보기 이미지 포함 여부 (기본 true — 메타만 필요하면 false)"),
      },
    },
    async ({ asset, includePreview }) =>
      run(async () => {
        const encoded = encodeURIComponent(asset);
        const detail = await apiGet<{ asset: Record<string, unknown> }>(
          token,
          `/api/assets/${encoded}`,
        );
        const content: ToolContent[] = [
          { type: "text", text: JSON.stringify(detail.asset, null, 2) },
        ];
        if (includePreview !== false) {
          const preview = await apiGetBytes(token, `/api/assets/${encoded}/preview`);
          if (preview) {
            content.push({
              type: "image",
              data: preview.buffer.toString("base64"),
              mimeType: preview.mimeType,
            });
          } else {
            content.push({
              type: "text",
              text: "(이 자산은 시각 미리보기를 지원하지 않습니다 — 오디오이거나 미리보기 생성 불가)",
            });
          }
        }
        return okWith(...content);
      }),
  );

  server.registerTool(
    "update_asset",
    {
      title: "자산 정보 수정",
      description:
        "자산의 이름·태그·역할을 수정한다. 여러 자산을 정리·분류할 때 사용한다 " +
        "(예: 제품 사진에 PRODUCT 역할과 태그 부여).",
      inputSchema: {
        asset: z.string().describe("자산 id(ast_...) 또는 handle"),
        name: z.string().min(1).max(200).optional().describe("새 표시명"),
        tags: z.array(z.string().min(1).max(40)).max(20).optional().describe("태그 목록 (전체 교체)"),
        role: z
          .enum(["CHARACTER", "STYLE", "PRODUCT", "LOCATION", "MOTION", "CAMERA", "AUDIO"])
          .nullable()
          .optional()
          .describe("기본 역할 (null이면 해제)"),
      },
    },
    async ({ asset, name, tags, role }) =>
      run(async () =>
        ok(
          await apiPatch(token, `/api/assets/${encodeURIComponent(asset)}`, {
            name,
            tags,
            role,
          }),
        ),
      ),
  );

  server.registerTool(
    "delete_asset",
    {
      title: "자산 삭제 (휴지통)",
      description:
        "자산을 휴지통으로 옮긴다(웹에서 복구 가능). 프로젝트에서 참조 중이면 " +
        "409와 참조 목록을 반환하며, force=true로 강제할 수 있다.",
      inputSchema: {
        asset: z.string().describe("자산 id(ast_...) 또는 handle"),
        force: z.boolean().optional().describe("프로젝트 참조 경고 무시하고 삭제"),
      },
    },
    async ({ asset, force }) =>
      run(async () =>
        ok(
          await apiDelete(
            token,
            `/api/assets/${encodeURIComponent(asset)}`,
            force ? { force: "true" } : undefined,
          ),
        ),
      ),
  );

  server.registerTool(
    "upload_asset",
    {
      title: "자산 업로드",
      description:
        "URL 또는 base64 데이터로 자산(이미지·영상·오디오)을 워크스페이스에 업로드한다. " +
        "업로드된 자산은 generate_video의 참조(attachments)로 사용할 수 있다. " +
        "동일 파일이 이미 있으면 기존 자산 정보를 반환한다.",
      inputSchema: {
        url: z.string().url().optional().describe("다운로드할 원본 URL (url/base64 중 하나 필수)"),
        base64: z.string().optional().describe("base64 인코딩된 파일 데이터"),
        name: z.string().min(1).max(200).describe("자산 표시명 (확장자 포함 권장)"),
        kind: z
          .enum(["image", "video", "audio"])
          .optional()
          .describe("자산 유형 — 생략 시 MIME 타입에서 추론"),
        mimeType: z.string().optional().describe("MIME 타입 (base64 사용 시 권장)"),
      },
    },
    async ({ url, base64, name, kind, mimeType }) =>
      run(async () => {
        let bytes: Buffer;
        let resolvedMime = mimeType ?? "";

        if (url) {
          const res = await fetch(url, { redirect: "follow" });
          if (!res.ok) return fail(`원본 다운로드 실패: HTTP ${res.status}`);
          const len = Number(res.headers.get("content-length") ?? 0);
          if (len > MAX_UPLOAD_BYTES) return fail("파일이 너무 큽니다 (최대 200MB).");
          bytes = Buffer.from(await res.arrayBuffer());
          if (!resolvedMime) resolvedMime = res.headers.get("content-type")?.split(";")[0] ?? "";
        } else if (base64) {
          bytes = Buffer.from(base64, "base64");
        } else {
          return fail("url 또는 base64 중 하나가 필요합니다.");
        }
        if (bytes.byteLength === 0) return fail("빈 파일입니다.");
        if (bytes.byteLength > MAX_UPLOAD_BYTES) return fail("파일이 너무 큽니다 (최대 200MB).");

        const { createHash } = await import("node:crypto");
        const sha256 = createHash("sha256").update(bytes).digest("hex");

        const form = new FormData();
        form.set(
          "file",
          new File([new Uint8Array(bytes)], name, {
            type: resolvedMime || "application/octet-stream",
          }),
        );
        form.set("name", name);
        form.set("sha256", sha256);
        if (kind) form.set("kind", kind);

        try {
          const uploaded = await apiPostForm<{ assetId: string; handle: string }>(
            token,
            "/api/assets/upload",
            form,
          );
          return ok({ uploaded: true, ...uploaded });
        } catch (err) {
          // 중복 파일 — 기존 자산을 그대로 쓰면 된다
          if (err instanceof LeeshfieldError && err.status === 409 && err.body.duplicate) {
            return ok({
              uploaded: false,
              duplicate: true,
              assetId: err.body.existingId,
              name: err.body.existingName,
              message: "동일한 파일이 이미 있어 기존 자산을 반환합니다.",
            });
          }
          throw err;
        }
      }),
  );

  server.registerTool(
    "estimate_video",
    {
      title: "생성 비용 견적",
      description:
        "영상 생성 전 예상 차감 크레딧과 잔액 충분 여부를 조회한다. " +
        "generate_video와 같은 파라미터로 호출해 비용을 먼저 확인한다.",
      inputSchema: {
        model: z.string().optional().describe(`모델 id (기본 ${DEFAULT_MODEL})`),
        resolution: z
          .string()
          .optional()
          .describe(`해상도 (기본 모델은 ${DEFAULT_RESOLUTION}, 그 외 모델은 720p)`),
        aspectRatio: z.string().optional().describe("화면비 (기본 16:9)"),
        durationSec: z.number().optional().describe("길이 초 (기본 5)"),
        outputCount: z.number().int().optional().describe("출력 개수 (기본 1)"),
        videoInputSecs: z
          .array(z.number())
          .optional()
          .describe("참조 영상 각각의 길이(초) — 참조 영상도 과금된다"),
        imageInputCount: z.number().int().optional().describe("참조 이미지 장수"),
      },
    },
    async ({ model, resolution, aspectRatio, durationSec, outputCount, videoInputSecs, imageInputCount }) =>
      run(async () =>
        ok(
          await apiGet(token, "/api/estimate", {
            ...withModelDefaults({ model, resolution }),
            aspectRatio,
            durationSec,
            outputCount,
            hasVideoInput: !!videoInputSecs?.length,
            videoInputSecs: videoInputSecs?.join(","),
            imageInputCount,
          }),
        ),
      ),
  );

  const attachmentInput = z.object({
    assetId: z.string().optional().describe("자산 id (assetId/handle 중 하나 필수)"),
    handle: z.string().optional().describe("자산 핸들"),
    role: z
      .enum(["CHARACTER", "STYLE", "PRODUCT", "LOCATION", "MOTION", "CAMERA", "AUDIO"])
      .optional()
      .describe("첨부 역할"),
    weight: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional().describe("이미지 중요도"),
    trim: z.tuple([z.number(), z.number()]).optional().describe("[시작초, 끝초] 트림 구간"),
    purpose: z
      .enum(["motion", "camera", "rhythm", "composition"])
      .optional()
      .describe("영상 참조 목적"),
  });

  server.registerTool(
    "generate_video",
    {
      title: "영상 생성 제출",
      description:
        "영상 생성 작업을 제출한다. 완료까지 수 분 걸리는 비동기 작업이며, 반환된 jobId로 " +
        "get_job을 폴링해 상태·결과를 확인한다. 자산을 참조하려면 attachments에 " +
        "assetId 또는 handle을 넣는다. 제출 전 estimate_video로 비용 확인을 권장한다. " +
        `⚠️ ${guideModels().join(", ")} 모델은 프롬프트 형식이 고정돼 있다 — 먼저 ` +
        "get_prompt_guide를 호출해 가이드대로 작성해야 하며, 형식을 벗어나면 제출이 거부된다. " +
        `기본 모델이 ${DEFAULT_MODEL}이므로 model을 생략해도 이 형식 검사를 받는다. ` +
        `⚠️ 모델 선택 정책: ${MODEL_POLICY}`,
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("생성 프롬프트"),
        mode: z
          .enum(["t2v", "i2v", "v2v", "audio", "mixed"])
          .optional()
          .describe("생성 모드 — 생략 시 첨부 유무로 추론 (t2v/mixed)"),
        negativePrompt: z.string().max(2000).optional().describe("부정 프롬프트"),
        model: z.string().optional().describe(`모델 id (list_models 참조, 기본 ${DEFAULT_MODEL})`),
        modelConfirmedByUser: z
          .boolean()
          .optional()
          .describe(
            "사용자가 이번 생성에 쓸 모델을 직접 지정했거나, 제안한 모델을 확인해 줬을 때만 true. " +
              "추측으로 채우지 말 것 — 크레딧이 실제로 나가는 선택이고, 사용자는 이 값을 툴 호출에서 그대로 본다. " +
              "생략하거나 false면 제출하지 않고 확인 요청을 돌려준다. " +
              `사용자가 "아무거나/기본으로"라고 답한 경우엔 model을 생략하고 true만 넣으면 ` +
              `기본값(${DEFAULT_MODEL} ${DEFAULT_RESOLUTION})으로 제출된다.`,
          ),
        durationSec: z.number().optional().describe("길이 초 (기본 5)"),
        aspectRatio: z.string().optional().describe("화면비 (기본 16:9)"),
        resolution: z
          .string()
          .optional()
          .describe(`해상도 (기본 모델은 ${DEFAULT_RESOLUTION}, 그 외 모델은 720p)`),
        audioEnabled: z.boolean().optional().describe("오디오 생성 여부"),
        outputCount: z.number().int().min(1).max(4).optional().describe("출력 개수"),
        seed: z.number().int().optional().describe("재현용 시드"),
        attachments: z.array(attachmentInput).max(20).optional().describe("참조 자산 목록"),
        idempotencyKey: z
          .string()
          .optional()
          .describe("중복 제출 방지 키 — 생략 시 자동 생성. 재시도 시 같은 키를 쓰면 중복 제출되지 않는다"),
      },
    },
    async (input) =>
      run(async () => {
        const { modelConfirmedByUser, ...submit } = input;

        // 모델 확인 게이트 — 모델은 단가가 몇 배씩 다른 지출 선택이다. 클라이언트가
        // 사용자에게 묻지 않고 고르는 것을 막기 위해, 확인 플래그 없이는 제출하지 않는다.
        if (!modelConfirmedByUser) {
          const catalog = await apiGet<{ models: ModelWire[] }>(token, "/api/models");
          return fail("어떤 모델로 생성할지 사용자 확인이 필요합니다. 아직 제출하지 않았습니다.", {
            requiresUserConfirmation: true,
            policy: MODEL_POLICY,
            defaultModel: DEFAULT_MODEL,
            defaultResolution: DEFAULT_RESOLUTION,
            availableModels: sortDefaultFirst(catalog.models).map((m) => ({
              id: m.id,
              label: m.label,
              resolutions: m.resolutions,
              isDefault: m.id === DEFAULT_MODEL,
            })),
            nextStep:
              "사용자에게 위 모델 중 무엇으로 만들지 물어보고, 답을 받은 뒤 " +
              "model(필요하면 resolution)과 modelConfirmedByUser: true를 넣어 다시 호출하세요. " +
              `사용자가 "기본으로"라고 하면 model을 생략해도 됩니다(${DEFAULT_MODEL} ${DEFAULT_RESOLUTION}). ` +
              "크레딧은 차감되지 않았습니다.",
          });
        }

        // 형식이 고정된 모델은 제출 전에 막는다. 크레딧은 제출 시점에 예약되므로
        // 공급자까지 보내고 실패하면 그대로 낭비다.
        const defaults = withModelDefaults(submit);
        const model = defaults.model;
        const check = checkPromptFormat(model, input.prompt, !!input.attachments?.length);
        if (check && !check.ok) {
          return fail(`${model} 프롬프트가 이 모델의 필수 형식을 따르지 않아 제출하지 않았습니다.`, {
            model,
            guideVariant: check.variant,
            requiredSections: check.requiredSections,
            missingSections: check.missingSections,
            missingShotMarker: check.missingShotMarker,
            nextStep:
              `get_prompt_guide({ model: "${model}", variant: "${check.variant}" })로 ` +
              "가이드를 읽고 프롬프트를 다시 작성한 뒤 재제출하세요. 크레딧은 차감되지 않았습니다.",
          });
        }

        const res = await apiPostJson<{ jobId: string; reused: boolean }>(token, "/api/jobs", {
          ...submit,
          ...defaults,
          idempotencyKey: submit.idempotencyKey ?? randomUUID(),
        });
        return ok({
          ...res,
          message: res.reused
            ? "이미 제출된 작업입니다. get_job으로 상태를 확인하세요."
            : "작업을 제출했습니다. get_job으로 상태를 폴링하세요 (완료까지 보통 1~5분).",
        });
      }),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "생성 작업 목록",
      description: "현재 워크스페이스의 최근 생성 작업 50건의 상태를 조회한다.",
      inputSchema: {},
    },
    async () =>
      run(async () => {
        const res = await apiGet<{ workspaceId: string; jobs: JobViewWire[] }>(token, "/api/jobs");
        return ok({
          workspaceId: res.workspaceId,
          jobs: res.jobs.map((j) => compactJob(j, false)),
        });
      }),
  );

  server.registerTool(
    "cancel_job",
    {
      title: "생성 작업 취소",
      description:
        "진행 중인 생성 작업을 취소한다. 취소되면 예약 크레딧이 환불된다. " +
        "공급자 처리 단계에 따라 즉시 취소되지 않고 취소 요청 상태가 될 수 있다.",
      inputSchema: {
        jobId: z.string().describe("취소할 작업 id"),
      },
    },
    async ({ jobId }) =>
      run(async () =>
        ok(await apiPostJson(token, `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {})),
      ),
  );

  server.registerTool(
    "retry_job",
    {
      title: "생성 작업 재시도",
      description:
        "실패하거나 취소된 작업을 같은 설정으로 다시 제출한다. 새 jobId가 반환되며 " +
        "크레딧이 다시 예약된다. 콘텐츠 정책 거절 등 재시도 불가 작업은 거부된다.",
      inputSchema: {
        jobId: z.string().describe("재시도할 작업 id"),
      },
    },
    async ({ jobId }) =>
      run(async () =>
        ok(await apiPostJson(token, `/api/jobs/${encodeURIComponent(jobId)}/retry`, {})),
      ),
  );

  server.registerTool(
    "list_projects",
    {
      title: "프로젝트 목록",
      description:
        "워크스페이스의 프로젝트 목록을 조회한다. generate_video의 projectId로 " +
        "작업을 프로젝트에 연결하거나, 자산의 projectId를 해석할 때 사용한다.",
      inputSchema: {},
    },
    async () => run(async () => ok(await apiGet(token, "/api/projects"))),
  );

  server.registerTool(
    "get_job",
    {
      title: "생성 작업 상태·결과 조회",
      description:
        "작업 단건의 상태와 결과를 조회한다. status가 SUCCEEDED면 results[].url로 영상을 " +
        "다운로드할 수 있다(서명 URL — 유효기간이 있으므로 필요 시 다시 조회). " +
        "진행 중이면 잠시 후 다시 호출한다.",
      inputSchema: {
        jobId: z.string().describe("generate_video가 반환한 작업 id"),
      },
    },
    async ({ jobId }) =>
      run(async () => {
        const res = await apiGet<{ workspaceId: string; job: JobViewWire }>(
          token,
          `/api/jobs/${encodeURIComponent(jobId)}`,
        );
        return ok(compactJob(res.job));
      }),
  );

  return server;
}
