# Pilot review controller

This Node 24 package is the trusted integration between GitHub and OpenInspect. The review sandbox
must never receive its credentials or database.

Implemented building blocks:

- `http-handler.ts` exposes bodyless authenticated `POST /reviews` and PR-scoped `GET /reviews/:id`.
  Admission fetches GitHub metadata and derives the run binding server-side; requests cannot choose
  the model, policy or verdict.
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
- `publication-reconciler.ts` serializes publication ticks, expires deadlines, recovers check
  identities, re-reads PR freshness and retries check updates from the persisted outcome. Superseded
  checks are cancelled. It never invokes a model.
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

## Run the controller

Use Node 24. Run `npm run build -w @open-inspect/review-controller`, then
`npm start -w @open-inspect/review-controller`. Configure these environment variables:

| Variable                                      | Value                                                               |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `REVIEW_REPOSITORY`                           | Pilot fixture repository as owner/name                              |
| `REVIEW_REPOSITORY_ID`, `REVIEW_OWNER_ID`     | GitHub numeric IDs                                                  |
| `REVIEW_OIDC_AUDIENCE`                        | Controller audience URL, also used by Actions                       |
| `REVIEW_WORKFLOW_PATH`                        | Allowed `.github/workflows/*.yml` path                              |
| `REVIEW_POLICY_DIGEST`, `REVIEW_MODEL_DIGEST` | Server-owned SHA-256 configuration digests                          |
| `REVIEW_APP_ID`, `REVIEW_INSTALLATION_ID`     | Dedicated pilot App and installation IDs                            |
| `REVIEW_APP_KEY_FILE`                         | Absolute PKCS#8 PEM path; file must have no group/other permissions |
| `REVIEW_DATABASE_PATH`                        | Absolute SQLite path in a private directory                         |
| `REVIEW_HOSTNAME`                             | Default `127.0.0.1`; `0.0.0.0` for an isolated container network    |
| `REVIEW_PORT`                                 | Default 8788                                                        |
| `REVIEW_TIMEOUT_MS`                           | Default 10800000, maximum three hours                               |

Run one controller process against the database. Put the service behind the pilot TLS proxy; do not
publish its plaintext port. `/healthz` indicates process liveness, not provider access or reviewer
readiness. The scheduler runs every five seconds, shares an active tick and drains it on shutdown.
Logs contain static operational codes, not credentials or provider responses. The App key belongs
only in this container's secret mount.
