import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";

const configSchema = z.object({
  appId: z.string().regex(/^[1-9][0-9]*$/),
  installationId: z.string().regex(/^[1-9][0-9]*$/),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  privateKey: z.string().min(1),
});

/** The App key stays in the controller process, never in a sandbox environment. */
export function createInstallationTokenProvider(
  input: z.infer<typeof configSchema>,
  request: typeof fetch = fetch
): () => Promise<string> {
  const config = configSchema.parse(input);
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  async function issue(): Promise<string> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const key = await importPKCS8(config.privateKey, "RS256");
      const jwt = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(config.appId)
        .setIssuedAt(now - 30)
        .setExpirationTime(now + 540)
        .sign(key);
      const response = await request(
        `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
        {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: {
            authorization: `Bearer ${jwt}`,
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "corn-openinspect-review-controller",
          },
          body: JSON.stringify({
            repository_ids: [config.repositoryId],
            permissions: { contents: "read", pull_requests: "read", checks: "write" },
          }),
        }
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Denied");
      }
      const result = z
        .object({ token: z.string().min(1), expires_at: z.iso.datetime() })
        .parse(await response.json());
      const expiresAt = Date.parse(result.expires_at);
      if (expiresAt <= Date.now() + 60_000) throw new Error("Expired");
      cached = { token: result.token, expiresAt };
      return result.token;
    } catch {
      throw new Error("GITHUB_APP_TOKEN_REJECTED");
    }
  }
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!pending)
      pending = issue().finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
