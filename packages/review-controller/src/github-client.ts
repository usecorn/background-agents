import { z } from "zod";
import type { ReviewRun } from "./run-store";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const numericId = z.string().regex(/^[1-9][0-9]*$/);
const checkResponse = z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const REVIEW_CHECK_NAME = "Malicious code review";

/** Credentials are supplied by the controller's App installation token provider. */
export class GitHubReviewClient {
  private readonly repositoryPath: string;
  constructor(
    repository: string,
    private readonly installationToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch
  ) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new Error("Invalid pilot repository");
    }
    this.repositoryPath = `/repos/${repository}`;
  }

  async readRevision(pr: number): Promise<{ metadata: unknown; mainSha: string }> {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(pr);
    const metadata = await this.api(`/pulls/${pr}`);
    const main = z.object({ sha }).parse(await this.api("/commits/main"));
    return { metadata, mainSha: main.sha };
  }

  /** Recover a possibly accepted POST by its immutable attempt identity. */
  async findCheck(headSha: string, runId: string, appId: string): Promise<string | null> {
    sha.parse(headSha);
    numericId.parse(appId);
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .parse(runId);
    const pageSchema = z.object({
      total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      check_runs: z
        .array(
          checkResponse.extend({
            name: z.string(),
            head_sha: sha,
            external_id: z.string().nullable(),
            app: z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
          })
        )
        .max(100),
    });
    let found: string | null = null;
    let expectedTotal: number | undefined;
    let seen = 0;
    // Bound API work; hitting the bound is an error, never proof of absence.
    for (let page = 1; page <= 100; page++) {
      const result = pageSchema.parse(
        await this.api(`/commits/${headSha}/check-runs?filter=all&per_page=100&page=${page}`)
      );
      expectedTotal ??= result.total_count;
      if (result.total_count !== expectedTotal) throw new Error("GITHUB_CHECK_LIST_CHANGED");
      for (const check of result.check_runs) {
        if (
          check.name === REVIEW_CHECK_NAME &&
          check.head_sha === headSha &&
          check.external_id === runId &&
          String(check.app.id) === appId
        ) {
          if (found !== null) throw new Error("GITHUB_CHECK_IDENTITY_AMBIGUOUS");
          found = String(check.id);
        }
      }
      seen += result.check_runs.length;
      if (seen === expectedTotal) return found;
      if (seen > expectedTotal || result.check_runs.length < 100) {
        throw new Error("GITHUB_CHECK_LIST_INCOMPLETE");
      }
    }
    throw new Error("GITHUB_CHECK_LIST_INCOMPLETE");
  }

  async createCheck(input: { headSha: string; runId: string }): Promise<string> {
    sha.parse(input.headSha);
    z.string()
      .regex(/^[A-Za-z0-9_-]{1,128}$/)
      .parse(input.runId);
    const result = await this.api("/check-runs", "POST", {
      name: REVIEW_CHECK_NAME,
      head_sha: input.headSha,
      external_id: input.runId,
      status: "queued",
    });
    return String(checkResponse.parse(result).id);
  }

  /** Caller must verify current base/head immediately before publishing. */
  async updateCheck(checkId: string, outcome: Pick<ReviewRun, "state" | "verdict">): Promise<void> {
    numericId.parse(checkId);
    let body: Record<string, unknown>;
    if (outcome.state === "queued" || outcome.state === "running") {
      body = { status: outcome.state === "queued" ? "queued" : "in_progress" };
    } else {
      const clean = outcome.state === "completed" && outcome.verdict === "CLEAN";
      const finding =
        outcome.state === "completed" &&
        (outcome.verdict === "SUSPICIOUS" || outcome.verdict === "MALICIOUS");
      body = {
        status: "completed",
        conclusion: outcome.state === "superseded" ? "cancelled" : clean ? "success" : "failure",
        output: {
          title: `${REVIEW_CHECK_NAME}: ${clean || finding ? outcome.verdict : outcome.state}`,
          summary: clean
            ? "Automated review completed with no malicious code finding."
            : finding
              ? "Automated review found code requiring maintainer investigation."
              : "Automated review did not produce a current, complete passing result.",
        },
      };
    }
    checkResponse.parse(await this.api(`/check-runs/${checkId}`, "PATCH", body));
  }

  private async api(path: string, method = "GET", body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(`https://api.github.com${this.repositoryPath}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          authorization: `Bearer ${await this.installationToken()}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "content-type": "application/json",
          "user-agent": "corn-openinspect-review-controller",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("GITHUB_API_TRANSPORT_FAILED");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GITHUB_API_REQUEST_FAILED:${response.status}`);
    }
    // API errors and payloads are never reflected into controller logs.
    try {
      return await response.json();
    } catch {
      throw new Error("GITHUB_API_INVALID_RESPONSE");
    }
  }
}
