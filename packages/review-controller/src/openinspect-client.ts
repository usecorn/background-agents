import { createHash } from "node:crypto";
import { z } from "zod";
import { buildOutboundAuthHeaders } from "@open-inspect/shared/service-auth";
import { readBodyCapped } from "@open-inspect/shared/http-body";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = { runId: id, messageId: id, sealed: z.boolean() };
const terminalSchema = z.discriminatedUnion("state", [
  z.strictObject({ ...identity, state: z.literal("pending"), responseDigest: z.null() }),
  z.strictObject({ ...identity, state: z.literal("incomplete"), responseDigest: z.null() }),
  z.strictObject({
    ...identity,
    state: z.literal("completed"),
    responseDigest: digest,
    response: z.strictObject({
      assistantMessageId: z.string().min(1).max(256),
      parentMessageId: z.string().min(1).max(256),
      text: z
        .string()
        .min(1)
        .refine((text) => Buffer.byteLength(text) <= 1024 * 1024),
    }),
  }),
]);

/** Fixed for the attempt; managed creation and recovery must use this same ID. */
export function reviewMessageId(runId: string): string {
  return `review-${z.uuid().parse(runId)}`;
}

/** Configured trusted destination only; never accepts a caller-supplied API URL. */
export class OpenInspectReviewClient {
  private readonly origin: string;
  constructor(
    origin: string,
    private readonly secret: string,
    private readonly request: typeof fetch = fetch
  ) {
    const url = new URL(origin);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      !secret
    ) {
      throw new Error("INVALID_OPENINSPECT_CONFIGURATION");
    }
    this.origin = url.origin;
  }

  async result(sessionId: string, runId: string) {
    const messageId = reviewMessageId(runId);
    const query = new URLSearchParams({ runId, messageId });
    const value = terminalSchema.safeParse(await this.api(sessionId, `result?${query}`));
    if (!value.success || value.data.runId !== runId || value.data.messageId !== messageId) {
      throw new Error("INVALID_OPENINSPECT_RESULT");
    }
    const result = value.data;
    if (
      result.state === "completed" &&
      createHash("sha256").update(result.response.text).digest("hex") !== result.responseDigest
    ) {
      throw new Error("INVALID_OPENINSPECT_RESULT");
    }
    return result;
  }

  async seal(sessionId: string, runId: string, responseDigest: string | null): Promise<void> {
    const body = {
      runId,
      messageId: reviewMessageId(runId),
      responseDigest: digest.nullable().parse(responseDigest),
    };
    const value = await this.api(sessionId, "seal", body);
    if (!z.strictObject({ sealed: z.literal(true) }).safeParse(value).success) {
      throw new Error("INVALID_OPENINSPECT_SEAL");
    }
  }

  private async api(sessionId: string, action: string, payload?: unknown): Promise<unknown> {
    id.parse(sessionId);
    const url = `${this.origin}/managed-reviews/${sessionId}/${action}`;
    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const method = body === undefined ? "GET" : "POST";
    try {
      const response = await this.request(url, {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: await buildOutboundAuthHeaders(
          { service: "review-controller", secret: this.secret },
          { method, url, body }
        ),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      // A one-MiB response can expand sixfold when escaped in its JSON envelope.
      const bytes = await readBodyCapped(response.body, 8 * 1024 * 1024);
      if (!bytes) throw new Error();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      // No remote response, URL, source content or credential in errors/logs.
      throw new Error("OPENINSPECT_REQUEST_FAILED");
    }
  }
}
