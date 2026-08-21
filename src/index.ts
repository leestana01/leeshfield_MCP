// leeshfield MCP 서버 — Streamable HTTP (stateless) + OAuth 리소스 서버.
//
// 인가 서버는 leeshfield 본체다. 이 서버는:
//  1) /.well-known/oauth-protected-resource 로 AS 위치를 알리고 (RFC 9728)
//  2) Bearer 토큰을 introspection으로 검증한 뒤
//  3) 툴 호출을 leeshfield REST API로 위임한다 (사용자 토큰 그대로 전달).
//
// stateless 모드: 요청마다 서버·트랜스포트 인스턴스를 새로 만든다.
// 세션 상태가 없어 재시작·재배포에 안전하고 단일 레플리카 제약이 없다.

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_RESOURCE, config } from "./config.js";
import { requireBearer, tokenInfoOf } from "./auth.js";
import { createServer } from "./server.js";

const app = express();
app.use(express.json({ limit: "300mb" }));

// CORS — 브라우저 기반 MCP 클라이언트 지원
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
  });
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// RFC 9728 보호 리소스 메타데이터 — 클라이언트가 인가 서버를 발견하는 진입점.
// 루트 경로와 /mcp 경로 접미 형태(경로 인지 발견) 둘 다 제공한다.
const prm = {
  resource: MCP_RESOURCE,
  authorization_servers: [config.leeshfieldUrl],
  bearer_methods_supported: ["header"],
  scopes_supported: ["mcp"],
  resource_name: "leeshfield MCP",
};
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(prm);
});
app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
  res.json(prm);
});

// 레거시 발견 경로 — 2025-03-26 이전 사양을 따르는 클라이언트(구버전 Codex·mcp-remote 등)는
// PRM을 거치지 않고 MCP 서버 오리진에서 곧바로 AS 메타데이터를 찾는다.
// leeshfield 본체의 /.well-known/oauth-authorization-server와 동일한 내용을 미러링한다.
// ⚠️ leeshfield 쪽 메타데이터 필드가 바뀌면 여기도 함께 갱신할 것.
const asMetadata = {
  issuer: config.leeshfieldUrl,
  authorization_endpoint: `${config.leeshfieldUrl}/oauth/authorize`,
  token_endpoint: `${config.leeshfieldUrl}/api/oauth/token`,
  registration_endpoint: `${config.leeshfieldUrl}/api/oauth/register`,
  scopes_supported: ["mcp"],
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["none"],
  code_challenge_methods_supported: ["S256"],
};
app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(asMetadata);
});
app.get("/.well-known/oauth-authorization-server/mcp", (_req, res) => {
  res.json(asMetadata);
});

// MCP 엔드포인트 — stateless: 요청마다 새 인스턴스
app.post("/mcp", requireBearer, async (req, res) => {
  const server = createServer(tokenInfoOf(req));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] 요청 처리 실패", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "internal error" },
        id: null,
      });
    }
  }
});

// stateless 모드에서는 GET(SSE 재개)·DELETE(세션 종료)를 지원하지 않는다
app.get("/mcp", requireBearer, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed — stateless server" },
    id: null,
  });
});
app.delete("/mcp", requireBearer, (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed — stateless server" },
    id: null,
  });
});

app.listen(config.port, () => {
  console.log(`[mcp] leeshfield MCP 서버 기동 — :${config.port} (${MCP_RESOURCE})`);
});
