import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createInstallationTokenProvider } from "./github-app-token";

describe("App installation credentials", () => {
  it("signs App JWTs and requests only pilot repository permissions", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const now = Date.now();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token: "private-installation-token",
        expires_at: new Date(now + 3600000).toISOString(),
      })
    );
    const token = createInstallationTokenProvider(
      {
        appId: "123",
        installationId: "456",
        repositoryId: 789,
        privateKey: await exportPKCS8(privateKey),
      },
      request
    );
    expect(await token()).toBe("private-installation-token");
    expect(await token()).toBe("private-installation-token");
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.github.com/app/installations/456/access_tokens");
    const jwt = new Headers(init?.headers).get("authorization")!.slice(7);
    const verified = await jwtVerify(jwt, publicKey, { issuer: "123", algorithms: ["RS256"] });
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(600);
    expect(JSON.parse(String(init?.body))).toEqual({
      repository_ids: [789],
      permissions: { contents: "read", pull_requests: "read", checks: "write" },
    });
    expect(init?.redirect).toBe("error");
  });
  it("does not reveal provider response bodies on denial", async () => {
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    const token = createInstallationTokenProvider(
      {
        appId: "123",
        installationId: "456",
        repositoryId: 789,
        privateKey: await exportPKCS8(privateKey),
      },
      vi.fn<typeof fetch>().mockResolvedValue(new Response("secret", { status: 403 }))
    );
    await expect(token()).rejects.toThrow(/^GITHUB_APP_TOKEN_REJECTED$/);
  });
});
