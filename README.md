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
| `get_prompt_guide` | 모델별 프롬프트 형식 가이드 원문 (현재 `minimax-h3`) |
| `list_assets` | 자산 목록 (kind/q/tag 필터, offset 페이지네이션, total 포함) |
| `get_asset` | 자산 상세 + **미리보기 이미지** (이미지 축소본·영상 대표 프레임을 직접 보여줌) |
| `create_upload_url` | **로컬 파일 업로드 1단계** — 저장소 직행 서명 URL 발급 |
| `complete_upload` | **로컬 파일 업로드 2단계** — 업로드된 객체 검증 후 자산 등록 |
| `upload_asset` | 원격 URL 또는 base64로 자산 업로드 (중복 시 기존 자산 반환) |
| `update_asset` | 이름·태그·역할 수정 (자산 정리·분류) |
| `delete_asset` | 휴지통 이동 (웹에서 복구 가능, 프로젝트 참조 시 경고) |
| `estimate_video` | 생성 전 크레딧 견적·잔액 확인 |
| `generate_video` | 생성 작업 제출 (자산 참조 attachments, 멱등 키 자동) |
| `list_jobs` | 최근 작업 50건 상태 |
| `get_job` | 작업 단건 상태·결과 URL (폴링용) |
| `cancel_job` | 진행 중 작업 취소 (예약 크레딧 환불) |
| `retry_job` | 실패·취소 작업 재시도 |
| `list_projects` | 프로젝트 목록 (작업·자산 연결용) |

### 로컬 파일 업로드

MCP 도구 인자는 JSON이라 파일 바이트를 실으려면 base64여야 하고, 그 문자열은 모델
컨텍스트를 그대로 지나간다(원본의 약 1.33배). 그래서 로컬 파일은 `upload_asset`이 아니라
서명 URL 2단계를 쓴다 — 바이트가 모델도 MCP 서버도 거치지 않고 저장소로 직행한다.

```
1. create_upload_url({ name, mimeType, sizeBytes })   → uploadUrl, objectKey
2. curl -sS -X PUT -H "Content-Type: <mimeType>" \
        --data-binary @<파일경로> "<uploadUrl>"        ← 셸에서 실행
3. complete_upload({ objectKey, name })               → assetId, handle
```

서버는 2단계로 올라온 바이트에서 sha256·형식(매직넘버)·해상도·길이를 **직접 계산해**
정책을 검증한다. 선언한 Content-Type이 실제 내용과 다르면 등록이 거부된다.
2단계까지만 하고 3단계를 부르지 않은 업로드는 temp/에 남으며 정리 대상이다
(leeshfield `docs/storage-retention.md` 참고).

`upload_asset`은 원격 URL에서 가져올 때, 또는 셸이 없는 환경에서 아주 작은 파일을
올릴 때만 쓴다.

### 프롬프트 형식이 고정된 모델

`minimax-h3`는 자유 서술 프롬프트를 받지 않는다. 섹션 헤더가 붙은 고정 스키마를 요구한다.

| 상황 | variant | 필수 섹션 |
|---|---|---|
| 첨부 없음 (T2VA) | `base` | `integrated_multimodal_description`, `overall_soundscape`, `non_diegetic_music` |
| 첨부 있음 (full-reference) | `reference` | 위 3개 + `subject_definitions`, `summary`, `retention_analysis`, `detailed_description` |

`get_prompt_guide`로 가이드 원문(+ leeshfield 적용 제약)을 받아 그대로 작성하면 된다.
형식을 벗어난 프롬프트는 `generate_video`가 **공급자에 보내기 전에 거부**하므로 크레딧이
낭비되지 않는다. 원문은 [`docs/minimax_h3/`](docs/minimax_h3)에 있다.

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
