import { describe, expect, it, vi } from "vitest";
import { GitHubReviewClient } from "./github-client";

function setup(responses: Response[]) {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  });
  const client = new GitHubReviewClient("usecorn/pilot", async () => "installation-token", request);
  return { client, request };
}
const json = (value: unknown) => Response.json(value);
describe("GitHubReviewClient", () => {
  it("fetches the PR and current main from the configured repository", async () => {
    const { client, request } = setup([json({ number: 7 }), json({ sha: "a".repeat(40) })]);
    expect(await client.readRevision(7)).toEqual({
      metadata: { number: 7 },
      mainSha: "a".repeat(40),
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/usecorn/pilot/pulls/7",
      "https://api.github.com/repos/usecorn/pilot/commits/main",
    ]);
    const options = request.mock.calls[0][1]!;
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer installation-token");
    expect(options.redirect).toBe("error");
  });
  it("creates an exact-head check with stable attempt identity", async () => {
    const { client, request } = setup([json({ id: 123 })]);
    expect(await client.createCheck({ headSha: "b".repeat(40), runId: "run-7" })).toBe("123");
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      name: "Malicious code review",
      head_sha: "b".repeat(40),
      external_id: "run-7",
      status: "queued",
    });
  });
  it("writes a completed finding as failure without copying model text", async () => {
    const { client, request } = setup([json({ id: 123 })]);
    await client.updateCheck("123", { state: "completed", verdict: "MALICIOUS" });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toEqual({
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Malicious code review: MALICIOUS",
        summary: "Automated review found code requiring maintainer investigation.",
      },
    });
  });
  it.each([
    [{ state: "completed", verdict: "CLEAN" }, "success"],
    [{ state: "completed", verdict: "SUSPICIOUS" }, "failure"],
    [{ state: "incomplete", verdict: null }, "failure"],
    [{ state: "superseded", verdict: "CLEAN" }, "cancelled"],
  ] as const)("maps a sealed outcome to %s", async (outcome, conclusion) => {
    const { client, request } = setup([json({ id: 123 })]);
    await client.updateCheck("123", outcome);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).conclusion).toBe(conclusion);
  });
  it("does not pass a completed record missing its verdict", async () => {
    const { client, request } = setup([json({ id: 123 })]);
    await client.updateCheck("123", { state: "completed", verdict: null });
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).conclusion).toBe("failure");
  });
  it("does not retry ambiguous writes or expose response secrets", async () => {
    const { client, request } = setup([new Response("sensitive body", { status: 503 })]);
    await expect(client.createCheck({ headSha: "a".repeat(40), runId: "run-7" })).rejects.toThrow(
      /^GITHUB_API_REQUEST_FAILED:503$/
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("rejects unsafe identifiers before fetching", async () => {
    const { client, request } = setup([]);
    await expect(client.readRevision(-1)).rejects.toThrow();
    await expect(
      client.updateCheck("../other", { state: "running", verdict: null })
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
