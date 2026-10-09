import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitHubReviewClient } from "./github-client";
import { ReviewRunStore } from "./run-store";
import { OpenInspectReviewClient } from "./openinspect-client";
import { ExecutionReconciler } from "./execution-reconciler";
import { REVIEW_MODEL_DIGEST, REVIEW_POLICY_DIGEST } from "./review-policy";

const policy = {
  repository: "fixture/test",
  repositoryId: "123",
  repositoryOwnerId: "456",
  audience: "https://review.example",
  workflowPath: ".github/workflows/review.yml",
  modelDigest: REVIEW_MODEL_DIGEST,
  policyDigest: REVIEW_POLICY_DIGEST,
};
const binding = {
  repositoryId: "123",
  pullRequest: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  modelDigest: REVIEW_MODEL_DIGEST,
  policyDigest: REVIEW_POLICY_DIGEST,
};
const repo = { id: 123, full_name: "fixture/test", owner: { id: 456 } };
const text = "export const safe = true;";
let directory: string, store: ReviewRunStore, now: number, runId: string;
let lostResponse: boolean, allocations: number;
let source: ReturnType<typeof vi.fn<GitHubReviewClient["readSourceComparison"]>>;
let revision: ReturnType<typeof vi.fn<GitHubReviewClient["readRevision"]>>;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
function make() {
  return new ExecutionReconciler(
    store,
    new OpenInspectReviewClient("https://control.example", "test-secret", request),
    { readSourceComparison: source, readRevision: revision },
    policy,
    () => now
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "execution-review-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
  now = 1000;
  runId = store.start(binding, now, 10000).run.id;
  lostResponse = false;
  allocations = 0;
  source = vi.fn().mockResolvedValue({
    files: [
      { path: "head/safe.ts", text, sha256: createHash("sha256").update(text).digest("hex") },
    ],
    manifest: [{ path: "head/safe.ts", reviewable: true }],
    changes: [{ path: "safe.ts", status: "added", headPath: "head/safe.ts" }],
  });
  revision = vi.fn().mockResolvedValue({
    metadata: {
      number: 1,
      state: "open",
      merged: false,
      merge_commit_sha: "c".repeat(40),
      base: { ref: "main", sha: binding.baseSha, repo },
      head: { ref: "feature", sha: binding.headSha, repo },
    },
    mainSha: binding.baseSha,
  });
  let claimed = false;
  request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.runId).toBe(runId);
    expect(init?.redirect).toBe("error");
    if (new URL(String(url)).pathname === "/managed-reviews") {
      expect(body.content).toContain(REVIEW_POLICY_DIGEST);
      return Response.json({ sessionId: `managed-review-${runId}`, status: "created" });
    }
    expect(String(url)).toBe(
      `https://control.example/managed-reviews/managed-review-${runId}/launch`
    );
    expect(store.get(runId)?.sessionId).toBe(`managed-review-${runId}`);
    expect(body.messageId).toBe(`review-${runId}`);
    expect(Buffer.from(body.bundleBase64, "base64").subarray(0, 2)).toEqual(Buffer.from([31, 139]));
    const launched = !claimed;
    if (launched) allocations++;
    claimed = true;
    if (lostResponse) {
      lostResponse = false;
      throw new Error("response lost");
    }
    return Response.json({ launched });
  });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
