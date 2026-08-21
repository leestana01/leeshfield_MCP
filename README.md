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

**엔드포인트**: `https://leeshfield-mcp.klr.kr/mcp`
(dev: `https://dev.leeshfield-mcp.klr.kr/mcp` — 내부망/VPN 전용, 평소 중지 상태)

공통 사항:
- 최초 연결 시 브라우저가 열리고 leeshfield 로그인(Google/이메일) → 동의 화면에서 허용하면 끝.
- 클라이언트 사전 등록 불필요 — 동적 등록(DCR)·PKCE·토큰 갱신 전부 자동.
- 표준 OAuth를 지원하는 MCP 클라이언트라면 아래에 없어도 URL만 넣으면 연결된다.

### Claude Code

```bash
claude mcp add --transport http leeshfield https://leeshfield-mcp.klr.kr/mcp
# 이후 세션에서 /mcp 명령으로 인증 상태 확인·재로그인
```

### claude.ai / Claude Desktop (커넥터)

설정 → **커넥터(Connectors)** → **커스텀 커넥터 추가** → URL에
`https://leeshfield-mcp.klr.kr/mcp` 입력 → 연결 시 브라우저 인증.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.leeshfield]
url = "https://leeshfield-mcp.klr.kr/mcp"
# 구버전 Codex에서 url 방식이 안 되면 아래 플래그를 함께 켠다
# experimental_use_rmcp_client = true
```

```bash
codex mcp login leeshfield   # 브라우저 OAuth 로그인
```

네이티브 HTTP 지원이 없는 구버전이면 stdio 브리지로 등록한다:

```toml
[mcp_servers.leeshfield]
command = "npx"
args = ["-y", "mcp-remote", "https://leeshfield-mcp.klr.kr/mcp"]
```

### Cursor

`~/.cursor/mcp.json` (또는 프로젝트 `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "leeshfield": { "url": "https://leeshfield-mcp.klr.kr/mcp" }
  }
}
```

### VS Code (Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "leeshfield": { "type": "http", "url": "https://leeshfield-mcp.klr.kr/mcp" }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "leeshfield": { "httpUrl": "https://leeshfield-mcp.klr.kr/mcp" }
  }
}
```

### OAuth를 지원하지 않는 클라이언트 (stdio 브리지)

Streamable HTTP나 OAuth를 모르는 클라이언트는 [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)를
stdio 서버로 등록하면 된다 — 브리지가 브라우저 로그인·토큰 갱신을 대신 처리한다.

```json
{
  "mcpServers": {
    "leeshfield": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://leeshfield-mcp.klr.kr/mcp"]
    }
  }
}
```

### 연결 디버깅

```bash
npx @modelcontextprotocol/inspector
# Transport: Streamable HTTP, URL: https://leeshfield-mcp.klr.kr/mcp → Open Auth로 로그인
```

## 클라이언트 호환성 (서버가 보장하는 것)

| 항목 | 지원 |
|---|---|
| 전송 | Streamable HTTP (POST, JSON 응답 모드). GET SSE 스트림은 미지원(405) — stateless |
| 인증 | OAuth 2.1 코드 플로우, PKCE **S256만**, 리프레시 회전, DCR(RFC 7591) |
| 발견 | RFC 9728 PRM(`/.well-known/oauth-protected-resource`) + 레거시 클라이언트용 AS 메타데이터 미러(`/.well-known/oauth-authorization-server`) — 두 경로 모두 `/mcp` 접미 변형 포함 |
| redirect_uri | `https`, 루프백 `http://localhost`·`127.0.0.1`(임의 포트), 커스텀 스킴 |
| CORS | 전 오리진 허용 (브라우저 기반 클라이언트) |

## 배포

- 브랜치: `develop` → dev(`dev.leeshfield-mcp.klr.kr`, 내부망 전용) / `main` → prod(`leeshfield-mcp.klr.kr`)
- Jenkins → OCI Registry → ArgoCD (gitops `apps/leeshfield-mcp`)
- dev MCP는 dev leeshfield(`dev.leeshfield.klr.kr`)를, prod는 prod 본체를 바라본다.
