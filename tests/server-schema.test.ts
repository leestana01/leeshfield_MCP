// MCP 툴 스키마의 OpenAI/Codex 호환성 회귀 테스트.
// Draft-07 튜플은 items를 배열로 직렬화하지만 OpenAI 함수 툴은 단일 items 스키마만 받는다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";

type JsonSchema = Record<string, unknown>;

async function listTools() {
  process.env.LEESHFIELD_URL = "http://localhost:3000";
  process.env.MCP_PUBLIC_URL = "http://localhost:3001";
  process.env.OAUTH_INTROSPECT_SECRET = "test-secret";

  const { createServer } = await import("../src/server.ts");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    token: "test-token",
    userId: "test-user",
    email: "test@example.com",
    name: "Test User",
    clientId: "schema-test",
    scope: "",
  });
  const client = new Client({ name: "schema-test", version: "1.0.0" });

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

function pathsWithArrayItems(value: unknown, path = "$"): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => pathsWithArrayItems(item, `${path}[${index}]`));
  }

  const schema = value as JsonSchema;
  const current = Array.isArray(schema.items) ? [`${path}.items`] : [];
  return current.concat(
    Object.entries(schema).flatMap(([key, child]) => pathsWithArrayItems(child, `${path}.${key}`)),
  );
}

describe("MCP tool schemas", () => {
  it("Codex가 모든 툴을 등록할 수 있는 items 스키마만 노출한다", async () => {
    const tools = await listTools();

    expect(tools).toHaveLength(17);
    expect(tools.map((tool) => tool.name)).toContain("generate_video");
    expect(
      tools.flatMap((tool) =>
        pathsWithArrayItems(tool.inputSchema, `tools.${tool.name}.inputSchema`),
      ),
    ).toEqual([]);
  });

  it("presigned 업로드 2단계 툴을 노출하고, 로컬 파일은 base64가 아니라 이 경로로 유도한다", async () => {
    const tools = await listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("create_upload_url");
    expect(names).toContain("complete_upload");

    // 1단계: 서명 발급에 필요한 필드가 required인지 (sizeBytes 누락 시 서명 못 함)
    const createUrl = tools.find((tool) => tool.name === "create_upload_url");
    expect(createUrl?.inputSchema.required).toEqual(
      expect.arrayContaining(["name", "mimeType", "sizeBytes"]),
    );

    // 2단계: objectKey만 필수 — 나머지는 서버가 객체에서 판정한다
    const complete = tools.find((tool) => tool.name === "complete_upload");
    expect(complete?.inputSchema.required).toEqual(["objectKey"]);

    // upload_asset 설명이 로컬 파일을 presigned 경로로 돌려보내는지
    const uploadAsset = tools.find((tool) => tool.name === "upload_asset");
    expect(uploadAsset?.description).toContain("create_upload_url");
  });

  it("Claude를 포함한 표준 MCP 클라이언트에서 trim의 기존 2개 숫자 계약을 유지한다", async () => {
    const tools = await listTools();
    const generateVideo = tools.find((tool) => tool.name === "generate_video");
    const attachments = (generateVideo?.inputSchema.properties?.attachments ?? {}) as JsonSchema;
    const attachment = (attachments.items ?? {}) as JsonSchema;
    const properties = (attachment.properties ?? {}) as Record<string, JsonSchema>;
    const trim = properties.trim;

    expect(trim).toMatchObject({
      type: "array",
      minItems: 2,
      maxItems: 2,
      items: { type: "number" },
    });

    const validate = new AjvJsonSchemaValidator().getValidator(trim);
    expect(validate([0, 5]).valid).toBe(true);
    expect(validate([0]).valid).toBe(false);
    expect(validate([0, 5, 10]).valid).toBe(false);
    expect(validate([0, "5"]).valid).toBe(false);
  });
});
