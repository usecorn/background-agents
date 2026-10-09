import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { z } from "zod";

const ISSUER = "https://token.actions.githubusercontent.com";
const githubKeys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks`));
const numericId = z.string().regex(/^[1-9][0-9]*$/);

const claimsSchema = z.object({
  sub: z.string(),
  repository: z.string(),
  repository_id: numericId,
  repository_owner_id: numericId,
  event_name: z.literal("pull_request"),
  ref: z.string().regex(/^refs\/pull\/[1-9][0-9]*\/merge$/),
  workflow_ref: z.string(),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  base_ref: z.literal("main"),
  head_ref: z.string().min(1),
  run_id: numericId,
  run_attempt: numericId,
});

export interface GitHubOidcPolicy {
  audience: string;
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  workflowPath: string;
}

export interface GitHubReviewAdmission {
  repositoryId: string;
  pullRequest: number;
  /** GitHub's signed merge-ref SHA, to compare with freshly fetched PR metadata. */
  mergeSha: string;
  baseRef: "main";
  headRef: string;
  workflowRunId: string;
  workflowRunAttempt: number;
}

/** The policy and signing keys are server-owned; neither comes from a request. */
export function createGitHubOidcVerifier(
  policy: GitHubOidcPolicy,
  keys = githubKeys as JWTVerifyGetKey
) {
  return async (token: string, now = new Date()): Promise<GitHubReviewAdmission> => {
    try {
      if (Buffer.byteLength(token, "utf8") > 32 * 1024) throw new Error("Oversized token");
      const { payload } = await jwtVerify(token, keys, {
        issuer: ISSUER,
        audience: policy.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "nbf", "sub"],
        maxTokenAge: "10m",
        currentDate: now,
      });
      const claims = claimsSchema.parse(payload);
      if (
        claims.repository !== policy.repository ||
        claims.repository_id !== policy.repositoryId ||
        claims.repository_owner_id !== policy.repositoryOwnerId ||
        claims.sub !== `repo:${policy.repository}:pull_request` ||
        claims.workflow_ref !== `${policy.repository}/${policy.workflowPath}@${claims.ref}`
      ) {
        throw new Error("Disallowed identity");
      }
      const pullRequest = Number(claims.ref.split("/")[2]);
      const workflowRunAttempt = Number(claims.run_attempt);
      if (!Number.isSafeInteger(pullRequest) || !Number.isSafeInteger(workflowRunAttempt)) {
        throw new Error("Invalid run identity");
      }
      return {
        repositoryId: claims.repository_id,
        pullRequest,
        mergeSha: claims.sha,
        baseRef: claims.base_ref,
        headRef: claims.head_ref,
        workflowRunId: claims.run_id,
        workflowRunAttempt,
      };
    } catch {
      // Never reflect tokens or untrusted claim values into API errors or logs.
      throw new Error("GITHUB_REVIEW_IDENTITY_REJECTED");
    }
  };
}
