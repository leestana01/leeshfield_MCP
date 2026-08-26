// 모델 기본값·목록 순서 단위 테스트.
// 해상도 어휘가 모델마다 달라서, 기본 해상도를 잘못 끼워 넣으면 본체가 400으로 막는다.
// 목록 순서는 클라이언트의 모델 선택에 그대로 영향을 준다(첫 항목을 집는 경향).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  DEFAULT_RESOLUTION,
  sortDefaultFirst,
  withModelDefaults,
} from "../src/model-defaults.ts";

describe("withModelDefaults", () => {
  it("둘 다 생략하면 기본 모델·기본 해상도를 채운다", () => {
    expect(withModelDefaults({})).toEqual({
      model: DEFAULT_MODEL,
      resolution: DEFAULT_RESOLUTION,
    });
  });

  it("기본 모델을 명시하고 해상도를 생략해도 기본 해상도를 채운다", () => {
    expect(withModelDefaults({ model: DEFAULT_MODEL })).toEqual({
      model: DEFAULT_MODEL,
      resolution: DEFAULT_RESOLUTION,
    });
  });

  it("다른 모델이면 기본 해상도를 끼워 넣지 않는다 — 그 모델이 2k를 지원하지 않을 수 있다", () => {
    expect(withModelDefaults({ model: "seedance-2.0" })).toEqual({
      model: "seedance-2.0",
      resolution: undefined,
    });
  });

  it("호출자가 준 값은 그대로 둔다", () => {
    expect(withModelDefaults({ model: DEFAULT_MODEL, resolution: "768p" })).toEqual({
      model: DEFAULT_MODEL,
      resolution: "768p",
    });
    expect(withModelDefaults({ model: "seedance-2.0", resolution: "1080p" })).toEqual({
      model: "seedance-2.0",
      resolution: "1080p",
    });
  });
});

describe("sortDefaultFirst", () => {
  const catalog = [
    { id: "seedance-2.0", label: "Seedance 2.0", resolutions: ["480p", "720p", "1080p"] },
    { id: "seedance-2.0-fast", label: "Seedance 2.0 Fast", resolutions: ["480p", "720p"] },
    { id: DEFAULT_MODEL, label: "MiniMax H3", resolutions: ["768p", "2k"] },
  ];

  it("기본 모델을 맨 앞으로 올린다", () => {
    expect(sortDefaultFirst(catalog)[0]?.id).toBe(DEFAULT_MODEL);
  });

  it("나머지 순서는 본체 카탈로그 순서를 유지한다", () => {
    expect(sortDefaultFirst(catalog).map((m) => m.id)).toEqual([
      DEFAULT_MODEL,
      "seedance-2.0",
      "seedance-2.0-fast",
    ]);
  });

  it("원본 배열을 변형하지 않는다", () => {
    const before = catalog.map((m) => m.id);
    sortDefaultFirst(catalog);
    expect(catalog.map((m) => m.id)).toEqual(before);
  });

  it("기본 모델이 비활성이라 목록에 없어도 그대로 돌려준다", () => {
    const without = catalog.filter((m) => m.id !== DEFAULT_MODEL);
    expect(sortDefaultFirst(without).map((m) => m.id)).toEqual(without.map((m) => m.id));
  });
});
