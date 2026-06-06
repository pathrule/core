// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { embedTextBYO, hasEmbeddingKey } from "./embedding-adapter.js";

const VOYAGE_ENV = {
  PATHRULE_EMBEDDING_PROVIDER: "voyage",
  PATHRULE_EMBEDDING_API_KEY: "vk-test",
} as NodeJS.ProcessEnv;

const OPENAI_ENV = {
  PATHRULE_EMBEDDING_PROVIDER: "openai",
  PATHRULE_EMBEDDING_API_KEY: "sk-test",
} as NodeJS.ProcessEnv;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("embedding-adapter", () => {
  it("hasEmbeddingKey is false without a provider/key and true with both", () => {
    expect(hasEmbeddingKey({} as NodeJS.ProcessEnv)).toBe(false);
    expect(hasEmbeddingKey({ PATHRULE_EMBEDDING_PROVIDER: "voyage" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
    expect(hasEmbeddingKey(VOYAGE_ENV)).toBe(true);
    // Unknown provider name ⇒ OFF.
    expect(
      hasEmbeddingKey({
        PATHRULE_EMBEDDING_PROVIDER: "cohere",
        PATHRULE_EMBEDDING_API_KEY: "x",
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("returns null when no key/provider is configured (capability unwired)", async () => {
    const fetchImpl = vi.fn();
    const result = await embedTextBYO(
      "hello",
      { inputType: "query" },
      { env: {} as NodeJS.ProcessEnv, fetchImpl },
    );
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls Voyage with input_type and returns the native-dimension vector", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }], model: "voyage-3-large" }),
    );
    const result = await embedTextBYO(
      "doc text",
      { inputType: "document" },
      { env: VOYAGE_ENV, fetchImpl },
    );
    expect(result).toEqual({ embedding: [0.1, 0.2, 0.3], model: "voyage-3-large", dims: 3 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("voyageai.com");
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      input: "doc text",
      input_type: "document",
    });
  });

  it("calls OpenAI (no input_type knob) and returns the vector", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ data: [{ embedding: [1, 2, 3, 4] }], model: "text-embedding-3-large" }),
    );
    const result = await embedTextBYO("q", { inputType: "query" }, { env: OPENAI_ENV, fetchImpl });
    expect(result?.dims).toBe(4);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("openai.com");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input_type).toBeUndefined();
  });

  it("throws on a provider HTTP error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 429));
    await expect(
      embedTextBYO("x", { inputType: "query" }, { env: VOYAGE_ENV, fetchImpl }),
    ).rejects.toThrow(/voyage_http_429/);
  });

  it("throws on empty input before any fetch", async () => {
    const fetchImpl = vi.fn();
    await expect(
      embedTextBYO("   ", { inputType: "query" }, { env: VOYAGE_ENV, fetchImpl }),
    ).rejects.toThrow(/empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-numeric / empty vector", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ embedding: ["nope"] }] }));
    await expect(
      embedTextBYO("x", { inputType: "query" }, { env: VOYAGE_ENV, fetchImpl }),
    ).rejects.toThrow(/non_numeric|invalid/);
  });
});
