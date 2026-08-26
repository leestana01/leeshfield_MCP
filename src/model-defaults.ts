// 모델 기본값·선택 정책 — 순수 로직만 둔다(config/네트워크 의존 없음 → 단위 테스트 가능).

/**
 * model 생략 시 MCP가 채우는 기본 모델·해상도.
 *
 * 본체의 defaultDraft()(src/lib/studio/serialize.ts)는 스튜디오 UI 기준의
 * seedance-2.0/720p를 채운다 — 그 값에 맡기지 않고 MCP가 직접 실어 보낸다.
 * 해상도 어휘가 모델마다 다르기 때문이다(H3는 768p/2k뿐이라 720p가 오면 본체가 거절한다).
 */
export const DEFAULT_MODEL = "minimax-h3";
export const DEFAULT_RESOLUTION = "2k";

/**
 * 모델 선택 정책 — 서버 instructions·툴 설명·list_models 응답·거부 메시지가 같은 문장을 쓴다.
 *
 * 모델 선택은 되돌릴 수 없는 지출이다(제출 시점에 크레딧이 예약되고, 모델마다 단가가
 * 몇 배씩 차이 난다). 그런데 클라이언트 LLM은 카탈로그 첫 항목을 그냥 집어 드는 경향이
 * 있어서, 기본값을 바꾸는 것만으로는 임의 선택을 못 막는다. 그래서 세 겹으로 건다:
 * 정책 문장(instructions) · 목록 순서(sortDefaultFirst) · 제출 게이트(modelConfirmedByUser).
 */
export const MODEL_POLICY =
  "사용자가 모델을 지정하지 않았으면 임의로 고르지 말고 먼저 사용자에게 물어본다. " +
  `기본 권장은 ${DEFAULT_MODEL}(${DEFAULT_RESOLUTION})이며, 사용자가 "기본으로/아무거나"라고 ` +
  "답한 경우에만 모델을 생략해 기본값으로 제출할 수 있다. " +
  "generate_video는 modelConfirmedByUser: true 없이는 제출을 거부한다.";

/**
 * 기본 해상도는 기본 모델에만 적용한다. 호출자가 다른 모델을 명시했는데 2k를 끼워 넣으면
 * 그 모델이 지원하지 않는 조합이 되어 본체가 400으로 막는다 — 그 경우엔 비워 두고
 * 본체 기본값(720p)에 맡긴다.
 */
export function withModelDefaults<T extends { model?: string; resolution?: string }>(input: T) {
  const model = input.model ?? DEFAULT_MODEL;
  const resolution =
    input.resolution ?? (model === DEFAULT_MODEL ? DEFAULT_RESOLUTION : undefined);
  return { model, resolution };
}

/** /api/models 응답 항목 — 본체 카탈로그를 그대로 통과시키므로 나머지 필드는 열어 둔다 */
export interface ModelWire {
  id: string;
  label: string;
  resolutions: string[];
  [key: string]: unknown;
}

/**
 * 기본 모델을 목록 맨 앞으로. 본체 카탈로그 순서는 스튜디오 UI 기준(가격·출시 순)이라
 * 첫 항목이 기본 모델이 아니고, 클라이언트는 첫 항목을 그대로 집는 경향이 있다.
 * 나머지 순서는 그대로 둔다(Array.sort는 안정 정렬).
 */
export function sortDefaultFirst(models: ModelWire[]): ModelWire[] {
  return [...models].sort(
    (a, b) => Number(b.id === DEFAULT_MODEL) - Number(a.id === DEFAULT_MODEL),
  );
}
