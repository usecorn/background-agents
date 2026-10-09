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
  it("recovers only the exact attempt owned by the configured App", async () => {
    const check = {
      id: 123,
      name: "Malicious code review",
      head_sha: "a".repeat(40),
      external_id: "run-7",
      app: { id: 456 },
    };
    const { client } = setup([
      json({
        total_count: 4,
        check_runs: [
          { ...check, id: 1, app: { id: 999 } },
          { ...check, id: 2, external_id: "old-run" },
          { ...check, id: 3, head_sha: "b".repeat(40) },
          check,
        ],
      }),
    ]);
    expect(await client.findCheck("a".repeat(40), "run-7", "456")).toBe("123");
  });
  it("searches past the first page, including older attempts", async () => {
    const unrelated = {
      id: 1,
      name: "CI",
      head_sha: "a".repeat(40),
      external_id: null,
      app: { id: 456 },
    };
    const { client, request } = setup([
      json({ total_count: 101, check_runs: Array.from({ length: 100 }, () => unrelated) }),
      json({
        total_count: 101,
        check_runs: [
          { ...unrelated, id: 123, name: "Malicious code review", external_id: "run-7" },
        ],
      }),
    ]);
    expect(await client.findCheck("a".repeat(40), "run-7", "456")).toBe("123");
    expect(String(request.mock.calls[1][0])).toContain("filter=all&per_page=100&page=2");
  });
  it("rejects duplicate check identities instead of guessing", async () => {
    const check = {
      id: 123,
      name: "Malicious code review",
      head_sha: "a".repeat(40),
      external_id: "run-7",
      app: { id: 456 },
    };
    const { client } = setup([
      json({ total_count: 2, check_runs: [check, { ...check, id: 124 }] }),
    ]);
    await expect(client.findCheck("a".repeat(40), "run-7", "456")).rejects.toThrow(
      "GITHUB_CHECK_IDENTITY_AMBIGUOUS"
    );
  });
  it("distinguishes confirmed absence from an incomplete page", async () => {
    const { client } = setup([
      json({ total_count: 0, check_runs: [] }),
      json({ total_count: 1, check_runs: [] }),
    ]);
    expect(await client.findCheck("a".repeat(40), "run-7", "456")).toBeNull();
    await expect(client.findCheck("a".repeat(40), "run-7", "456")).rejects.toThrow(
      "GITHUB_CHECK_LIST_INCOMPLETE"
    );
  });
});
