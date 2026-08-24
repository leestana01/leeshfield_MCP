// 모델별 프롬프트 작성 가이드 — 원문은 리포의 docs/ 에 두고 기동 시 한 번만 읽는다.
//
// 왜 서버가 이걸 들고 있나:
//   MiniMax H3는 자유 서술 프롬프트를 받지 않는다. 섹션 헤더가 붙은 고정 스키마
//   (참조 없음 3섹션 / full-reference 6섹션)를 요구하고, 형식을 벗어나면 품질이
//   무너진다. 크레딧은 제출 시점에 예약되므로 형식 위반은 곧 낭비다.
//   그래서 가이드를 툴로 노출하고(get_prompt_guide) 제출 직전에 형식을 강제한다
//   (checkPromptFormat). 툴 설명만으로는 클라이언트가 가이드를 건너뛸 수 있다.
//
// stateless 서버라 요청마다 McpServer를 새로 만든다 — 파일 I/O는 이 모듈 스코프에서
// 한 번만 끝내고 이후에는 메모리 캐시를 쓴다.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type GuideVariant = "base" | "reference";

interface VariantSpec {
  /** docs/ 기준 상대 경로 */
  file: string;
  /** 프롬프트에 줄 시작으로 반드시 등장해야 하는 섹션 헤더 */
  sections: readonly string[];
  /** 언제 이 variant를 쓰는지 — 툴 설명·오류 메시지에 그대로 쓴다 */
  whenToUse: string;
}

interface ModelGuide {
  variants: Record<GuideVariant, VariantSpec>;
  /** 원문 가이드에 없는 leeshfield 적용 제약 — 가이드 앞에 붙여 함께 반환한다 */
  platformNote: string;
}

/* ─────────────────────────────────────────────────────────
   MiniMax H3
   ───────────────────────────────────────────────────────── */

const MINIMAX_H3: ModelGuide = {
  variants: {
    base: {
      file: "minimax_h3/VIDEO_PROMPT_WRITING_GUIDE_base_en.md",
      sections: ["integrated_multimodal_description", "overall_soundscape", "non_diegetic_music"],
      whenToUse: "attachments 없이 텍스트만으로 생성할 때 (T2VA)",
    },
    reference: {
      file: "minimax_h3/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md",
      sections: [
        "subject_definitions",
        "summary",
        "retention_analysis",
        "detailed_description",
        "overall_soundscape",
        "non_diegetic_music",
      ],
      whenToUse: "attachments로 참조 자산을 넣을 때 (full-reference)",
    },
  },
  platformNote: [
    "> **leeshfield 적용 노트 — 아래 원문 가이드에 없는 플랫폼 제약이다. 원문보다 우선한다.**",
    ">",
    "> - 완성된 프롬프트는 `generate_video`의 `prompt` **하나**에 그대로 담는다. 섹션을 나눠 보내는 파라미터는 없다.",
    "> - `prompt` 상한은 **4000자**다. 원문의 `detailed_description` 350~500 단어 권장치를 그대로 지키면 다른 섹션까지 합쳐 초과할 수 있으니, 4000자 안에서 정보 밀도를 우선한다.",
    "> - leeshfield는 `first_frame`/`last_frame` 지정을 노출하지 않는다. 따라서 **attachments가 하나라도 있으면 항상 full-reference 모드**이고, 원문의 I2VA/FL2VA/L2VA 키프레임 지시문은 쓰지 않는다.",
    "> - 프롬프트 안의 `<Picture N>`·`<Video N>`·`<Audio N>` 번호는 **attachments 배열에서 같은 종류끼리의 등장 순서**를 가리킨다 (이미지 3장 중 두 번째 = `<Picture 2>`). 종류별로 따로 센다.",
    "> - minimax-h3는 `negativePrompt`·`seed`·`audioEnabled`·`outputCount`(1 초과)를 지원하지 않는다. 넣어도 공급자에 전달되지 않으므로 그 내용은 프롬프트 본문에 녹여 쓴다.",
    "> - 오디오는 항상 함께 생성된다(끌 수 없다). `overall_soundscape`·`non_diegetic_music`을 비워 두지 말고, 소리가 없어야 하면 `N/A`를 명시한다.",
  ].join("\n"),
};

const GUIDES: Record<string, ModelGuide> = {
  "minimax-h3": MINIMAX_H3,
};

