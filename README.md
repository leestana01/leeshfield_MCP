# leeshfield MCP

leeshfield(영상 생성 플랫폼)용 MCP(Model Context Protocol) 서버.
AI 클라이언트(Claude 등)가 OAuth로 leeshfield 계정에 로그인해 자산을 추가하고,
이를 참조해 영상을 생성하고 결과를 반환받을 수 있다.

## 아키텍처

```
MCP 클라이언트 (Claude 등)
   │  Streamable HTTP + OAuth 2.1 (PKCE)
   ▼
leeshfield-mcp  ← 이 리포. 얇은 어댑터 (리소스 서버)
   │  Bearer 토큰 그대로 전달 (introspection으로 검증)
   ▼
leeshfield 본체  ← 인가 서버(/oauth/authorize, /api/oauth/*) + REST API
```

- **인가 서버는 leeshfield 본체다.** 사용자 세션(로그인·동의 화면)이 그 도메인에 있기 때문.
  이 서버는 RFC 9728 보호 리소스 메타데이터로 AS 위치만 알려준다.
- 이 서버는 자체 권한이 없다. 모든 툴 호출은 사용자 액세스 토큰을 leeshfield API에
  그대로 전달하며, 워크스페이스 권한·테넌트 격리는 leeshfield가 강제한다.
- stateless Streamable HTTP — 세션 상태가 없어 재배포·다중 레플리카에 안전하다.

## 툴

| 툴 | 설명 |
|---|---|
| `whoami` | 계정·활성 워크스페이스·크레딧 잔액 |
| `list_models` | 모델 카탈로그 (해상도·화면비·길이·첨부 한도) |
| `list_assets` | 자산 목록 (kind/q/limit 필터) |
| `upload_asset` | URL 또는 base64로 자산 업로드 (중복 시 기존 자산 반환) |
| `estimate_video` | 생성 전 크레딧 견적·잔액 확인 |
| `generate_video` | 생성 작업 제출 (자산 참조 attachments, 멱등 키 자동) |
| `list_jobs` | 최근 작업 50건 상태 |
| `get_job` | 작업 단건 상태·결과 URL (폴링용) |

## 환경변수

| 이름 | 예시 | 설명 |
|---|---|---|
| `PORT` | `3000` | 리슨 포트 |
| `LEESHFIELD_URL` | `https://leeshfield.klr.kr` | leeshfield 본체 (AS + API) |
| `MCP_PUBLIC_URL` | `https://leeshfield-mcp.klr.kr` | 이 서버의 공개 URL |
| `OAUTH_INTROSPECT_SECRET` | (시크릿) | leeshfield introspection 공유 시크릿 — 본체와 동일 값 |

## 개발

```bash
npm install
LEESHFIELD_URL=http://localhost:3000 MCP_PUBLIC_URL=http://localhost:3100 \
OAUTH_INTROSPECT_SECRET=dev PORT=3100 npm run dev
```

검증: `npm run typecheck && npm run lint`

## 클라이언트 연결

```bash
# Claude Code
claude mcp add --transport http leeshfield https://leeshfield-mcp.klr.kr/mcp
```

연결 시 브라우저가 열리며 leeshfield 로그인(Google/이메일) 후 동의 화면에서 허용하면 된다.
클라이언트 등록(DCR)·토큰 발급은 자동이다.

## 배포

- 브랜치: `develop` → dev(`dev.leeshfield-mcp.klr.kr`, 내부망 전용) / `main` → prod(`leeshfield-mcp.klr.kr`)
- Jenkins → OCI Registry → ArgoCD (gitops `apps/leeshfield-mcp`)
- dev MCP는 dev leeshfield(`dev.leeshfield.klr.kr`)를, prod는 prod 본체를 바라본다.
