# leeshfield MCP

[leeshfield](https://leeshfield.klr.kr)(영상 생성 플랫폼)용 MCP(Model Context Protocol) 서버.
AI 클라이언트가 leeshfield 계정으로 로그인해 자산을 추가하고, 이를 참조해 영상을
생성하고 결과를 받아볼 수 있다.

- **엔드포인트**: `https://leeshfield-mcp.klr.kr/mcp`
- **인증**: OAuth 2.1 — 최초 연결 시 브라우저에서 leeshfield 로그인 후 동의하면 끝.
  클라이언트 사전 등록 불필요(동적 등록·PKCE·토큰 갱신 전부 자동).
- 모든 작업은 로그인한 사용자 권한 범위 안에서만 실행된다.

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

## 클라이언트 연결

표준 OAuth를 지원하는 MCP 클라이언트라면 아래에 없어도 URL만 넣으면 연결된다.

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

## 클라이언트 호환성

| 항목 | 지원 |
|---|---|
| 전송 | Streamable HTTP (POST, JSON 응답 모드). GET SSE 스트림은 미지원(405) |
| 인증 | OAuth 2.1 코드 플로우, PKCE **S256만**, 리프레시 토큰, 동적 등록(RFC 7591) |
| 발견 | RFC 9728 PRM(`/.well-known/oauth-protected-resource`) + 레거시 클라이언트용 AS 메타데이터(`/.well-known/oauth-authorization-server`) — 두 경로 모두 `/mcp` 접미 변형 포함 |
| redirect_uri | `https`, 루프백 `http://localhost`·`127.0.0.1`(임의 포트), 커스텀 스킴 |
| CORS | 전 오리진 허용 (브라우저 기반 클라이언트) |
