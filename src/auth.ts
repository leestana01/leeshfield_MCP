// Bearer 토큰 검증 — leeshfield introspection(RFC 7662) 위임 + 단기 캐시.
//
// MCP 사양(2025-06-18)에 따라 미인증 요청에는 401 + WWW-Authenticate 헤더로
// 보호 리소스 메타데이터(RFC 9728) 위치를 알려 클라이언트가 OAuth 플로우를 시작하게 한다.

import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";

export interface TokenInfo {
  token: string;
  userId: string;
  email: string | null;
  name: string | null;
  clientId: string;
  scope: string;
}

interface CacheEntry {
  info: TokenInfo | null;
  expiresAt: number;
}

/** 검증 결과 캐시 — 성공 60초, 실패 10초. 키는 토큰 해시(원문 토큰을 키로 두지 않는다) */
const cache = new Map<string, CacheEntry>();
const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 10_000;
const MAX_CACHE = 5000;

function cacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function introspect(token: string): Promise<TokenInfo | null> {
  const res = await fetch(`${config.leeshfieldApiUrl}/api/oauth/introspect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${config.introspectSecret}`,
    },
    body: new URLSearchParams({ token }),
  });
  if (!res.ok) {
    // 시크릿 불일치 등 설정 오류 — 조용히 401로 뭉개지 않도록 로그를 남긴다
    console.error(`[auth] introspection 실패: HTTP ${res.status}`);
    return null;
  }
  const body = (await res.json()) as {
    active: boolean;
    sub?: string;
    username?: string;
    name?: string;
    client_id?: string;
    scope?: string;
  };
  if (!body.active || !body.sub) return null;
  return {
    token,
    userId: body.sub,
    email: body.username ?? null,
    name: body.name ?? null,
    clientId: body.client_id ?? "",
    scope: body.scope ?? "",
  };
}

export async function verifyToken(token: string): Promise<TokenInfo | null> {
  const key = cacheKey(token);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.info;

  let info: TokenInfo | null = null;
  try {
    info = await introspect(token);
  } catch (err) {
    // 네트워크 오류 등 — 인증 실패로 처리하되 캐시 TTL은 짧게 유지된다
    console.error("[auth] introspection 요청 실패", err);
  }
  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, {
    info,
    expiresAt: Date.now() + (info ? OK_TTL_MS : FAIL_TTL_MS),
  });
  return info;
}

/** 요청별 토큰 정보 보관 (express Request 확장 대신 WeakMap) */
const requestTokens = new WeakMap<Request, TokenInfo>();

export function tokenInfoOf(req: Request): TokenInfo {
  const info = requestTokens.get(req);
  if (!info) throw new Error("인증 컨텍스트가 없습니다.");
  return info;
}

function unauthorized(res: Response, description?: string): void {
  const params = [
    `resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource"`,
    description ? `error="invalid_token", error_description="${description}"` : null,
  ]
    .filter(Boolean)
    .join(", ");
  res
    .status(401)
    .set("WWW-Authenticate", `Bearer ${params}`)
    .json({ error: "unauthorized" });
}

export async function requireBearer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    unauthorized(res);
    return;
  }
  const info = await verifyToken(header.slice(7));
  if (!info) {
    unauthorized(res, "token expired or revoked");
    return;
  }
  requestTokens.set(req, info);
  next();
}
