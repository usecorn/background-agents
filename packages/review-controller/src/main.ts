import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createInstallationTokenProvider } from "./github-app-token";
import { GitHubReviewClient } from "./github-client";
import { createGitHubOidcVerifier } from "./github-oidc";
import { createReviewHttpHandler } from "./http-handler";
import { PublicationReconciler } from "./publication-reconciler";
import { ReviewRunStore } from "./run-store";
import { startReviewServer } from "./server";

async function main() {
  const numericId = z.string().regex(/^[1-9][0-9]*$/);
  const digest = z.string().regex(/^[a-f0-9]{64}$/);
  const path = z.string().refine(isAbsolute);
  const env = z
    .object({
      REVIEW_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      REVIEW_REPOSITORY_ID: numericId,
      REVIEW_OWNER_ID: numericId,
      REVIEW_OIDC_AUDIENCE: z.url(),
      REVIEW_WORKFLOW_PATH: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/),
      REVIEW_POLICY_DIGEST: digest,
      REVIEW_MODEL_DIGEST: digest,
      REVIEW_APP_ID: numericId,
      REVIEW_INSTALLATION_ID: numericId,
      REVIEW_APP_KEY_FILE: path,
      REVIEW_DATABASE_PATH: path,
      REVIEW_PORT: z.coerce.number().int().min(1).max(65535).default(8788),
      REVIEW_HOSTNAME: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
      REVIEW_TIMEOUT_MS: z.coerce.number().int().min(1000).max(10800000).default(10800000),
    })
    .parse(process.env);
  const keyStat = statSync(env.REVIEW_APP_KEY_FILE);
  if (!keyStat.isFile() || (keyStat.mode & 0o077) !== 0) throw new Error("Private key permissions");
  const policy = {
    repository: env.REVIEW_REPOSITORY,
    repositoryId: env.REVIEW_REPOSITORY_ID,
    repositoryOwnerId: env.REVIEW_OWNER_ID,
    audience: env.REVIEW_OIDC_AUDIENCE,
    workflowPath: env.REVIEW_WORKFLOW_PATH,
    policyDigest: env.REVIEW_POLICY_DIGEST,
    modelDigest: env.REVIEW_MODEL_DIGEST,
  };
  const token = createInstallationTokenProvider({
    appId: env.REVIEW_APP_ID,
    installationId: env.REVIEW_INSTALLATION_ID,
    repositoryId: Number(env.REVIEW_REPOSITORY_ID),
    privateKey: readFileSync(env.REVIEW_APP_KEY_FILE, "utf8"),
  });
  const github = new GitHubReviewClient(policy.repository, token);
  const store = new ReviewRunStore(env.REVIEW_DATABASE_PATH);
  const reconciler = new PublicationReconciler(store, github, policy, env.REVIEW_APP_ID);
  const handler = createReviewHttpHandler({
    store,
    github,
    policy,
    verify: createGitHubOidcVerifier(policy),
    timeoutMs: env.REVIEW_TIMEOUT_MS,
  });
  const server = await startReviewServer(handler, () => reconciler.tick(), {
    hostname: env.REVIEW_HOSTNAME,
    port: env.REVIEW_PORT,
  });
  process.stdout.write("REVIEW_CONTROLLER_LISTENING\n");
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void server
      .close()
      .then(() => store.close())
      .catch(() => {
        process.stderr.write("REVIEW_CONTROLLER_SHUTDOWN_FAILED\n");
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
void main().catch(() => {
  process.stderr.write("REVIEW_CONTROLLER_START_FAILED\n");
  process.exitCode = 1;
});
