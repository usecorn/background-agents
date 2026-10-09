import { describe, expect, it } from "vitest";
import { serviceAllowsPermission } from "./service-permissions";

describe("serviceAllowsPermission", () => {
  it("does not grant the review controller ordinary session or secret authority", () => {
    for (const permission of [
      "sessions.create",
      "sessions.collaborate",
      "sessions.sandbox_access",
      "sessions.export",
      "global_secrets.manage",
    ] as const) {
      expect(serviceAllowsPermission("review-controller", permission)).toBe(false);
    }
  });
  it("allows launch capabilities but denies management capabilities", () => {
    expect(serviceAllowsPermission("slack-bot", "sessions.create")).toBe(true);
    expect(serviceAllowsPermission("linear-bot", "integrations.read")).toBe(true);
    expect(serviceAllowsPermission("slack-bot", "global_secrets.manage")).toBe(false);
    expect(serviceAllowsPermission("github-bot", "sessions.sandbox_access")).toBe(false);
  });

  it("does not grant bulk export to bot services", () => {
    for (const service of ["github-bot", "slack-bot", "linear-bot"] as const) {
      expect(serviceAllowsPermission(service, "sessions.export")).toBe(false);
    }
  });
});
