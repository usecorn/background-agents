import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { readSourceComparison } from "./source-comparison";

const base = "a".repeat(40),
  head = "b".repeat(40);
const baseTree = "c".repeat(40),
  headTree = "d".repeat(40);
function blob(text: string) {
  const bytes = Buffer.from(text);
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return { sha, encoding: "base64", size: bytes.length, content: bytes.toString("base64") };
}
const before = blob("old\r\n"),
  after = blob("new\n");
function fixture(
  options: { truncated?: boolean; mode?: string; corrupt?: boolean; size?: number } = {}
) {
  const data: Record<string, unknown> = {
    [`/git/commits/${base}`]: { sha: base, tree: { sha: baseTree } },
    [`/git/commits/${head}`]: { sha: head, tree: { sha: headTree } },
    [`/git/trees/${baseTree}?recursive=1`]: {
      sha: baseTree,
      truncated: false,
      tree: [
        { path: "a.py", mode: "100644", type: "blob", sha: before.sha, size: before.size },
        { path: "deleted.py", mode: "100644", type: "blob", sha: before.sha, size: before.size },
      ],
    },
    [`/git/trees/${headTree}?recursive=1`]: {
      sha: headTree,
      truncated: !!options.truncated,
      tree: [
        {
          path: "a.py",
          mode: options.mode ?? "100644",
          type: "blob",
          sha: after.sha,
          size: options.size ?? after.size,
        },
      ],
    },
    [`/git/blobs/${before.sha}`]: before,
    [`/git/blobs/${after.sha}`]: options.corrupt ? { ...after, content: before.content } : after,
  };
  return vi.fn(async (path: string) => {
    if (!(path in data)) throw new Error("Unexpected URL");
    return data[path];
  });
}

it("binds changed and deleted source to exact trees and verified blob bytes", async () => {
  const result = await readSourceComparison(base, head, fixture());
  expect(result.files.map((f) => [f.path, f.text])).toEqual([
    ["base/a.py", "old\r\n"],
    ["head/a.py", "new\n"],
    ["base/deleted.py", "old\r\n"],
  ]);
  expect(result.manifest.every((entry) => entry.reviewable)).toBe(true);
  expect(result.changes).toEqual([
    { path: "a.py", status: "modified", basePath: "base/a.py", headPath: "head/a.py" },
    { path: "deleted.py", status: "deleted", basePath: "base/deleted.py" },
  ]);
});
it("refuses truncated tree coverage", async () => {
  await expect(readSourceComparison(base, head, fixture({ truncated: true }))).rejects.toThrow(
    "INCOMPLETE_SOURCE_TREE"
  );
});
it("refuses bytes inconsistent with the Git blob identifier", async () => {
  await expect(readSourceComparison(base, head, fixture({ corrupt: true }))).rejects.toThrow(
    "INVALID_SOURCE_BLOB"
  );
});
it("marks symlink changes unreviewable rather than following them", async () => {
  const result = await readSourceComparison(base, head, fixture({ mode: "120000" }));
  expect(result.manifest).toContainEqual({ path: "head/a.py", reviewable: false });
  expect(result.files.some((file) => file.path === "head/a.py")).toBe(false);
});

it("does not download oversized blobs and retains incomplete coverage", async () => {
  const api = fixture({ size: 256 * 1024 + 1 });
  const result = await readSourceComparison(base, head, api);
  expect(result.manifest).toContainEqual({ path: "head/a.py", reviewable: false });
  expect(api).not.toHaveBeenCalledWith(`/git/blobs/${after.sha}`);
});
