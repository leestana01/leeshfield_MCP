// MCP 서버 구성 — leeshfield 영상 생성 플랫폼 툴 8종.
// 각 요청마다 새 인스턴스를 만든다(stateless Streamable HTTP).

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { TokenInfo } from "./auth.js";
import { LeeshfieldError, apiGet, apiPostForm, apiPostJson } from "./leeshfield.js";

/** 업로드 원본 다운로드 상한 — leeshfield 인그레스 한도(512m)보다 보수적으로 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

/* ─────────────────────────────────────────────────────────
   응답 헬퍼 — 툴 결과는 JSON 텍스트로 통일
   ───────────────────────────────────────────────────────── */

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) },
    ],
  };
}

async function run(handler: () => Promise<ReturnType<typeof ok>>) {
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
  const server = new McpServer({ name: "leeshfield", version: "0.1.0" });
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
        "generate_video 파라미터를 정하기 전에 호출한다.",
      inputSchema: {},
    },
    async () => run(async () => ok(await apiGet(token, "/api/models"))),
  );

  server.registerTool(
    "list_assets",
    {
      title: "자산 목록 조회",
      description:
        "워크스페이스의 자산(이미지·영상·오디오) 목록을 조회한다. " +
        "generate_video의 attachments에 넣을 assetId/handle을 찾을 때 사용한다.",
      inputSchema: {
        kind: z.enum(["image", "video", "audio"]).optional().describe("자산 유형 필터"),
        q: z.string().optional().describe("이름·핸들 부분일치 검색어"),
        limit: z.number().int().min(1).max(200).optional().describe("최대 개수 (기본 50)"),
      },
    },
    async ({ kind, q, limit }) =>
      run(async () => ok(await apiGet(token, "/api/assets", { kind, q, limit }))),
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
        model: z.string().optional().describe("모델 id (기본 seedance-2.0)"),
        resolution: z.string().optional().describe("해상도 (기본 720p)"),
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
            model,
            resolution,
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
        "assetId 또는 handle을 넣는다. 제출 전 estimate_video로 비용 확인을 권장한다.",
      inputSchema: {
        prompt: z.string().min(1).max(4000).describe("생성 프롬프트"),
        mode: z
          .enum(["t2v", "i2v", "v2v", "audio", "mixed"])
          .optional()
          .describe("생성 모드 — 생략 시 첨부 유무로 추론 (t2v/mixed)"),
        negativePrompt: z.string().max(2000).optional().describe("부정 프롬프트"),
        model: z.string().optional().describe("모델 id (list_models 참조, 기본 seedance-2.0)"),
        durationSec: z.number().optional().describe("길이 초 (기본 5)"),
        aspectRatio: z.string().optional().describe("화면비 (기본 16:9)"),
        resolution: z.string().optional().describe("해상도 (기본 720p)"),
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
        const res = await apiPostJson<{ jobId: string; reused: boolean }>(token, "/api/jobs", {
          ...input,
          idempotencyKey: input.idempotencyKey ?? randomUUID(),
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
