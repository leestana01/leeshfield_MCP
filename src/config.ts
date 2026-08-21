// 환경 설정 — 필수값 누락 시 기동 실패 (잘못된 배포가 조용히 뜨는 것 방지)

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`환경변수 ${name}이(가) 설정되지 않았습니다.`);
  return value;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  /** leeshfield 본체 공개 URL (브라우저가 접근하는 인가 서버), 예: https://leeshfield.klr.kr */
  leeshfieldUrl: stripTrailingSlash(required("LEESHFIELD_URL")),
  /** 서버 간 호출(API·introspection)용 URL — 클러스터 내부 Service 주소.
   *  미설정 시 공개 URL 사용. 내부 주소를 쓰면 인그레스 화이트리스트·TLS를 우회해 안정적이다. */
  leeshfieldApiUrl: stripTrailingSlash(
    process.env.LEESHFIELD_INTERNAL_URL ?? required("LEESHFIELD_URL"),
  ),
  /** 이 MCP 서버의 공개 URL, 예: https://leeshfield-mcp.klr.kr */
  publicUrl: stripTrailingSlash(required("MCP_PUBLIC_URL")),
  /** leeshfield introspection 공유 시크릿 */
  introspectSecret: required("OAUTH_INTROSPECT_SECRET"),
} as const;

/** MCP 엔드포인트(리소스 식별자) — PRM의 resource 값과 일치해야 한다 */
export const MCP_RESOURCE = `${config.publicUrl}/mcp`;
