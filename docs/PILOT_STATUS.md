# Corn OpenInspect pilot: application handoff

This branch is an implementation checkpoint for review, not a deployable malicious-code gate. The
controller accepts review requests, retrieves/seals existing OpenInspect results, and manages GitHub
checks, but the controller does not yet create sessions or request managed Vercel execution. Do not
enable a required check against this implementation yet.

## Source and infrastructure

Application fork: https://github.com/usecorn/background-agents Branch:
`feat/openinspect-review-pilot`. Terraform remains in https://github.com/usecorn/devops/pull/141.
Use that PR's current staging receipt and security handoff for machine names, access, disk locations
and provisioning authority. Do not copy admin credentials to the development workstation. The old
implementation evidence report is historical; its initial infrastructure and remote descriptions are
superseded by this handoff and DevOps.

## Components to inspect

- `packages/review-controller`: Node 24 HTTP admission, GitHub OIDC/App client, SQLite run/check
  persistence and publication reconciliation. Its README documents environment variables. App keys
  must be mounted only into the controller. `/healthz` reports liveness, not reviewer readiness.
- `packages/control-plane`: Node-hostable OpenInspect service, GCS adapter, managed-session prompt
  locks, and dedicated Vercel managed-review creation/restore methods. Managed restore uses the
  retained context without uploading replacement source or falling back to a base image. These
  creation method now has a controller-only lifecycle launch endpoint with a durable launch claim.
  Session creation, controller scheduling and managed continuation still need wiring. See
  `docs/CONTROL_PLANE_CONTAINER.md` for existing packaging. Application deployment needs separate
  persistent control-plane/controller directories using the host ownership from Terraform.
- `packages/sandbox-runtime`: explicit managed launch, hash-verified source staging, constrained
  OpenCode configuration, read-only/network-isolated MCP tools, and strict conversation recovery.
- `packages/review-controller/src/source-bundle.ts`: creates a regular-file tar from validated text
  and expected hashes. Requires GNU tar on the trusted controller host/image. Never supply a PR
  archive to the provider's trusted bundle parameter.

## Verification performed locally

The controller tests cover real SQLite, signed synthetic OIDC, authenticated result retrieval,
exact-digest sealing, restart retries, and late completion races. The source bundle was extracted
and consumed by the actual Python launch loader with temporary paths. Python runtime tests cover
staging, managed boot, confinement and refusal to replace a missing conversation. Real OpenCode
1.18.29 tests with a synthetic provider proved bounded tools, blocked shell/plugin traps, saved
messages after process restart, and a follow-up in the same conversation. These are not real GitHub
checks, deployed image proof, Vercel conversation restore, or a real-model accuracy evaluation.
Prior Vercel probes proved individual lifecycle/isolation primitives only.

The controller now requires `REVIEW_CONTROL_PLANE_ORIGIN` and a private `REVIEW_SERVICE_SECRET_FILE`
containing the controller's own sig1 secret. See its README. The result reconciler reads existing
bound executions; it does not start them.

To run the bundle cross-language check after installing the sandbox runtime Python environment:

```sh
REVIEW_RUNTIME_PYTHON=/absolute/path/to/sandbox-runtime/.venv/bin/python npm test -w @open-inspect/review-controller
```

Without that variable the cross-language case is explicitly skipped.

## First working run and later acceptance

The immediate milestone is one synthetic PR, an isolated review, an inspectable session and an
optional GitHub check. Preserve the existing implementation; extended recovery, real-data
encryption, overrides, autonomous deployment and the larger evaluation corpus follow that first run.
This ordering does not claim those later acceptance requirements are complete.

The admin prerequisites are in
[PILOT_GITHUB_BOOTSTRAP_HANDOFF.md](PILOT_GITHUB_BOOTSTRAP_HANDOFF.md).

1. Wire managed session creation and controller execution to source acquisition, policy, Vercel
   create/restore. Terminal retrieval, coverage validation, sealing and publication are wired into
   the controller scheduler, but it does not yet launch complete reviews.
2. Use the existing model API key for the synthetic pilot, as approved by the current DevOps
   application-readiness handoff. The confined source tools cannot access it. No provider broker is
   required for this milestone. GitHub App, SCM and ordinary OAuth credentials remain unavailable to
   managed workers, including through credential callback routes.
3. Implement application encryption/KMS custody, retention/expiry, complete backups and restoration.
4. Finish UI observation/continuation, authorized overrides, reruns and scoped autonomous driver.
5. Configure the pilot GitHub App, selected fixture repository, CI authentication and expected-App
   check enforcement. Inspect inherited access/workflows before enabling CI. No production gate.
6. Package pinned images, deploy behind private access first, verify restart/rollback and API auth,
   then enable the agreed TLS endpoint. Do not deploy candidate PR code on the controller host.
7. Prove long-running and seven-day recovery behavior, two full autonomous E2E runs, spending
   alerts, and the malicious/benign evaluation corpus. No accuracy/cost recommendation is ready yet.

OpenCode's loopback API must remain trusted-only. A probe against 1.18.29 found that a
caller-selected repository directory can load a hostile plugin despite config flags; the managed
launch uses trusted cwd and bridge requests without caller-selected directory headers. Do not add an
unrestricted proxy.

## Managed terminal API

The `review-controller` service principal alone can call:

- `POST /managed-reviews/:sessionId/launch` with JSON `{runId, messageId, bundleBase64}`. The bundle
  must be controller-built. A persistent claim prevents duplicate model starts; an ambiguous or
  failed launch requires investigation or a new review attempt.
- `GET /managed-reviews/:sessionId/result?runId=...&messageId=...`
- `POST /managed-reviews/:sessionId/seal` with JSON `{runId, messageId, responseDigest}`.

Use the existing sig1 service signature with the controller's separate shared secret. The result is
pending, incomplete, or completed. A completed candidate includes the attributed assistant response
and its SHA-256 text digest; the controller must still validate JSON, coverage and current
revisions. Seal supplies the observed digest, not a verdict. Failed terminal execution can be sealed
with a null digest for later investigation, but cannot become passing evidence. Active/missing
execution stays locked.
