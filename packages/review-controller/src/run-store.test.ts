import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewRunStore } from "./run-store";

const binding = {
  repositoryId: "1234",
  pullRequest: 17,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
  modelDigest: "d".repeat(64),
};
let directory: string;
let store: ReviewRunStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-runs-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("durable review run lifecycle", () => {
  it("deduplicates starts across restart without rerunning a model", () => {
    const first = store.start(binding, 1000, 2000);
    expect(first.created).toBe(true);
    store.close();
    store = new ReviewRunStore(join(directory, "runs.db"));
    const second = store.start(binding, 1100, 2000);
    expect(second).toEqual({ created: false, run: first.run });
  });

  it("binds completion to the recorded session and current attempt", () => {
    const { run } = store.start(binding, 1000, 2000);
    expect(store.attachSession(run.id, "session-1")).toBe(true);
    expect(store.attachSession(run.id, "another-session")).toBe(false);
    expect(store.complete(run.id, "another-session", "CLEAN", "e".repeat(64), 1100)).toBe(false);
    expect(store.complete(run.id, "session-1", "CLEAN", "e".repeat(64), 1100)).toBe(true);
    expect(store.complete(run.id, "session-1", "MALICIOUS", "f".repeat(64), 1200)).toBe(false);
    expect(store.get(run.id)).toMatchObject({ state: "completed", verdict: "CLEAN" });
  });

  it("supersedes earlier revisions and refuses their late completions", () => {
    const { run: old } = store.start(binding, 1000, 2000);
    store.attachSession(old.id, "session-old");
    const { run: current } = store.start({ ...binding, headSha: "f".repeat(40) }, 1100, 2000);
    expect(store.get(old.id)?.state).toBe("superseded");
    expect(store.complete(old.id, "session-old", "CLEAN", "e".repeat(64), 1200)).toBe(false);
    expect(store.isCurrent(old.id)).toBe(false);
    expect(store.isCurrent(current.id)).toBe(true);
  });

  it("creates a new attempt only on explicit rerun", () => {
    const first = store.start(binding, 1000, 2000).run;
    store.attachSession(first.id, "old-session");
    const second = store.start(binding, 1100, 2000, { rerun: true }).run;
    expect(second.id).not.toBe(first.id);
    expect(second.logicalKey).toBe(first.logicalKey);
    expect(store.get(first.id)?.state).toBe("superseded");
    expect(store.start(binding, 1200, 2000).run.id).toBe(second.id);
  });

  it("fails closed at the deadline and retains a fixed content expiry", () => {
    const run = store.start(binding, 1000, 2000).run;
    store.attachSession(run.id, "session-1");
    expect(store.complete(run.id, "session-1", "CLEAN", "e".repeat(64), 3000)).toBe(false);
    expect(store.expire(3000)).toEqual([run.id]);
    const completed = store.get(run.id)!;
    expect(completed).toMatchObject({ state: "incomplete", reason: "TIMEOUT", verdict: null });
    expect(completed.contentExpiresAt).toBe(3000 + 7 * 24 * 60 * 60 * 1000);
    expect(store.expire(4000)).toEqual([]);
    expect(store.get(run.id)?.contentExpiresAt).toBe(completed.contentExpiresAt);
  });

  it("persists publication state for retry after a restart", () => {
    const run = store.start(binding, 1000, 2000).run;
    store.attachSession(run.id, "session-1");
    store.complete(run.id, "session-1", "SUSPICIOUS", "e".repeat(64), 1100);
    expect(store.pendingPublication().map((row) => row.id)).toEqual([run.id]);
    store.markPublished(run.id, "5678", store.get(run.id)!.revision);
    store.close();
    store = new ReviewRunStore(join(directory, "runs.db"));
    expect(store.pendingPublication()).toEqual([]);
    expect(store.get(run.id)?.checkId).toBe("5678");
  });

  it("cannot mark a newer outcome published using an older pending response", () => {
    const run = store.start(binding, 1000, 2000).run;
    store.attachSession(run.id, "session-1");
    const runningRevision = store.get(run.id)!.revision;
    store.complete(run.id, "session-1", "MALICIOUS", "e".repeat(64), 1200);
    expect(store.markPublished(run.id, "5678", runningRevision)).toBe(false);
    expect(store.pendingPublication().map((row) => row.id)).toEqual([run.id]);
  });
});
