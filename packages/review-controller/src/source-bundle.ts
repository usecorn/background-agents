import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = "/tmp/openinspect-managed-review";
export interface ReviewSourceFile {
  path: string;
  text: string;
  sha256: string;
}

/** Build our own regular-file archive; never extract or forward a repository archive. */
export async function buildReviewSourceBundle(
  config: { sessionId: string; provider: "anthropic" | "openai"; model: string },
  files: readonly ReviewSourceFile[]
): Promise<Uint8Array> {
  if (
    !config.sessionId ||
    !config.model ||
    !["anthropic", "openai"].includes(config.provider) ||
    files.length > 10_000
  )
    throw new Error("INVALID_REVIEW_BUNDLE");
  const hashes: Record<string, string> = Object.create(null);
  const content = new Map<string, Buffer>();
  let total = 0;
  for (const file of files) {
    if (
      !file.path ||
      Buffer.from(file.path, "utf8").toString("utf8") !== file.path ||
      file.path.length > 4096 ||
      /[\0\\]/.test(file.path) ||
      file.path.split("/").some((part) => ["", ".", "..", ".git"].includes(part)) ||
      content.has(file.path) ||
      typeof file.text !== "string"
    )
      throw new Error("INVALID_REVIEW_SOURCE_PATH");
    const bytes = Buffer.from(file.text, "utf8");
    total += bytes.length;
    if (
      bytes.length > 256 * 1024 ||
      total > 8 * 1024 * 1024 ||
      bytes.includes(0) ||
      bytes.toString("utf8") !== file.text ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      throw new Error("INVALID_REVIEW_SOURCE_CONTENT");
    }
    content.set(file.path, bytes);
    hashes[file.path] = file.sha256;
  }
  const directory = await mkdtemp(join(tmpdir(), "openinspect-source-bundle-"));
  try {
    const upload = join(directory, "upload");
    await mkdir(join(upload, "checkout"), { recursive: true, mode: 0o700 });
    for (const [path, bytes] of content) {
      const destination = join(upload, "checkout", path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    const context = JSON.stringify({
      version: 1,
      session_id: config.sessionId,
      provider: config.provider,
      model: config.model,
      checkout: `${root}/checkout`,
      destination: `${root}/attempt`,
      state_root: `${root}/state`,
      hashes,
    });
    if (Buffer.byteLength(context) > 2 * 1024 * 1024) throw new Error("REVIEW_MANIFEST_TOO_LARGE");
    await writeFile(join(upload, "launch.json"), context, { flag: "wx", mode: 0o600 });
    const archive = join(directory, "bundle.tgz");
    // GNU tar is a host dependency. Only our private regular files are archived;
    // no repository code, hooks, package manager or shell is invoked.
    await execute(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archive,
        "-C",
        upload,
        ".",
      ],
      { timeout: 30_000, env: { PATH: "/usr/bin:/bin", LANG: "C" } }
    );
    const bundle = await readFile(archive);
    if (bundle.length > 16 * 1024 * 1024) throw new Error("REVIEW_BUNDLE_TOO_LARGE");
    return bundle;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
