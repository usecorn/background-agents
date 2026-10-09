import type { OpenInspectReviewClient } from "./openinspect-client";
import type { GitHubReviewClient } from "./github-client";
import { isReviewBindingCurrent, type ReviewAdmissionPolicy } from "./pr-binding";
import { buildReviewPrompt, REVIEW_MODEL } from "./review-policy";
import { buildReviewSourceBundle } from "./source-bundle";
import type { ReviewRunStore } from "./run-store";

interface ExecutionReceipt {
  launched: string[];
  failed: string[];
}

/** Controller restarts retry the same session; the control plane owns allocation deduplication. */
export class ExecutionReconciler {
  private active?: Promise<ExecutionReceipt>;
  constructor(
    private readonly store: ReviewRunStore,
    private readonly openinspect: OpenInspectReviewClient,
    private readonly github: Pick<GitHubReviewClient, "readSourceComparison" | "readRevision">,
    private readonly policy: ReviewAdmissionPolicy,
    private readonly now: () => number = Date.now
  ) {}

  tick(): Promise<ExecutionReceipt> {
    this.active ??= this.reconcile().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async reconcile(): Promise<ExecutionReceipt> {
    this.store.expire(this.now());
    const receipt: ExecutionReceipt = { launched: [], failed: [] };
    for (const run of this.store.pendingExecution()) {
      try {
        const source = await this.github.readSourceComparison(
          run.binding.baseSha,
          run.binding.headSha
        );
        if (source.manifest.some((entry) => !entry.reviewable)) {
          this.store.fail(run.id, "UNREVIEWABLE_SCOPE", this.now());
          continue;
        }
        const content = buildReviewPrompt(run.binding, source);
        const sessionId = `managed-review-${run.id}`;
        const bundle = await buildReviewSourceBundle({ sessionId, ...REVIEW_MODEL }, source.files);
        this.store.expire(this.now());
        if (!this.store.pendingExecution().some((candidate) => candidate.id === run.id)) continue;
        await this.openinspect.create(run.id, content);
        const revision = await this.github.readRevision(run.binding.pullRequest);
        if (
          !isReviewBindingCurrent(this.policy, run.binding, revision.metadata, revision.mainSha)
        ) {
          this.store.supersede(run.id, this.now());
          continue;
        }
        this.store.expire(this.now());
        // Persist session identity before any ambiguous paid allocation request.
        if (!this.store.attachSession(run.id, sessionId)) continue;
        await this.openinspect.launch(sessionId, run.id, bundle);
        this.store.acknowledgeLaunch(run.id, sessionId);
        receipt.launched.push(run.id);
      } catch {
        // Retry immutable source/creation/launch until deadline. Never expose source or secrets.
        receipt.failed.push(run.id);
      }
    }
    return receipt;
  }
}
