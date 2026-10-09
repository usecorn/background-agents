# Malicious-code review policy v1

`policy.json` adapts the local `ce-malicious-code-detector` skill and its detection-pattern
catalog for automated read-only review. The provenance object records SHA-256 hashes of the
source files used. Interactive checkout/shell steps are replaced by bounded source tools.
Dependency-install and remote provenance claims are explicitly excluded. Pattern hits require
context and evidence; domain suffixes and unfamiliar names alone are not findings.

The controller's `review-policy.ts` combines the policy, prompt instructions and generated JSON
schema into `REVIEW_POLICY_DIGEST`. Changes to any of them invalidate an earlier binding. The
runtime validator remains authoritative: a prompt cannot grant a passing check.

The initial model configuration is Anthropic `claude-sonnet-4-6`, OpenCode `1.18.29`, and tool
profile version 1. `REVIEW_MODEL_DIGEST` identifies that configuration. The model name is a
provider catalog identifier, not a guarantee that provider-side weights never change. Live
model access and detection performance remain unverified.

Input paths use `base/` and `head/` namespaces. The change map links them to repository paths.
All readable changed versions must be covered. Unsupported files prevent automatic passing;
the controller refuses to launch this policy when its manifest contains unreviewable scope.
A follow-up investigation cannot mutate the original verdict.
