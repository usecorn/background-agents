import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRunStore } from "./run-store";
import { GitHubReviewClient } from "./github-client";
import { ensureReviewCheck } from "./check-recovery";

let directory: string;
let store: ReviewRunStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "check-recovery-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const binding = {
  repositoryId: "123",
  pullRequest: 7,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  policyDigest: "c".repeat(64),
  modelDigest: "d".repeat(64),
};

describe("check creation recovery", () => {
  it("recovers an accepted POST after lost response and process restart", async () => {
    const run = store.start(binding, 1000, 2000).run;
    let posted = false;
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        posted = true;
        throw new Error("response lost after acceptance");
      }
      return Response.json({
        total_count: posted ? 1 : 0,
        check_runs: posted
          ? [
              {
                id: 789,
                name: "Malicious code review",
                head_sha: binding.headSha,
                external_id: run.id,
                app: { id: 456 },
              },
            ]
          : [],
      });
    });
    const client = new GitHubReviewClient("usecorn/pilot", async () => "test-token", request);
    await expect(ensureReviewCheck(store, client, run.id, "456")).rejects.toThrow();
    store.close();
    store = new ReviewRunStore(join(directory, "runs.db"));
    expect(await ensureReviewCheck(store, client, run.id, "456")).toBe("789");
    expect(store.get(run.id)?.checkId).toBe("789");
    expect(store.get(run.id)?.publishedRevision).toBe(0);
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(await ensureReviewCheck(store, client, run.id, "456")).toBe("789");
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("leaves an ambiguous missing check pending instead of repeating POST", async () => {
    const run = store.start(binding, 1000, 2000).run;
    store.claimCheckCreation(run.id);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ total_count: 0, check_runs: [] }));
    const client = new GitHubReviewClient("usecorn/pilot", async () => "test-token", request);
    expect(await ensureReviewCheck(store, client, run.id, "456")).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.method).toBe("GET");
    expect(store.get(run.id)?.checkId).toBeNull();
  });
  it("does no network work for a superseded attempt", async () => {
    const run = store.start(binding, 1000, 2000).run;
    store.start({ ...binding, headSha: "f".repeat(40) }, 1001, 2000);
    const request = vi.fn<typeof fetch>();
    const client = new GitHubReviewClient("usecorn/pilot", async () => "test-token", request);
    expect(await ensureReviewCheck(store, client, run.id, "456")).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