it("creates and launches a bound session, persisting acknowledgement across restart", async () => {
  await make().tick();
  expect(store.get(runId)?.state).toBe("running");
  expect(allocations).toBe(1);
  store.close();
  store = new ReviewRunStore(join(directory, "runs.db"));
  await make().tick();
  expect(source).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
});
it("retries an ambiguous launch using the same bound session", async () => {
  lostResponse = true;
  expect((await make().tick()).failed).toEqual([runId]);
  store.close();
  store = new ReviewRunStore(join(directory, "runs.db"));
  await make().tick();
  expect(allocations).toBe(1);
  expect(store.pendingExecution()).toEqual([]);
});
it("does not launch after the deadline expires during source acquisition", async () => {
  source.mockImplementation(async () => {
    now = 12000;
    return { files: [], manifest: [], changes: [] };
  });
  await make().tick();
  expect(allocations).toBe(0);
  expect(store.get(runId)?.reason).toBe("TIMEOUT");
});
it("does not launch when GitHub reports another revision", async () => {
  revision.mockResolvedValue({ metadata: {}, mainSha: binding.baseSha });
  await make().tick();
  expect(allocations).toBe(0);
  expect(store.get(runId)?.state).toBe("superseded");
});
it("marks unsupported source scope incomplete without allocating compute", async () => {
  source.mockResolvedValue({
    files: [],
    manifest: [{ path: "head/image", reviewable: false }],
    changes: [],
  });
  await make().tick();
  expect(allocations).toBe(0);
  expect(store.get(runId)?.reason).toBe("UNREVIEWABLE_SCOPE");
});

it("runs the local launch, terminal validation, seal and GitHub publication flow", async () => {
  const { ResultReconciler } = await import("./result-reconciler");
  const { PublicationReconciler } = await import("./publication-reconciler");
  const { GitHubReviewClient } = await import("./github-client");
  const { REVIEW_CATEGORIES } = await import("./review-result");
  const resultText = JSON.stringify({
    schemaVersion: 1,
    verdict: "CLEAN",
    findings: [],
    coverage: Object.fromEntries(REVIEW_CATEGORIES.map((category) => [category, "clean"])),
    reviewedPaths: ["head/safe.ts"],
    incompleteReasons: [],
  });
  const digest = createHash("sha256").update(resultText).digest("hex");
  let sealed = false;
  const original = request.getMockImplementation()!;
  request.mockImplementation(async (url, init) => {
    if (String(url).includes("/result?"))
      return Response.json({
        state: "completed",
        runId,
        messageId: `review-${runId}`,
        sealed,
        responseDigest: digest,
        response: { assistantMessageId: "assistant", parentMessageId: "prompt", text: resultText },
      });
    if (String(url).endsWith("/seal")) {
      expect(JSON.parse(String(init?.body)).responseDigest).toBe(digest);
      expect(store.get(runId)?.verdict).toBeNull();
      sealed = true;
      return Response.json({ sealed: true });
    }
    return original(url, init);
  });
  const published: unknown[] = [];
  const github = new GitHubReviewClient(
    policy.repository,
    async () => "synthetic-app-token",
    async (url, init) => {
      if (init?.method === "PATCH") {
        expect(sealed).toBe(true);
        published.push(JSON.parse(String(init.body)));
        return Response.json({ id: 789 });
      }
      if (init?.method === "POST") return Response.json({ id: 789 });
      if (String(url).includes("/check-runs?"))
        return Response.json({ total_count: 0, check_runs: [] });
      if (String(url).endsWith("/commits/main")) return Response.json({ sha: binding.baseSha });
      return Response.json((await revision(binding.pullRequest)).metadata);
    }
  );
  await make().tick();
  const client = new OpenInspectReviewClient("https://control.example", "test-secret", request);
  await new ResultReconciler(store, client, { readSourceComparison: source }, () => now).tick();
  await new PublicationReconciler(store, github, policy, "456").tick(now);
  expect(store.get(runId)).toMatchObject({
    state: "completed",
    verdict: "CLEAN",
    responseDigest: digest,
  });
  expect(published).toEqual([
    expect.objectContaining({ conclusion: "success", status: "completed" }),
  ]);
  expect(store.pendingPublication()).toEqual([]);
  expect(allocations).toBe(1);
});

it("does not retroactively launch running attempts when migrating the pre-scheduler database", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  store.attachSession(runId, "legacy-session");
  store.close();
  const db = new DatabaseSync(join(directory, "runs.db"));
  db.exec("DROP TABLE execution_launches; PRAGMA user_version=2");
  db.close();
  store = new ReviewRunStore(join(directory, "runs.db"));
  await make().tick();
  expect(source).not.toHaveBeenCalled();
  expect(allocations).toBe(0);
  expect(store.get(runId)?.state).toBe("running");
});
