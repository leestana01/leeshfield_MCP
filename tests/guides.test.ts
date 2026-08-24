// 프롬프트 형식 게이트 단위 테스트.
// 이 게이트가 오탐하면 정상 프롬프트의 생성을 막고, 누락하면 크레딧이 낭비된다.

import { describe, expect, it } from "vitest";
import { checkPromptFormat, readGuide, variantFor } from "../src/guides.ts";

/** 가이드 Case 1(T2VA)을 줄인 형태 */
const BASE_PROMPT = [
  "integrated_multimodal_description: [Shot 1] Live-action, cinematic, a baker opens the shutters.",
  "",
  "overall_soundscape: Wooden shutters scrape open over a quiet street.",
  "",
  "non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo.",
].join("\n");

/** 가이드 7절(full-reference)을 줄인 형태 */
const REFERENCE_PROMPT = [
  "subject_definitions:",
  "<Subject 1> is the coffee-shop environment in <Picture 1>.",
  "",
  "summary:",
  "[reference generation] The target video shows <Subject 1>.",
  "",
  "retention_analysis:",
  "<Subject 1> (appears in [Shot 1]): fully_preserved - the brick wall is retained.",
  "",
  "detailed_description:",
  "The target video uses a realistic sitcom style.",
  "[Shot 1] A medium shot establishes <Subject 1>.",
  "",
  "overall_soundscape:",
  "Soft indoor room tone continues throughout.",
  "",
  "non_diegetic_music:",
  "N/A",
].join("\n");

describe("variantFor", () => {
  it("첨부 유무로 variant가 갈린다", () => {
    expect(variantFor(false)).toBe("base");
    expect(variantFor(true)).toBe("reference");
  });
});

describe("checkPromptFormat", () => {
  it("가이드가 없는 모델은 검사 대상이 아니다", () => {
    expect(checkPromptFormat("seedance-2.0", "고양이가 뛰는 영상", false)).toBeNull();
  });

  it("형식을 지킨 T2VA 프롬프트를 통과시킨다", () => {
    const check = checkPromptFormat("minimax-h3", BASE_PROMPT, false);
    expect(check).not.toBeNull();
    expect(check?.ok).toBe(true);
    expect(check?.variant).toBe("base");
  });

  it("형식을 지킨 full-reference 프롬프트를 통과시킨다", () => {
    const check = checkPromptFormat("minimax-h3", REFERENCE_PROMPT, true);
    expect(check?.ok).toBe(true);
    expect(check?.variant).toBe("reference");
  });

  it("자유 서술 프롬프트를 막고 빠진 섹션을 알려준다", () => {
    const check = checkPromptFormat("minimax-h3", "고양이가 창밖을 보는 영상", false);
    expect(check?.ok).toBe(false);
    expect(check?.missingSections).toEqual([
      "integrated_multimodal_description",
      "overall_soundscape",
      "non_diegetic_music",
    ]);
    expect(check?.missingShotMarker).toBe(true);
  });

  it("첨부가 있으면 T2VA 3섹션만으로는 통과하지 못한다", () => {
    const check = checkPromptFormat("minimax-h3", BASE_PROMPT, true);
    expect(check?.ok).toBe(false);
    expect(check?.missingSections).toContain("subject_definitions");
    expect(check?.missingSections).toContain("detailed_description");
  });

  it("섹션이 다 있어도 [Shot 1] 마커가 없으면 막는다", () => {
    const noShot = BASE_PROMPT.replace("[Shot 1] ", "");
    const check = checkPromptFormat("minimax-h3", noShot, false);
    expect(check?.ok).toBe(false);
    expect(check?.missingSections).toEqual([]);
    expect(check?.missingShotMarker).toBe(true);
  });

  it("산문 속 언급은 섹션 헤더로 치지 않는다", () => {
    const prose =
      "[Shot 1] Please fill the integrated_multimodal_description and overall_soundscape later.";
    const check = checkPromptFormat("minimax-h3", prose, false);
    expect(check?.ok).toBe(false);
    expect(check?.missingSections).toHaveLength(3);
  });
});

describe("readGuide", () => {
  it("두 variant 원문을 모두 읽어 온다 (이미지에 docs/가 빠지면 여기서 걸린다)", () => {
    for (const variant of ["base", "reference"] as const) {
      const guide = readGuide("minimax-h3", variant);
      expect(guide, `${variant} 가이드 원문 로드 실패`).not.toBeNull();
      expect(guide?.text).toContain("leeshfield 적용 노트");
      expect(guide?.text.length).toBeGreaterThan(1000);
    }
  });

  it("가이드 원문에 필수 섹션 이름이 실제로 등장한다", () => {
    const base = readGuide("minimax-h3", "base");
    for (const section of base?.requiredSections ?? []) {
      expect(base?.text).toContain(section);
    }
  });

  it("가이드가 없는 모델은 null", () => {
    expect(readGuide("seedance-2.0", "base")).toBeNull();
  });
});
