import { ensureReviewCheck } from "./check-recovery";
import type { GitHubReviewClient } from "./github-client";
import { isReviewBindingCurrent, type ReviewAdmissionPolicy } from "./pr-binding";
import type { ReviewRunStore } from "./run-store";

interface PublicationReceipt {
  published: string[];
  pending: string[];
  failed: string[];
}

/** One instance per controller process; ticks serialize and never invoke a model. */
export class PublicationReconciler {
  private active?: Promise<PublicationReceipt>;
  constructor(
    private readonly store: ReviewRunStore,
    private readonly github: GitHubReviewClient,
    private readonly policy: ReviewAdmissionPolicy,
    private readonly appId: string
  ) {}

  tick(now = Date.now()): Promise<PublicationReceipt> {
    this.active ??= this.reconcile(now).finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async reconcile(now: number): Promise<PublicationReceipt> {
    this.store.expire(now);
    const receipt: PublicationReceipt = { published: [], pending: [], failed: [] };
    for (const candidate of this.store.pendingPublication()) {
      try {
        const checkId = await ensureReviewCheck(this.store, this.github, candidate.id, this.appId);
        if (!checkId) {
          receipt.pending.push(candidate.id);
          continue;
        }
        let run = this.store.get(candidate.id)!;
        if (run.state !== "superseded") {
          const current = await this.github.readRevision(run.binding.pullRequest);
          run = this.store.get(candidate.id)!;
          if (
            !this.store.isCurrent(run.id) ||
            !isReviewBindingCurrent(this.policy, run.binding, current.metadata, current.mainSha)
          ) {
            this.store.supersede(run.id, now);
            run = this.store.get(run.id)!;
          }
        }
        await this.github.updateCheck(checkId, run);
        if (this.store.markPublished(run.id, checkId, run.revision)) receipt.published.push(run.id);
        else receipt.pending.push(run.id);
      } catch {
        // Retry metadata/publication later, retaining the sealed verdict. Never log payloads.
        receipt.failed.push(candidate.id);
      }
    }
    return receipt;
  }
}
