// SPDX-License-Identifier: Apache-2.0
// BYO ("bring your own key") embedding adapter.
//
// Embedding works networklessly by default — so semantic search is OFF unless a
// developer exports an embedding key — but a dev who supplies their own
// Voyage/OpenAI key gets first-class semantic recall over a local SQLite vector
// store (brute-force cosine; at solo scale the counts are sub-millisecond).
//
// This module is pure (no SQLite, no network deps beyond fetch) so the
// SQLite-backed and in-memory backends share it.
//
// Env contract (runtime only — never baked into a build):
//   PATHRULE_EMBEDDING_PROVIDER   "voyage" | "openai" (any other value ⇒ OFF)
//   PATHRULE_EMBEDDING_API_KEY    provider API key (read at call time)
//   PATHRULE_EMBEDDING_MODEL      optional; defaults per provider below
//   PATHRULE_EMBEDDING_TIMEOUT_MS optional; default 5000, clamped to [200, 10000]
//
// Contract: embedTextBYO returns `null` when no key/provider is configured
// (capability unwired) and THROWS on a provider/network failure so the caller
// can map it to a soft `provider_failure` skip. The dimension is provider-native
// (whatever the model returns) — the local store keeps it per row and only
// compares vectors of matching dimensionality.

export type EmbeddingProviderName = "voyage" | "openai";

export interface EmbedResult {
  embedding: number[];
  model: string;
  dims: number;
}

/** The injectable embedding seam the backends depend on (tests pass a stub). */
export type EmbedFn = (
  text: string,
  opts: { inputType: "document" | "query" },
) => Promise<EmbedResult | null>;

const DEFAULT_MODEL: Record<EmbeddingProviderName, string> = {
  voyage: "voyage-3-large",
  openai: "text-embedding-3-large",
};

interface ProviderConfig {
  provider: EmbeddingProviderName;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface EmbeddingAdapterOptions {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function resolveConfig(env: NodeJS.ProcessEnv): ProviderConfig | null {
  const rawProvider = (env.PATHRULE_EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  if (rawProvider !== "voyage" && rawProvider !== "openai") return null;
  const apiKey = (env.PATHRULE_EMBEDDING_API_KEY ?? "").trim();
  if (!apiKey) return null;
  const model = (env.PATHRULE_EMBEDDING_MODEL ?? "").trim() || DEFAULT_MODEL[rawProvider];
  const rawTimeout = Number(env.PATHRULE_EMBEDDING_TIMEOUT_MS ?? "5000");
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.max(rawTimeout, 200), 10000)
      : 5000;
  return { provider: rawProvider, apiKey, model, timeoutMs };
}

/** True when a BYO embedding key + provider are present — drives capabilities().semantic. */
export function hasEmbeddingKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveConfig(env) !== null;
}

function toFiniteVector(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("embedding_invalid_vector");
  }
  const numbers = raw.map((v) => Number(v));
  if (numbers.some((n) => !Number.isFinite(n))) {
    throw new Error("embedding_non_numeric_vector");
  }
  return numbers;
}

async function callVoyage(
  text: string,
  config: ProviderConfig,
  inputType: "document" | "query",
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<EmbedResult> {
  const res = await fetchImpl("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: config.model,
      output_dtype: "float",
      input_type: inputType,
    }),
  });
  if (!res.ok) throw new Error(`voyage_http_${res.status}`);
  const json = (await res.json()) as { data?: Array<{ embedding?: unknown }>; model?: string };
  const embedding = toFiniteVector(json.data?.[0]?.embedding);
  return { embedding, model: json.model ?? config.model, dims: embedding.length };
}

async function callOpenAi(
  text: string,
  config: ProviderConfig,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<EmbedResult> {
  // OpenAI has no document/query knob; the param is intentionally ignored here.
  const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      input: text,
      model: config.model,
      encoding_format: "float",
    }),
  });
  if (!res.ok) throw new Error(`openai_http_${res.status}`);
  const json = (await res.json()) as { data?: Array<{ embedding?: unknown }>; model?: string };
  const embedding = toFiniteVector(json.data?.[0]?.embedding);
  return { embedding, model: json.model ?? config.model, dims: embedding.length };
}

/**
 * Embed one text. `null` ⇒ no key/provider configured (capability unwired).
 * Throws on empty input or a provider/network failure — callers wrap in
 * try/catch and map to a soft skip.
 */
export async function embedTextBYO(
  text: string,
  opts: { inputType: "document" | "query" },
  options: EmbeddingAdapterOptions = {},
): Promise<EmbedResult | null> {
  const env = options.env ?? process.env;
  const config = resolveConfig(env);
  if (!config) return null;

  const trimmed = text.trim();
  if (trimmed.length === 0) throw new Error("embedding_empty_input");

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    return config.provider === "voyage"
      ? await callVoyage(trimmed, config, opts.inputType, fetchImpl, controller.signal)
      : await callOpenAi(trimmed, config, fetchImpl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
