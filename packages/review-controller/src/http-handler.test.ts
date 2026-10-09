import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRunStore } from "./run-store";
import { GitHubReviewClient } from "./github-client";
import { createGitHubOidcVerifier } from "./github-oidc";
import { createReviewHttpHandler } from "./http-handler";
import { startReviewServer } from "./server";
const policy = {
  audience: "pilot",
  repository: "usecorn/pilot",
  repositoryId: "123",
  repositoryOwnerId: "456",
  workflowPath: ".github/workflows/review.yml",
  policyDigest: "c".repeat(64),
  modelDigest: "d".repeat(64),
};
let directory: string;
let store: ReviewRunStore;
let key: CryptoKey;
let verify: ReturnType<typeof createGitHubOidcVerifier>;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  verify = createGitHubOidcVerifier(
    policy,
    createLocalJWKSet({ keys: [await exportJWK(pair.publicKey)] })
  );
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "review-http-"));
  store = new ReviewRunStore(join(directory, "runs.db"));
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
async function token(pr = 7) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    repository: policy.repository,
    repository_id: "123",
    repository_owner_id: "456",
    event_name: "pull_request",
    ref: `refs/pull/${pr}/merge`,
    workflow_ref: `${policy.repository}/${policy.workflowPath}@refs/pull/${pr}/merge`,
    sha: "f".repeat(40),
    base_ref: "main",
    head_ref: "feature",
    run_id: "99",
    run_attempt: "1",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer("https://token.actions.githubusercontent.com")
    .setAudience("pilot")
    .setSubject(`repo:${policy.repository}:pull_request`)
    .setIssuedAt(now)
    .setNotBefore(now - 1)
    .setExpirationTime(now + 300)
    .sign(key);
}
function setup() {
  const repo = { id: 123, full_name: policy.repository, owner: { id: 456 } };
  const request = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    Response.json(
      String(url).endsWith("/commits/main")
        ? { sha: "a".repeat(40) }
        : {
            number: 7,
            state: "open",
            merged: false,
            merge_commit_sha: "f".repeat(40),
            base: { repo, ref: "main", sha: "a".repeat(40) },
            head: { repo, ref: "feature", sha: "b".repeat(40) },
          }
    )
  );
  const handle = createReviewHttpHandler({
    store,
    github: new GitHubReviewClient(policy.repository, async () => "installation-token", request),
    verify,
    policy,
    timeoutMs: 60000,
  });
  return { handle, request };
}
async function startRequest(body?: string) {
  return new Request("https://pilot.invalid/reviews", {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}` },
    body,
  });
}
describe("review HTTP admission", () => {
  it("binds a signed Actions request and deduplicates retries", async () => {
    const { handle } = setup();
    const first = await handle(await startRequest());
    expect(first.status).toBe(202);
    const result = await first.json();
    expect(result).toMatchObject({ state: "queued", verdict: null });
    const second = await handle(await startRequest());
    expect((await second.json()).id).toBe(result.id);
    expect(store.get(result.id)?.binding.headSha).toBe("b".repeat(40));
  });
  it("rejects missing identity before contacting GitHub", async () => {
    const { handle, request } = setup();
    expect(
      (await handle(new Request("https://pilot.invalid/reviews", { method: "POST" }))).status
    ).toBe(401);
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects caller-supplied model or verdict", async () => {
    const { handle, request } = setup();
    expect(
      (await handle(await startRequest('{"verdict":"CLEAN","model":"attacker"}'))).status
    ).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });
  it("scopes status reads to the signed PR", async () => {
    const { handle } = setup();
    const run = await (await handle(await startRequest())).json();
    const own = await handle(
      new Request(`https://pilot.invalid/reviews/${run.id}`, {
        headers: { authorization: `Bearer ${await token()}` },
      })
    );
    expect(own.status).toBe(200);
    const other = await handle(
      new Request(`https://pilot.invalid/reviews/${run.id}`, {
        headers: { authorization: `Bearer ${await token(8)}` },
      })
    );
    expect(other.status).toBe(404);
  });
  it("returns a static error when GitHub is unavailable", async () => {
    const { handle, request } = setup();
    request.mockRejectedValue(new Error("secret provider details"));
    const response = await handle(await startRequest());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret");
    expect(store.pendingPublication()).toEqual([]);
  });
});

describe("real HTTP listener", () => {
  it("accepts an empty signed POST and rejects injected options over TCP", async () => {
    const { handle } = setup();
    const tick = vi.fn().mockResolvedValue(undefined);
    const server = await startReviewServer(handle, tick, { port: 0, hostname: "127.0.0.1" });
    try {
      const headers = { authorization: `Bearer ${await token()}` };
      const response = await fetch(`${server.url}/reviews`, { method: "POST", headers });
      expect(response.status).toBe(202);
      const run = await response.json();
      expect(store.get(run.id)?.state).toBe("queued");
      const invalid = await fetch(`${server.url}/reviews`, {
        method: "POST",
        headers,
        body: '{"verdict":"CLEAN"}',
      });
      expect(invalid.status).toBe(400);
      expect((await fetch(`${server.url}/healthz`)).status).toBe(200);
    } finally {
      await server.close();
    }
    expect(tick).toHaveBeenCalled();
  });
});
