import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_SIGNATURE_HEADER,
  sha256Hex,
  verifyServiceSignature,
} from "@open-inspect/shared/service-auth";
import { ReviewRunStore } from "./run-store";
import { OpenInspectReviewClient, reviewMessageId } from "./openinspect-client";
import { ResultReconciler } from "./result-reconciler";
import { REVIEW_CATEGORIES } from "./review-result";

const binding = {
  repositoryId: "123",
  pullRequest: 7,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
  modelDigest: "d".repeat(64),
};
const secret = "synthetic-controller-service-secret";
const clean = JSON.stringify({
  schemaVersion: 1,
  verdict: "CLEAN",
  findings: [],
  coverage: Object.fromEntries(REVIEW_CATEGORIES.map((key) => [key, "clean"])),
  reviewedPaths: ["head/example.ts"],
  incompleteReasons: [],
});
let directory: string;
let store: ReviewRunStore;
let now: number;
let id: string;
let response: Record<string, unknown>;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
let source: ReturnType<
  typeof vi.fn<
    (
      baseSha: string,
      headSha: string
    ) => Promise<{ manifest: { path: string; reviewable: boolean }[] }>
  >
>;
let onSeal: () => void;
function reconciler() {
  return new ResultReconciler(
    store,
    new OpenInspectReviewClient("https://control.example", secret, request),
    { readSourceComparison: source },
    () => now
  );
}
function terminal(text = clean) {
  return {
    runId: id,
    messageId: reviewMessageId(id),
    state: "completed",
    sealed: false,
    responseDigest: createHash("sha256").update(text).digest("hex"),
    response: { assistantMessageId: "assistant-1", parentMessageId: "prompt-1", text },
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "result-reconcile-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
  now = 1200;
  id = store.start(binding, 1000, 2000).run.id;
  store.attachSession(id, "session-1");
  response = terminal();
  source = vi.fn().mockResolvedValue({ manifest: [{ path: "head/example.ts", reviewable: true }] });
  onSeal = () => {};
  request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(init?.redirect).toBe("error");
    const headers = new Headers(init?.headers);
    expect(headers.get("X-OpenInspect-Service")).toBe("review-controller");
    expect(
      await verifyServiceSignature({
        signatureHeader: headers.get(SERVICE_SIGNATURE_HEADER)!,
        service: "review-controller",
        secret,
        method: init!.method!,
        url: String(url),
        bodySha256Hex: await sha256Hex(String(init?.body ?? "")),
        actor: "",
      })
    ).toMatchObject({ ok: true });
    const parsed = new URL(String(url));
    expect(parsed.pathname).toMatch(/^\/managed-reviews\/session-1\/(result|seal)$/);
    if (init?.method === "POST") {
      expect(JSON.parse(String(init.body))).toEqual({
        runId: id,
        messageId: reviewMessageId(id),
        responseDigest: response.responseDigest,
      });
      expect(store.get(id)?.verdict).toBeNull();
      onSeal();
      return Response.json({ sealed: true });
    }
    expect(parsed.searchParams.get("runId")).toBe(id);
    expect(parsed.searchParams.get("messageId")).toBe(reviewMessageId(id));
    return Response.json(response);
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
describe("trusted terminal result reconciliation", () => {
  it("authenticates retrieval and seals exact evidence before persisting a verdict", async () => {
    expect(await reconciler().tick()).toEqual({ completed: [id], pending: [], failed: [] });
    expect(source).toHaveBeenCalledWith(binding.baseSha, binding.headSha);
    expect(store.get(id)).toMatchObject({
      state: "completed",
      verdict: "CLEAN",
      responseDigest: response.responseDigest,
    });
  });
  it("leaves a pending execution running without sealing or fetching source", async () => {
    response = {
      runId: id,
      messageId: reviewMessageId(id),
      state: "pending",
      responseDigest: null,
      sealed: false,
    };
    expect((await reconciler().tick()).pending).toEqual([id]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(source).not.toHaveBeenCalled();
    expect(store.get(id)?.state).toBe("running");
  });
  it.each(["runId", "messageId", "responseDigest"])("rejects a substituted %s", async (field) => {
    response[field] = field === "responseDigest" ? "e".repeat(64) : "another-attempt";
    expect((await reconciler().tick()).failed).toEqual([id]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.get(id)?.verdict).toBeNull();
  });
  it("records invalid JSON as incomplete only after sealing its actual digest", async () => {
    response = terminal("CLEAN");
    await reconciler().tick();
    expect(store.get(id)).toMatchObject({
      state: "incomplete",
      reason: "INVALID_RESULT",
      verdict: null,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("retains a valid malicious verdict as a finding", async () => {
    const value = JSON.parse(clean);
    value.verdict = "MALICIOUS";
    value.coverage.exfiltration = "findings";
    value.findings = [
      {
        category: "exfiltration",
        path: "head/example.ts",
        line: 1,
        evidence: "synthetic evidence",
        explanation: "synthetic finding",
      },
    ];
    response = terminal(JSON.stringify(value));
    await reconciler().tick();
    expect(store.get(id)).toMatchObject({ state: "completed", verdict: "MALICIOUS" });
  });
  it("does not accept a false seal acknowledgement", async () => {
    const normal = request.getMockImplementation()!;
    request.mockImplementation(async (url, init) =>
      init?.method === "POST" ? Response.json({ sealed: false }) : normal(url, init)
    );
    expect((await reconciler().tick()).failed).toEqual([id]);
    expect(store.get(id)?.verdict).toBeNull();
  });
  it("caps a streamed response even when no content-length is supplied", async () => {
    let cancelled = false;
    request.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        })
      )
    );
    expect((await reconciler().tick()).failed).toEqual([id]);
    expect(cancelled).toBe(true);
    expect(store.get(id)?.verdict).toBeNull();
  });
  it("cannot pass an omitted source version", async () => {
    source.mockResolvedValue({
      manifest: [
        { path: "head/example.ts", reviewable: true },
        { path: "base/example.ts", reviewable: true },
      ],
    });
    await reconciler().tick();
    expect(store.get(id)).toMatchObject({ state: "incomplete", reason: "INCOMPLETE_COVERAGE" });
  });
  it("seals failed terminal execution without treating it as a malicious finding", async () => {
    response = {
      runId: id,
      messageId: reviewMessageId(id),
      state: "incomplete",
      responseDigest: null,
      sealed: false,
    };
    await reconciler().tick();
    expect(store.get(id)).toMatchObject({
      state: "incomplete",
      reason: "EXECUTION_FAILED",
      verdict: null,
    });
    expect(source).not.toHaveBeenCalled();
  });
  it("recovers a lost seal acknowledgement after restart without recording an early success", async () => {
    onSeal = () => {
      throw new Error("response lost");
    };
    expect((await reconciler().tick()).failed).toEqual([id]);
    expect(store.get(id)?.state).toBe("running");
    store.close();
    store = new ReviewRunStore(join(directory, "runs.db"));
    response.sealed = true;
    onSeal = () => {};
    await reconciler().tick();
    expect(store.get(id)?.verdict).toBe("CLEAN");
  });
  it.each(["deadline", "supersession"])(
    "cannot complete when %s changes during sealing",
    async (race) => {
      onSeal = () => {
        if (race === "deadline") now = 3000;
        else store.start({ ...binding, headSha: "f".repeat(40) }, now, 2000);
      };
      await reconciler().tick();
      expect(store.get(id)?.verdict).toBeNull();
      expect(store.get(id)?.state).toBe(race === "deadline" ? "incomplete" : "superseded");
    }
  );
  it("does not re-evaluate a completed run or change its verdict", async () => {
    await reconciler().tick();
    request.mockClear();
    expect(await reconciler().tick()).toEqual({ completed: [], pending: [], failed: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
