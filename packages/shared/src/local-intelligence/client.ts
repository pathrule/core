// SPDX-License-Identifier: Apache-2.0
/**
 * The production boundary to local inference.
 *
 * Small on purpose. It exists so nothing in Studio talks to an inference server directly, and
 * so the three failure classes this project has already paid for cannot come back:
 *
 *  - A dead server answering HTTP 500 was once treated as healthy, because the readiness check
 *    tested connectivity rather than the response. An entire eval arm scored as 47 parse
 *    failures before anyone noticed.
 *  - A relative adapter path 404'd on every request and the run looked merely bad.
 *  - A swallowed request error reported "104 items available, 0 scanned" as if the corpus were
 *    empty, which read like a finding rather than an outage.
 *
 * So: `health()` demands a real successful completion, never a 200 on a metadata route, and
 * every failure is an explicit typed result. This module NEVER returns an empty success.
 */
import { errorMessage } from "../net/failure-class.js";

/** Why a call did not produce text. Each one is actionable and none of them is "empty". */
export type LocalIntelligenceErrorKind =
  | "unreachable"
  | "http_error"
  | "timeout"
  | "malformed_response"
  | "empty_completion";

export interface LocalIntelligenceError {
  kind: LocalIntelligenceErrorKind;
  message: string;
  /** Present when the server answered at all. */
  status?: number;
}

export type InferenceResult =
  | { ok: true; text: string; ms: number }
  | { ok: false; error: LocalIntelligenceError };

export type HealthResult =
  | { ok: true; model: string | null; ms: number }
  | { ok: false; error: LocalIntelligenceError };

export interface LocalIntelligenceConfig {
  /** Where the local server listens. No default host beyond loopback: this never leaves the machine. */
  baseUrl: string;
  /**
   * Adapter directory, ABSOLUTE or omitted.
   *
   * REMEDY runs with NO adapter, which is the production decision from `REMEDY_BASE_MODEL_FINAL`.
   * The field exists so CONSTRAINT and CHECK can later pass `v7-iter250` through the same client
   * rather than growing a second one. A relative path is rejected rather than sent: mlx_lm
   * resolves it against ITS cwd and 404s every request, which is one of the failure classes
   * above.
   */
  adapterPath?: string;
  timeoutMs?: number;
}

export interface InferenceRequest {
  system: string;
  user: string;
  maxTokens?: number;
  /** Deterministic by default. A knowledge pipeline that samples is not reproducible. */
  temperature?: number;
  seed?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** A tiny, dependency-free client. `fetchImpl` is injectable so tests never need a server. */
export class LocalIntelligenceClient {
  private readonly cfg: Required<Pick<LocalIntelligenceConfig, "baseUrl" | "timeoutMs">> &
    Pick<LocalIntelligenceConfig, "adapterPath">;

  constructor(
    config: LocalIntelligenceConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (config.adapterPath !== undefined && !config.adapterPath.startsWith("/")) {
      throw new Error(
        "adapterPath must be absolute: a relative path is resolved against the inference server's own cwd and silently 404s every request",
      );
    }
    this.cfg = {
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      adapterPath: config.adapterPath,
    };
  }

  /**
   * Is the server actually able to answer?
   *
   * Deliberately a real completion rather than a metadata route: the point is to prove the model
   * is loaded and generating, which a 200 on `/v1/models` does not. A zombie server answers that
   * route with a 500 and `curl` still exits 0.
   */
  async health(): Promise<HealthResult> {
    const started = Date.now();
    const probe = await this.infer({
      system: "Reply with exactly: ok",
      user: "ok",
      maxTokens: 4,
    });
    if (!probe.ok) return { ok: false, error: probe.error };
    if (probe.text.trim().length === 0) {
      return {
        ok: false,
        error: { kind: "empty_completion", message: "the server answered with no text" },
      };
    }
    return { ok: true, model: await this.modelName(), ms: Date.now() - started };
  }

  /** Best-effort label for the loaded model. Never gates health: it is provenance, not liveness. */
  private async modelName(): Promise<string | null> {
    try {
      const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/models`, { method: "GET" });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const id = body.data?.[0]?.id;
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  }

  /** One completion. Every failure path returns `ok: false` with a reason; none returns "". */
  async infer(req: InferenceRequest): Promise<InferenceResult> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          temperature: req.temperature ?? 0,
          top_p: 1,
          seed: req.seed ?? 1,
          max_tokens: req.maxTokens ?? 1400,
          chat_template_kwargs: { enable_thinking: false },
          ...(this.cfg.adapterPath ? { adapters: this.cfg.adapterPath } : {}),
        }),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        ok: false,
        error: {
          kind: aborted ? "timeout" : "unreachable",
          message: aborted
            ? `no response within ${this.cfg.timeoutMs} ms`
            : errorMessage(err, "the inference server could not be reached"),
        },
      };
    } finally {
      clearTimeout(timer);
    }

    // A non-2xx is an OUTAGE, not an empty answer. This is the check that was missing when a
    // 500-answering server passed for healthy.
    if (!res.ok) {
      return {
        ok: false,
        error: { kind: "http_error", status: res.status, message: `inference server returned ${res.status}` },
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      return {
        ok: false,
        error: { kind: "malformed_response", status: res.status, message: errorMessage(err, "the response body was not JSON") },
      };
    }
    const text = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      return {
        ok: false,
        error: { kind: "malformed_response", status: res.status, message: "response had no message content" },
      };
    }
    if (text.trim().length === 0) {
      // An empty completion is a failure with its own name, so a caller can never mistake it for
      // "the model found nothing", which is a different and legitimate answer.
      return { ok: false, error: { kind: "empty_completion", status: res.status, message: "the model returned no text" } };
    }
    return { ok: true, text, ms: Date.now() - started };
  }
}
