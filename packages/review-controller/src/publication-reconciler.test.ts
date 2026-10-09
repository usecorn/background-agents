import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRunStore } from "./run-store";
import { GitHubReviewClient } from "./github-client";
import { PublicationReconciler } from "./publication-reconciler";
const policy = {
  audience: "pilot",
  repository: "usecorn/pilot",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowPath: ".github/workflows/review.yml",
  policyDigest: "c".repeat(64),
  modelDigest: "d".repeat(64),
};
const binding = {
  repositoryId: "123",
  pullRequest: 7,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  policyDigest: policy.policyDigest,
  modelDigest: policy.modelDigest,
};
let directory: string;
let store: ReviewRunStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "publication-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function completed() {
  const run = store.start(binding, 1000, 10000).run;
  store.attachSession(run.id, "session-1");
  store.complete(run.id, "session-1", "CLEAN", "e".repeat(64), 1100);
  store.bindCheck(run.id, "789");
  return run.id;
}
function transport(mainSha = binding.baseSha) {
  const repo = { id: 123, full_name: policy.repository, owner: { id: 456 } };
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (init?.method === "PATCH") return Response.json({ id: 789 });
    if (String(url).endsWith("/commits/main")) return Response.json({ sha: mainSha });
    return Response.json({
      number: 7,
      state: "open",
      merged: false,
      merge_commit_sha: "f".repeat(40),
      base: { repo, ref: "main", sha: binding.baseSha },
      head: { repo, ref: "feature", sha: binding.headSha },
    });
  });
}
function reconciler(request: typeof fetch) {
  return new PublicationReconciler(
    store,
    new GitHubReviewClient(policy.repository, async () => "token", request),
    policy,
    "456"
  );
}
describe("publication reconciliation", () => {
  it("publishes CLEAN only after fresh metadata and persists acknowledgement", async () => {
    const id = completed();
    const request = transport();
    expect(await reconciler(request).tick(1200)).toEqual({
      published: [id],
      pending: [],
      failed: [],
    });
    const patch = request.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]?.body)).conclusion).toBe("success");
    expect(store.pendingPublication()).toEqual([]);
  });
  it("retries failed publication after restart without changing the sealed verdict", async () => {
    const id = completed();
    const request = transport();
    const normal = request.getMockImplementation()!;
    let failPublication = true;
    request.mockImplementation(async (url, init) => {
      if (init?.method === "PATCH" && failPublication) {
        failPublication = false;
        throw new Error("publication response lost");
      }
      return normal(url, init);
    });
    expect((await reconciler(request).tick(1200)).failed).toEqual([id]);
    store.close();
    store = new ReviewRunStore(join(directory, "runs.db"));
    expect((await reconciler(request).tick(1300)).published).toEqual([id]);
    expect(store.get(id)?.verdict).toBe("CLEAN");
  });
  it("cancels a sealed CLEAN result when main moved", async () => {
    const id = completed();
    const request = transport("f".repeat(40));
    await reconciler(request).tick(1200);
    const patch = request.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(patch[1]?.body)).conclusion).toBe("cancelled");
    expect(store.get(id)?.state).toBe("superseded");
  });
  it("reconciles cancellation for an earlier attempt", async () => {
    const id = completed();
    store.start({ ...binding, headSha: "e".repeat(40) }, 1200, 10000);
    const request = transport();
    await reconciler(request).tick(1300);
    const patch = request.mock.calls.find(
      ([url, init]) => String(url).endsWith("/check-runs/789") && init?.method === "PATCH"
    )!;
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch[1]?.body)).conclusion).toBe("cancelled");
    expect(store.get(id)?.publishedRevision).toBe(store.get(id)?.revision);
  });
});
