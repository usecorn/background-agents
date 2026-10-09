import type { GitHubReviewClient } from "./github-client";
import type { createGitHubOidcVerifier, GitHubReviewAdmission } from "./github-oidc";
import { bindCurrentPullRequest, type ReviewAdmissionPolicy } from "./pr-binding";
import type { ReviewRun, ReviewRunStore } from "./run-store";

interface Dependencies {
  store: ReviewRunStore;
  github: GitHubReviewClient;
  verify: ReturnType<typeof createGitHubOidcVerifier>;
  policy: ReviewAdmissionPolicy;
  timeoutMs: number;
}
const reply = (status: number, value: unknown) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
function status(run: ReviewRun) {
  return {
    id: run.id,
    state: run.state,
    verdict: run.verdict,
    reason: run.reason,
    headSha: run.binding.headSha,
    baseSha: run.binding.baseSha,
    checkId: run.checkId,
    sessionId: run.sessionId,
  };
}

/** No route accepts prompts, models, SHAs, credentials or verdicts from Actions. */
export function createReviewHttpHandler(
  deps: Dependencies
): (request: Request) => Promise<Response> {
  if (!Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs <= 0) {
    throw new Error("Invalid review timeout");
  }
  return async (request) => {
    const url = new URL(request.url);
    const start = url.pathname === "/reviews" && request.method === "POST";
    const lookup = request.method === "GET" && /^\/reviews\/[a-f0-9-]{36}$/.test(url.pathname);
    if (!start && !lookup) return reply(404, { error: "NOT_FOUND" });
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return reply(401, { error: "IDENTITY_REQUIRED" });
    let admission: GitHubReviewAdmission;
    try {
      admission = await deps.verify(authorization.slice(7));
    } catch {
      return reply(401, { error: "IDENTITY_REJECTED" });
    }
    // These routes have no caller-selectable options. Reject rather than ignore them.
    let hasBody = false;
    if (request.body) {
      const reader = request.body.getReader();
      try {
        hasBody = !(await reader.read()).done;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    }
    if (url.search || hasBody) {
      return reply(400, { error: "REQUEST_OPTIONS_NOT_ALLOWED" });
    }
    try {
      if (lookup) {
        const run = deps.store.get(url.pathname.slice("/reviews/".length));
        if (
          !run ||
          run.binding.repositoryId !== admission.repositoryId ||
          run.binding.pullRequest !== admission.pullRequest
        )
          return reply(404, { error: "NOT_FOUND" });
        return reply(200, status(run));
      }
      const current = await deps.github.readRevision(admission.pullRequest);
      let binding;
      try {
        binding = bindCurrentPullRequest(deps.policy, admission, current.metadata, current.mainSha);
      } catch {
        return reply(409, { error: "REVISION_REJECTED" });
      }
      const { run } = deps.store.start(binding, Date.now(), deps.timeoutMs);
      return reply(202, status(run));
    } catch {
      return reply(503, { error: "REVIEW_SERVICE_UNAVAILABLE" });
    }
  };
}
