// leeshfield REST API 클라이언트 — 호출자의 액세스 토큰을 그대로 전달한다.
// MCP 서버는 자체 권한이 없다: 모든 작업은 사용자 토큰의 권한 범위 안에서 실행된다.

import { config } from "./config.js";

export class LeeshfieldError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function parseError(res: Response): Promise<LeeshfieldError> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
  return new LeeshfieldError(res.status, message, body);
}

export async function apiGet<T>(
  token: string,
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const url = new URL(`${config.leeshfieldApiUrl}${path}`);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function apiPostJson<T>(
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${config.leeshfieldApiUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export async function apiPostForm<T>(
  token: string,
  path: string,
  form: FormData,
): Promise<T> {
  const res = await fetch(`${config.leeshfieldApiUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}
