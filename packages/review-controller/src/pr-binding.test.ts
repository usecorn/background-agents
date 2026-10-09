import { describe, expect, it } from "vitest";
import { bindCurrentPullRequest, isReviewBindingCurrent } from "./pr-binding";

const sha = (character: string) => character.repeat(40);
const policy = {
  audience: "pilot",
  repository: "usecorn/pilot",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowPath: ".github/workflows/review.yml",
  policyDigest: "a".repeat(64),
  modelDigest: "b".repeat(64),
};
const admission = {
  repositoryId: "123",
  pullRequest: 7,
  mergeSha: sha("c"),
  baseRef: "main" as const,
  headRef: "feature",
  workflowRunId: "789",
  workflowRunAttempt: 1,
};
function metadata() {
  const repo = { id: 123, full_name: "usecorn/pilot", owner: { id: 456 } };
  return {
    number: 7,
    state: "open",
    merged: false,
    merge_commit_sha: sha("c"),
    base: { ref: "main", sha: sha("a"), repo },
    head: { ref: "feature", sha: sha("b"), repo },
  };
}

describe("bindCurrentPullRequest", () => {
  it("binds fetched base/head and server-owned policy, not merge SHA", () => {
    expect(bindCurrentPullRequest(policy, admission, metadata(), sha("a"))).toEqual({
      repositoryId: "123",
      pullRequest: 7,
      baseSha: sha("a"),
      headSha: sha("b"),
      policyDigest: policy.policyDigest,
      modelDigest: policy.modelDigest,
    });
  });
  it.each([
    [
      "different PR",
      (pr: ReturnType<typeof metadata>) => {
        pr.number = 8;
      },
    ],
    [
      "closed PR",
      (pr: ReturnType<typeof metadata>) => {
        pr.state = "closed";
      },
    ],
    [
      "merged PR",
      (pr: ReturnType<typeof metadata>) => {
        pr.merged = true;
      },
    ],
    [
      "outdated merge",
      (pr: ReturnType<typeof metadata>) => {
        pr.merge_commit_sha = sha("d");
      },
    ],
    [
      "other base",
      (pr: ReturnType<typeof metadata>) => {
        pr.base.ref = "dev";
      },
    ],
    [
      "other head",
      (pr: ReturnType<typeof metadata>) => {
        pr.head.ref = "other";
      },
    ],
    [
      "fork",
      (pr: ReturnType<typeof metadata>) => {
        pr.head.repo = { ...pr.head.repo, id: 999 };
      },
    ],
    [
      "renamed repo",
      (pr: ReturnType<typeof metadata>) => {
        pr.base.repo.full_name = "other/pilot";
      },
    ],
    [
      "transferred repo",
      (pr: ReturnType<typeof metadata>) => {
        pr.base.repo.owner.id = 999;
      },
    ],
  ] as const)("rejects %s", (_name, change) => {
    const pr = metadata();
    change(pr);
    expect(() => bindCurrentPullRequest(policy, admission, pr, sha("a"))).toThrow(
      "GITHUB_REVIEW_REVISION_REJECTED"
    );
  });
  it("rejects a base that moved since the PR metadata was read", () => {
    expect(() => bindCurrentPullRequest(policy, admission, metadata(), sha("d"))).toThrow(
      "GITHUB_REVIEW_REVISION_REJECTED"
    );
  });
  it.each([null, {}, { ...metadata(), merge_commit_sha: null }, { ...metadata(), head: null }])(
    "fails closed on incomplete GitHub metadata",
    (pr) => {
      expect(() => bindCurrentPullRequest(policy, admission, pr, sha("a"))).toThrow(
        "GITHUB_REVIEW_REVISION_REJECTED"
      );
    }
  );
});

describe("publication freshness", () => {
  it("requires current base/head and server policy", () => {
    const binding = bindCurrentPullRequest(policy, admission, metadata(), sha("a"));
    expect(isReviewBindingCurrent(policy, binding, metadata(), sha("a"))).toBe(true);
    expect(isReviewBindingCurrent(policy, binding, metadata(), sha("d"))).toBe(false);
    const changed = metadata();
    changed.head.sha = sha("d");
    expect(isReviewBindingCurrent(policy, binding, changed, sha("a"))).toBe(false);
    expect(
      isReviewBindingCurrent(
        { ...policy, policyDigest: "f".repeat(64) },
        binding,
        metadata(),
        sha("a")
      )
    ).toBe(false);
    expect(isReviewBindingCurrent(policy, binding, null, sha("a"))).toBe(false);
  });
});
