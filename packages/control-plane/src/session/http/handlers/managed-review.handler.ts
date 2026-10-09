import { z } from "zod";
import { sandboxEventSchema } from "@open-inspect/shared/types/sandbox-events";
import type { SqlStorage } from "../../sql-storage";
import type { ManagedReviewStore } from "../../managed-review";
const identity = z.object({
  runId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const sealInput = identity
  .extend({
    responseDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
  })
  .strict();

/** Internal session boundary. Only the controller-only external route may dispatch here. */
export class ManagedReviewHandler {
  constructor(
    private readonly sql: SqlStorage,
    private readonly store: ManagedReviewStore
  ) {}

  private async read(runId: string, messageId: string) {
    if (!this.store.matches(runId, messageId)) return null;
    const messages = this.sql.exec("SELECT status FROM messages WHERE id=?", messageId).toArray();
    const message = z.object({ status: z.string() }).safeParse(messages[0]);
    if (messages.length !== 1 || !message.success)
      return { state: "incomplete" as const, responseDigest: null };
    if (["pending", "processing"].includes(message.data.status))
      return { state: "pending" as const, responseDigest: null };
    if (message.data.status !== "completed")
      return { state: "incomplete" as const, responseDigest: null };
    const events = this.sql
      .exec(
        "SELECT data FROM events WHERE message_id=? AND type='execution_complete' LIMIT 2",
        messageId
      )
      .toArray();
    try {
      if (events.length !== 1) throw new Error();
      const row = z.object({ data: z.string().max(2 * 1024 * 1024) }).parse(events[0]);
      const event = sandboxEventSchema.parse(JSON.parse(row.data));
      if (
        event.type !== "execution_complete" ||
        !event.success ||
        event.error !== undefined ||
        event.messageId !== messageId ||
        !event.finalResponse
      )
        throw new Error();
      const bytes = new TextEncoder().encode(event.finalResponse.text);
      if (bytes.length > 1024 * 1024) throw new Error();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const responseDigest = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return { state: "completed" as const, responseDigest, response: event.finalResponse };
    } catch {
      return { state: "incomplete" as const, responseDigest: null };
    }
  }

  async result(url: URL): Promise<Response> {
    const input = identity.safeParse(Object.fromEntries(url.searchParams));
    if (!input.success) return Response.json({ error: "INVALID_REVIEW_IDENTITY" }, { status: 400 });
    const result = await this.read(input.data.runId, input.data.messageId);
    if (!result) return Response.json({ error: "REVIEW_NOT_FOUND" }, { status: 404 });
    return Response.json({ ...input.data, ...result, sealed: !this.store.isLocked() });
  }

  async seal(request: Request): Promise<Response> {
    let input;
    try {
      input = sealInput.parse(await request.json());
    } catch {
      return Response.json({ error: "INVALID_REVIEW_SEAL" }, { status: 400 });
    }
    const result = await this.read(input.runId, input.messageId);
    if (!result) return Response.json({ error: "REVIEW_NOT_FOUND" }, { status: 404 });
    if (result.state === "pending" || result.responseDigest !== input.responseDigest) {
      return Response.json({ error: "REVIEW_SEAL_CONFLICT" }, { status: 409 });
    }
    const terminal = this.sql
      .exec("SELECT status FROM messages WHERE id=?", input.messageId)
      .toArray();
    if (
      terminal.length !== 1 ||
      !z.object({ status: z.enum(["completed", "failed"]) }).safeParse(terminal[0]).success
    ) {
      return Response.json({ error: "REVIEW_SEAL_CONFLICT" }, { status: 409 });
    }
    // MessageRepository accepts completion only from pending/processing, so the
    // terminal response is immutable. No verdict is accepted in this request.
    if (!this.store.seal(input.runId, input.messageId))
      return Response.json({ error: "REVIEW_SEAL_CONFLICT" }, { status: 409 });
    return Response.json({ sealed: true });
  }
}
