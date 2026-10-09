import { describe, expect, it } from "vitest";
import { evaluateReviewResult } from "./review-result";

const classes = [
  "exfiltration",
  "backdoor",
  "supply_chain",
  "obfuscation",
  "cryptomining",
  "hidden_functionality",
];
const clean = () => ({
  schemaVersion: 1,
  verdict: "CLEAN",
  findings: [],
  coverage: Object.fromEntries(classes.map((category) => [category, "clean"])),
  reviewedPaths: ["src/example.ts"],
  incompleteReasons: [],
});
const manifest = [{ path: "src/example.ts", reviewable: true }];
const evaluate = (result: unknown, scope = manifest) =>
  evaluateReviewResult(JSON.stringify(result), scope);

describe("automated review verdict", () => {
  it("passes only a schema-valid clean response covering the trusted manifest", () => {
    expect(evaluate(clean())).toMatchObject({ outcome: "clean", verdict: "CLEAN" });
  });

  it.each(["SUSPICIOUS", "MALICIOUS"])("blocks an evidenced %s finding", (verdict) => {
    const result = {
      ...clean(),
      verdict,
      coverage: { ...clean().coverage, exfiltration: "findings" },
      findings: [
        {
          category: "exfiltration",
          path: "src/example.ts",
          line: 4,
          evidence: "fixture: outbound transfer of credential material",
          explanation: "The unexpected request carries a secret outside the application.",
        },
      ],
    };
    expect(evaluate(result)).toMatchObject({ outcome: "finding", verdict });
    expect(evaluate({ ...result, verdict: "CLEAN" })).toMatchObject({ outcome: "incomplete" });
  });

  it.each([
    { reviewedPaths: [] },
    { reviewedPaths: ["src/example.ts", "unrequested.ts"] },
    { reviewedPaths: ["src/example.ts", "src/example.ts"] },
    { coverage: { exfiltration: "clean" } },
    { coverage: { ...clean().coverage, backdoor: "incomplete" } },
    { incompleteReasons: ["The tool could not read the changed file."] },
    { verdict: "SUSPICIOUS" },
    { coverage: { ...clean().coverage, backdoor: "findings" } },
    { schemaVersion: 2 },
    { extraAgentChosenPolicy: "allow-everything" },
  ])("refuses incomplete or contradictory output: %j", (patch) => {
    expect(evaluate({ ...clean(), ...patch })).toMatchObject({ outcome: "incomplete" });
  });

  it("does not let agent claims override unsupported source scope", () => {
    expect(evaluate(clean(), [{ path: "src/example.ts", reviewable: false }])).toMatchObject({
      outcome: "incomplete",
      reason: "UNREVIEWABLE_SCOPE",
    });
  });

  it.each(["", "CLEAN", "```json\n{}\n```", '{"verdict":', "null"])(
    "never passes malformed or prose-only output",
    (text) => {
      expect(evaluateReviewResult(text, manifest)).toMatchObject({ outcome: "incomplete" });
    }
  );

  it("bounds model response size before parsing", () => {
    expect(evaluateReviewResult(" ".repeat(1024 * 1024 + 1), manifest)).toMatchObject({
      outcome: "incomplete",
      reason: "RESULT_TOO_LARGE",
    });
  });
});