/* ─────────────────────────────────────────────────────────
   원문 로드 — 기동 시 1회. 실패해도 서버는 뜬다(다른 툴까지 죽이지 않는다).
   ───────────────────────────────────────────────────────── */

/** docs/ 는 리포 루트에 있다 — src/(dev)·dist/(prod) 어디서 실행해도 ../docs 로 잡힌다 */
function docPath(relative: string): string {
  return fileURLToPath(new URL(`../docs/${relative}`, import.meta.url));
}

const guideText = new Map<string, string>();

for (const [model, guide] of Object.entries(GUIDES)) {
  for (const [variant, spec] of Object.entries(guide.variants)) {
    const path = docPath(spec.file);
    try {
      guideText.set(`${model}:${variant}`, readFileSync(path, "utf8"));
    } catch (err) {
      // 이미지에 docs/ 가 빠졌을 때 조용히 넘어가면 원인 추적이 어렵다 — 반드시 남긴다.
      console.error(`[guides] 가이드 원문 로드 실패 — ${path}`, err);
    }
  }
}

/* ─────────────────────────────────────────────────────────
   조회
   ───────────────────────────────────────────────────────── */

/** 전용 가이드가 있는 모델인지 */
export function hasGuide(model: string): boolean {
  return model in GUIDES;
}

/** 전용 가이드가 있는 모델 목록 */
export function guideModels(): string[] {
  return Object.keys(GUIDES);
}

/** 첨부 유무로 결정되는 variant — leeshfield는 키프레임 지정을 노출하지 않는다 */
export function variantFor(hasAttachments: boolean): GuideVariant {
  return hasAttachments ? "reference" : "base";
}

export interface ResolvedGuide {
  model: string;
  variant: GuideVariant;
  whenToUse: string;
  requiredSections: readonly string[];
  /** 플랫폼 노트 + 원문 */
  text: string;
}

/** 가이드 본문 조회. 모델에 가이드가 없거나 원문 로드에 실패했으면 null */
export function readGuide(model: string, variant: GuideVariant): ResolvedGuide | null {
  const guide = GUIDES[model];
  if (!guide) return null;
  const spec = guide.variants[variant];
  const text = guideText.get(`${model}:${variant}`);
  if (!text) return null;
  return {
    model,
    variant,
    whenToUse: spec.whenToUse,
    requiredSections: spec.sections,
    text: `${guide.platformNote}\n\n---\n\n${text}`,
  };
}

/* ─────────────────────────────────────────────────────────
   형식 검사 — 제출 게이트
   ───────────────────────────────────────────────────────── */

/**
 * 섹션 헤더는 줄 시작에 있어야 한다. 본문 산문에서 이름만 언급한 경우를
 * 통과시키지 않으려는 의도다.
 */
function hasSection(prompt: string, name: string): boolean {
  return new RegExp(`^[ \\t]*${name}[ \\t]*:`, "im").test(prompt);
}

/** 두 variant 모두 [Shot 1] 로 본문을 시작하도록 요구한다 */
const SHOT_MARKER = /\[\s*Shot\s*1\s*\]/i;

export interface FormatCheck {
  ok: boolean;
  variant: GuideVariant;
  requiredSections: readonly string[];
  /** 빠진 섹션 헤더 */
  missingSections: string[];
  /** [Shot 1] 마커 누락 여부 */
  missingShotMarker: boolean;
}

/**
 * 모델이 요구하는 프롬프트 형식을 지켰는지 검사한다.
 * 전용 가이드가 없는 모델이면 null(검사 대상 아님).
 *
 * 문체·순서까지 강제하지는 않는다 — 구조만 본다. 지나치게 엄격하면 정상 프롬프트를
 * 막아 되레 생성을 방해한다.
 */
export function checkPromptFormat(
  model: string,
  prompt: string,
  hasAttachments: boolean,
): FormatCheck | null {
  const guide = GUIDES[model];
  if (!guide) return null;

  const variant = variantFor(hasAttachments);
  const required = guide.variants[variant].sections;
  const missingSections = required.filter((s) => !hasSection(prompt, s));
  const missingShotMarker = !SHOT_MARKER.test(prompt);

  return {
    ok: missingSections.length === 0 && !missingShotMarker,
    variant,
    requiredSections: required,
    missingSections,
    missingShotMarker,
  };
}
