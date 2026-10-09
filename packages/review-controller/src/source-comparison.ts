import { createHash } from "node:crypto";
import { z } from "zod";
import type { ReviewManifestEntry } from "./review-result";
import type { ReviewSourceFile } from "./source-bundle";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const commit = z.object({ sha, tree: z.object({ sha }) });
const treeEntry = z.object({
  path: z.string().min(1).max(4096),
  mode: z.string(),
  size: z.number().int().nonnegative().optional(),
  type: z.string(),
  sha,
});
const tree = z.object({ sha, truncated: z.boolean(), tree: z.array(treeEntry).max(100_000) });
const blob = z.object({
  sha,
  encoding: z.literal("base64"),
  size: z.number().int().nonnegative(),
  content: z.string(),
});
type Entry = z.infer<typeof treeEntry>;
export interface ReviewSourceChange {
  path: string;
  status: "added" | "modified" | "deleted";
  basePath?: string;
  headPath?: string;
}

/** Immutable full tree comparison avoids GitHub's capped PR/compare file lists. */
export async function readSourceComparison(
  baseSha: string,
  headSha: string,
  api: (path: string) => Promise<unknown>
): Promise<{
  files: ReviewSourceFile[];
  manifest: ReviewManifestEntry[];
  changes: ReviewSourceChange[];
}> {
  sha.parse(baseSha);
  sha.parse(headSha);
  async function entries(revision: string): Promise<Map<string, Entry>> {
    const revisionData = commit.parse(await api(`/git/commits/${revision}`));
    if (revisionData.sha !== revision) throw new Error("SOURCE_REVISION_MISMATCH");
    const listing = tree.parse(await api(`/git/trees/${revisionData.tree.sha}?recursive=1`));
    if (listing.truncated || listing.sha !== revisionData.tree.sha)
      throw new Error("INCOMPLETE_SOURCE_TREE");
    const result = new Map<string, Entry>();
    const seen = new Set<string>();
    for (const entry of listing.tree) {
      if (
        seen.has(entry.path) ||
        /[\0\\]/.test(entry.path) ||
        Buffer.from(entry.path).toString("utf8") !== entry.path ||
        entry.path.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
      ) {
        throw new Error("INVALID_SOURCE_TREE_PATH");
      }
      seen.add(entry.path);
      if (entry.type !== "tree") result.set(entry.path, entry);
    }
    return result;
  }
  const [base, head] = await Promise.all([entries(baseSha), entries(headSha)]);
  const files: ReviewSourceFile[] = [],
    manifest: ReviewManifestEntry[] = [];
  const changes: ReviewSourceChange[] = [];
  let total = 0;
  async function materialize(side: "base" | "head", entry: Entry): Promise<string> {
    const path = `${side}/${entry.path}`;
    const scope = { path, reviewable: false };
    manifest.push(scope);
    if (manifest.length > 10_000) throw new Error("SOURCE_SCOPE_TOO_LARGE");
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) return path;
    if (entry.size === undefined || entry.size > 256 * 1024) return path;
    const payload = blob.parse(await api(`/git/blobs/${entry.sha}`));
    if (payload.sha !== entry.sha || payload.size !== entry.size)
      throw new Error("INVALID_SOURCE_BLOB");
    if (payload.size > 256 * 1024) return path;
    const encoded = payload.content.replace(/\n/g, "");
    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      bytes.length !== payload.size ||
      createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== entry.sha
    ) {
      throw new Error("INVALID_SOURCE_BLOB");
    }
    total += bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error("SOURCE_SCOPE_TOO_LARGE");
    const text = bytes.toString("utf8");
    if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return path;
    scope.reviewable = true;
    files.push({ path, text, sha256: createHash("sha256").update(bytes).digest("hex") });
    return path;
  }
  for (const path of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const before = base.get(path),
      after = head.get(path);
    if (before?.sha === after?.sha && before?.mode === after?.mode && before?.type === after?.type)
      continue;
    const change: ReviewSourceChange = {
      path,
      status: !before ? "added" : !after ? "deleted" : "modified",
    };
    if (before) change.basePath = await materialize("base", before);
    if (after) change.headPath = await materialize("head", after);
    changes.push(change);
  }
  return { files, manifest, changes };
}
