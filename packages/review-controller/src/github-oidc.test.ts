import { beforeAll, describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createGitHubOidcVerifier } from "./github-oidc";

const issuer = "https://token.actions.githubusercontent.com";
const audience = "https://pilot.invalid/review-controller";
const now = new Date("2026-10-09T12:00:00Z");
const seconds = Math.floor(now.getTime() / 1000);
let privateKey: CryptoKey;
let verify: ReturnType<typeof createGitHubOidcVerifier>;

const claims = () => ({
  iss: issuer,
  aud: audience,
  sub: "repo:usecorn/openinspect-pilot-tests:pull_request",
  iat: seconds,
  nbf: seconds - 1,
  exp: seconds + 300,
  repository: "usecorn/openinspect-pilot-tests",
  repository_id: "1234",
  repository_owner_id: "5678",
  event_name: "pull_request",
  ref: "refs/pull/17/merge",
  workflow_ref:
    "usecorn/openinspect-pilot-tests/.github/workflows/malicious-review.yml@refs/pull/17/merge",
  sha: "a".repeat(40),
  base_ref: "main",
  head_ref: "fixture/clean",
  run_id: "9876",
  run_attempt: "1",
});

async function token(patch: Record<string, unknown> = {}) {
  return new SignJWT({ ...claims(), ...patch })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .sign(privateKey);
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  verify = createGitHubOidcVerifier(
    {
      audience,
      repository: "usecorn/openinspect-pilot-tests",
      repositoryId: "1234",
      repositoryOwnerId: "5678",
      workflowPath: ".github/workflows/malicious-review.yml",
    },
    createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256" }] })
  );
});

describe("GitHub OIDC review admission", () => {
  it("derives the PR and workflow run from a signed, allowed identity", async () => {
    await expect(verify(await token(), now)).resolves.toEqual({
      repositoryId: "1234",
      pullRequest: 17,
      mergeSha: "a".repeat(40),
      baseRef: "main",
      headRef: "fixture/clean",
      workflowRunId: "9876",
      workflowRunAttempt: 1,
    });
  });

  it.each([
    { iss: "https://attacker.invalid" },
    { aud: "another-service" },
    { repository_id: "9999" },
    { repository_owner_id: "9999" },
    { repository: "attacker/openinspect-pilot-tests" },
    { event_name: "pull_request_target" },
    { event_name: "push" },
    { sub: "repo:usecorn/openinspect-pilot-tests:environment:pilot" },
    { ref: "refs/heads/main" },
    {
      workflow_ref: "usecorn/openinspect-pilot-tests/.github/workflows/evil.yml@refs/pull/17/merge",
    },
    {
      workflow_ref:
        "usecorn/openinspect-pilot-tests/.github/workflows/malicious-review.yml@refs/pull/18/merge",
    },
    { base_ref: "dev" },
    { sha: "not-a-sha" },
    { exp: seconds - 1 },
    { nbf: seconds + 60 },
    { iat: seconds - 601 },
    { exp: undefined },
    { run_attempt: "0" },
  ])("rejects a disallowed or expired signed claim: %j", async (patch) => {
    await expect(verify(await token(patch), now)).rejects.toThrow();
  });

  it("rejects a payload changed without the signing key", async () => {
    const parts = (await token()).split(".");
    parts[1] = Buffer.from(JSON.stringify({ ...claims(), repository_id: "9999" })).toString(
      "base64url"
    );
    await expect(verify(parts.join("."), now)).rejects.toThrow();
  });
});
