import { expect, it } from "vitest";
import { REVIEW_CATEGORIES } from "./review-result";
import { buildReviewPrompt, REVIEW_POLICY_DIGEST, REVIEW_MODEL_DIGEST } from "./review-policy";
const binding = {
  repositoryId: "123",
  pullRequest: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  policyDigest: REVIEW_POLICY_DIGEST,
  modelDigest: REVIEW_MODEL_DIGEST,
};
const scope = {
  manifest: [{ path: "head/a.py", reviewable: true }],
  changes: [{ path: "a.py", status: "added" as const, headPath: "head/a.py" }],
};
it("includes the bound revisions, six-class policy, schema and source map", () => {
  const prompt = buildReviewPrompt(binding, scope);
  expect(prompt).toContain(binding.headSha);
  expect(prompt).toContain("head/a.py");
  expect(prompt).toContain('"schemaVersion"');
  for (const category of REVIEW_CATEGORIES) expect(prompt).toContain(category);
  expect(REVIEW_POLICY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
});
it("refuses changed policy/model bindings before invoking the agent", () => {
  expect(() => buildReviewPrompt({ ...binding, policyDigest: "a".repeat(64) }, scope)).toThrow(
    "REVIEW_CONFIGURATION_MISMATCH"
  );
  expect(() => buildReviewPrompt({ ...binding, modelDigest: "b".repeat(64) }, scope)).toThrow(
    "REVIEW_CONFIGURATION_MISMATCH"
  );
});
it("refuses unreviewable scope and maps that omit source", () => {
  expect(() =>
    buildReviewPrompt(binding, { ...scope, manifest: [{ path: "head/a.py", reviewable: false }] })
  ).toThrow("UNREVIEWABLE_SCOPE");
  expect(() => buildReviewPrompt(binding, { ...scope, changes: [] })).toThrow(
    "INVALID_REVIEW_SCOPE"
  );
});
