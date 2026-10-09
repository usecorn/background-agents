# Pilot review controller

This Node 24 package is the trusted integration between GitHub and OpenInspect. The review sandbox
must never receive its credentials or database.

Implemented building blocks:

- `github-oidc.ts` verifies GitHub signatures, issuer, audience, time bounds, repository/owner IDs,
  PR event and exact workflow path/ref. The signed PR number and merge-ref SHA must still be checked
  against current GitHub PR metadata before creating a run. Fork PRs and other event types are
  outside the pilot contract.
- `pr-binding.ts` binds verified OIDC to controller-fetched PR metadata and a separately fetched
  current main SHA. It rejects fork, closed, transferred, stale or mismatched PRs and derives the
  run binding from server-owned policy. The HTTP client must supply this metadata; publication must
  re-read freshness.
- `github-app-token.ts` signs App JWTs and obtains short-lived installation tokens limited to the
  configured repository and contents/PR read plus checks write.
- `github-client.ts` reads PR/current-main metadata and creates or updates the required check. Only
  completed CLEAN maps to success; incomplete results fail. It does not retry ambiguous writes.
  Reconciliation and freshness are caller duties.
- `review-result.ts` validates the final JSON response against a controller-owned file manifest and
  six-class coverage. Prose, missing scope, contradictory findings and unsupported files cannot
  produce a passing verdict.
- `check-recovery.ts` connects durable creation intents to App-owned check lookup, including
  recovery after an accepted POST loses its response. Missing ambiguous attempts stay pending
  instead of generating duplicate checks.
- `run-store.ts` records revision bindings, attempts, session IDs, deadlines and publication
  revisions in SQLite. Duplicate starts reuse the current run; only explicit rerun creates another
  attempt. Late/superseded completions cannot overwrite a current verdict. Publication retries
  survive process restart.

These modules do not yet expose an HTTP service. The reconciler, GitHub App client, OpenInspect
managed-review admission, operator overrides, and E2E driver still need integration. Never treat the
validator alone as a trusted GitHub gate.

## Result provenance

The final response must come from OpenInspect's authenticated event API after a successful terminal
execution for the recorded session and message. It must not come from a PR file, Actions output, a
callback body supplied by the sandbox, or an ordinary user follow-up. Managed-review prompt mutation
must be locked until this result is sealed. The run store persists a response digest and minimal
verdict metadata; the original report lives in the protected OpenInspect transcript.

The result schema measures claimed scope and catches mechanical inconsistencies. It cannot prove
that a model understood the code or resisted prompt injection; the adversarial evaluation corpus and
constrained tool profile remain necessary.

## Local verification

```bash
npm test -w @open-inspect/review-controller
npm run typecheck -w @open-inspect/review-controller
```

Tests use signed synthetic JWTs and real disposable SQLite files. They do not establish real GitHub
ruleset enforcement, provider execution or cloud access.
