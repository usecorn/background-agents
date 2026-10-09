import { z } from "zod";
import type { GitHubOidcPolicy, GitHubReviewAdmission } from "./github-oidc";
import type { ReviewBinding } from "./run-store";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const repository = z.object({ id, full_name: z.string(), owner: z.object({ id }) });
const revision = z.object({ ref: z.string(), sha, repo: repository });
const pullRequest = z.object({
  number: id,
  state: z.literal("open"),
  merged: z.literal(false),
  merge_commit_sha: sha,
  base: revision,
  head: revision,
});

export interface ReviewAdmissionPolicy extends GitHubOidcPolicy {
  policyDigest: string;
  modelDigest: string;
}

/**
 * Call only with verified OIDC and metadata fetched by the controller from GitHub.
 * Read main's current SHA separately to reject a stale merge/base view. Publication
 * must fetch current base/head again; this admission snapshot is not a merge lock.
 */
export function bindCurrentPullRequest(
  policy: ReviewAdmissionPolicy,
  admission: GitHubReviewAdmission,
  githubMetadata: unknown,
  currentMainSha: string
): ReviewBinding {
  try {
    const pr = pullRequest.parse(githubMetadata);
    for (const repo of [pr.base.repo, pr.head.repo]) {
      if (
        String(repo.id) !== policy.repositoryId ||
        String(repo.owner.id) !== policy.repositoryOwnerId ||
        repo.full_name !== policy.repository
      )
        throw new Error("Repository mismatch");
    }
    if (
      admission.repositoryId !== policy.repositoryId ||
      pr.number !== admission.pullRequest ||
      pr.merge_commit_sha !== admission.mergeSha ||
      pr.base.ref !== "main" ||
      admission.baseRef !== "main" ||
      pr.head.ref !== admission.headRef ||
      pr.base.sha !== sha.parse(currentMainSha)
    )
      throw new Error("Revision mismatch");
    const digest = z.string().regex(/^[a-f0-9]{64}$/);
    return {
      repositoryId: policy.repositoryId,
      pullRequest: pr.number,
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      policyDigest: digest.parse(policy.policyDigest),
      modelDigest: digest.parse(policy.modelDigest),
    };
  } catch {
    throw new Error("GITHUB_REVIEW_REVISION_REJECTED");
  }
}
