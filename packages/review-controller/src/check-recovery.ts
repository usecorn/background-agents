import type { GitHubReviewClient } from "./github-client";
import type { ReviewRunStore } from "./run-store";

/**
 * Null means no publishable check yet. A prior ambiguous POST is looked up on
 * later ticks but never repeated for this attempt. Explicit rerun creates a new
 * attempt if a crash occurred after intent persistence but before sending POST.
 */
export async function ensureReviewCheck(
  store: ReviewRunStore,
  github: GitHubReviewClient,
  runId: string,
  appId: string
): Promise<string | null> {
  const run = store.get(runId);
  if (!run || !store.isCurrent(runId)) return null;
  if (run.checkId) return run.checkId;
  const existing = await github.findCheck(run.binding.headSha, runId, appId);
  if (!store.isCurrent(runId)) return null;
  if (existing) {
    if (!store.bindCheck(runId, existing)) throw new Error("REVIEW_CHECK_BINDING_CONFLICT");
    return existing;
  }
  if (!store.claimCheckCreation(runId)) return null;
  const checkId = await github.createCheck({ headSha: run.binding.headSha, runId });
  if (!store.bindCheck(runId, checkId)) throw new Error("REVIEW_CHECK_BINDING_CONFLICT");
  return store.isCurrent(runId) ? checkId : null;
}
