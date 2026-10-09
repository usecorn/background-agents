import type { OpenInspectReviewClient } from "./openinspect-client";
import { evaluateReviewResult, type ReviewManifestEntry } from "./review-result";
import type { ReviewRunStore } from "./run-store";

interface ResultReceipt {
  completed: string[];
  pending: string[];
  failed: string[];
}
interface SourceReader {
  readSourceComparison(
    baseSha: string,
    headSha: string
  ): Promise<{ manifest: ReviewManifestEntry[] }>;
}

/** Reads existing executions only. An ambiguous seal never launches another model turn. */
export class ResultReconciler {
  private active?: Promise<ResultReceipt>;
  constructor(
    private readonly store: ReviewRunStore,
    private readonly openinspect: OpenInspectReviewClient,
    private readonly source: SourceReader,
    private readonly now: () => number = Date.now
  ) {}

  tick(): Promise<ResultReceipt> {
    this.active ??= this.reconcile().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }

  private async reconcile(): Promise<ResultReceipt> {
    this.store.expire(this.now());
    const receipt: ResultReceipt = { completed: [], pending: [], failed: [] };
    for (const run of this.store.running()) {
      try {
        const result = await this.openinspect.result(run.sessionId!, run.id);
        if (result.state === "pending") {
          receipt.pending.push(run.id);
          continue;
        }
        // Reconstruct trusted coverage from immutable commits, never agent-supplied paths.
        const evaluation =
          result.state === "completed"
            ? evaluateReviewResult(
                result.response.text,
                (await this.source.readSourceComparison(run.binding.baseSha, run.binding.headSha))
                  .manifest
              )
            : { outcome: "incomplete" as const, reason: "EXECUTION_FAILED" as const };
        await this.openinspect.seal(run.sessionId!, run.id, result.responseDigest);
        // Network calls can cross a deadline or concurrent supersession. The store
        // checks current attempt/session/state again before accepting completion.
        const now = this.now();
        this.store.expire(now);
        const changed =
          evaluation.outcome === "incomplete"
            ? this.store.fail(run.id, evaluation.reason, now)
            : this.store.complete(
                run.id,
                run.sessionId!,
                evaluation.verdict,
                result.responseDigest!,
                now
              );
        if (changed) receipt.completed.push(run.id);
      } catch {
        // Preserve the attempt for retry (including after a lost seal acknowledgement).
        // Deadline expiry supplies the final non-passing outcome if recovery never succeeds.
        receipt.failed.push(run.id);
      }
    }
    return receipt;
  }
}
