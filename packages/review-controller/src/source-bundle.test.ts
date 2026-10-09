import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildReviewSourceBundle } from "./source-bundle";

const text = "hello\r\n日本語\n";
const file = { path: "nested/a.py", text, sha256: createHash("sha256").update(text).digest("hex") };
const config = {
  sessionId: "session-1",
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
};

describe("controller-built source bundle", () => {
  it.skipIf(!process.env.REVIEW_RUNTIME_PYTHON)(
    "extracts as data and stages through the real Python launch loader",
    async () => {
      const bundle = await buildReviewSourceBundle(config, [file]);
      const directory = await mkdtemp(join(tmpdir(), "review-bundle-proof-"));
      try {
        const archive = join(directory, "input.tgz");
        await writeFile(archive, bundle);
        const python = process.env.REVIEW_RUNTIME_PYTHON!;
        const output = execFileSync(
          python,
          [
            "-c",
            `
import json, pathlib, sys, tarfile, os
from sandbox_runtime.review_launch import prepare_review_launch
from sandbox_runtime.runtime_config import RuntimeConfig
root = pathlib.Path(sys.argv[2]) / 'upload'
root.mkdir(mode=0o700)
with tarfile.open(sys.argv[1]) as tar:
    assert all(item.isfile() or item.isdir() for item in tar.getmembers())
    tar.extractall(root, filter='data')
context = root / 'launch.json'
data = json.loads(context.read_text())
for key, suffix in [('checkout','checkout'), ('destination','attempt'), ('state_root','state')]:
    assert data[key] == '/tmp/openinspect-managed-review/' + suffix
    data[key] = str(root / suffix)
context.write_text(json.dumps(data))
context.chmod(0o600)
config = RuntimeConfig.from_env({'SESSION_CONFIG': json.dumps({'session_id':'session-1', 'provider':'anthropic','model':'claude-sonnet-4-6'})})
profile = prepare_review_launch(context, config)
for directory, _, _ in os.walk(root):
    pathlib.Path(directory).chmod(0o700)
print(json.dumps({'text': (profile.source_root / 'nested/a.py').read_bytes().decode(), 'paths': json.loads(profile.manifest_path.read_text())}))
`,
            archive,
            directory,
          ],
          { encoding: "utf8" }
        );
        expect(JSON.parse(output)).toEqual({ text, paths: [file.path] });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  );

  it.each(["../escape", "/absolute", "a/../b", ".git/config", "a//b", "a\\b"])(
    "rejects unsafe path %s",
    async (path) => {
      await expect(buildReviewSourceBundle(config, [{ ...file, path }])).rejects.toThrow();
    }
  );
  it("rejects duplicate paths, digest mismatches and binary content", async () => {
    await expect(buildReviewSourceBundle(config, [file, file])).rejects.toThrow();
    await expect(
      buildReviewSourceBundle(config, [{ ...file, sha256: "a".repeat(64) }])
    ).rejects.toThrow();
    await expect(buildReviewSourceBundle(config, [{ ...file, text: "\0" }])).rejects.toThrow();
  });
});
