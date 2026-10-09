# Corn OpenInspect pilot: application handoff

This branch is an implementation checkpoint for review, not a deployable malicious-code gate. The
controller accepts review requests, retrieves/seals existing OpenInspect results, and manages GitHub
checks, and now connects admitted runs to managed session creation and launch. Live deployment and
real GitHub/model execution remain unverified. Do not enable a required check against this
implementation yet.

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
  Private managed session creation is available through the controller-only API. Controller
  scheduling is connected; managed continuation still needs wiring. See
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
containing the controller's own sig1 secret. See its README. The execution reconciler prepares
source and starts bound executions. The result reconciler then validates and seals completed
responses before publication.

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

1. Prove the wired creation/launch/result/publication path in the deployed pilot. Local tests use
   real SQLite and tar with simulated external APIs; they are not real GitHub or model execution.
   Managed restore/continuation still needs lifecycle wiring.
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

## Managed review API

The control plane requires `MANAGED_REVIEW_OWNER_USER_ID` to name an existing canonical user for
creation. Configure the verified pilot operator's user ID after sign-in; callers cannot supply a
user, team, repository, model or credential selection. Created sessions are private, repo-less,
OpenCode with Anthropic Sonnet 4.6, with no selected memory or managed skills. The run UUID derives
both session and message IDs. Repeated creation preserves the existing owner and exact prompt.

The `review-controller` service principal alone can call:

- `POST /managed-reviews` with JSON `{runId, content}` to initialize the bound session.
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

## Deployment preparation receipt

The application images were built from application source `de63f916` with packaging published at
`ae4a5659`. Both passed the network-disabled container smoke (health, anonymous rejection,
non-root/read-only execution, restart persistence and clean exit). They were transferred over IAP
and loaded on `openinspect-staging`; archive checksum and image IDs matched. Registry upload was
denied for ordinary Thomas, so the first pilot can pin these loaded image IDs:

- Control plane: `sha256:a89c51c22f7d7dd756136ff17fe922e3c96b4612e4e18a1f77069d77f523146c`
- Controller: `sha256:54ad58acb792dd711e570cce84bc9cbac4bad3247a04981a26d2e432cd9a9759`

Trusted Vercel snapshot: `snap_H4azvuLQ9XXg0OKzaBNBD7ESWEk4`, in the existing `openinspect-pilot`
project. Build input hash: `2bf5409df9187be77176c0aec66b561b3248c4c2014f406a1bd52154de1c566e`. The
builder restored a fresh sandbox and passed the image verification suite, then stopped both
verification and build sandboxes. This does not yet prove a managed real-model conversation or
managed conversation restoration. A local global uv cutoff conflicted with the pinned lockfile;
`UV_NO_CONFIG=true` allowed the existing locked export without changing dependencies.

The admin receipt at DevOps `a0bdf01` confirms App-key delivery. DevOps `1ff0b24` adds the private
synthetic-media bucket configuration and `docs/runbooks/openinspect-runtime-bootstrap-handoff.md`;
its six mocked Terraform tests and validation passed, but that new bucket has not been live-applied
by this agent. Services have not been started on the VM. Runtime secrets, sign-in configuration, TLS
callback access, fixture Actions enablement and actual PR/check/session proof remain outstanding.

## Private service startup receipt

Both `openinspect-pilot-control-plane-1` and `openinspect-pilot-review-controller-1` are healthy on
`openinspect-staging`. They bind only `127.0.0.1:8787` and `127.0.0.1:8788`. The control plane
applied 84 migrations and reports active cron/alarm/job loops with no sessions. The controller
reports liveness. Both unauthenticated admission endpoints return 401.

Runtime configuration is under `/etc/openinspect-pilot` (root-private files); service/encryption
secrets were generated on the VM without printing their values. The App key remains solely in the
controller secret mount. The Vercel management token was staged in the control-plane environment;
its project/team/snapshot match the verified pilot artifact. Model credentials and a verified
canonical review owner still need configuration. The proposed callback hostname and media bucket are
configured names, not claims that DNS/TLS or bucket provisioning is complete.

An actual signed request from the controller container to the control plane passed authentication
and returned `MANAGED_REVIEW_OWNER_UNAVAILABLE` (503), with no review created. This verifies secret
agreement while preserving the owner requirement. Both services restarted and recovered healthy; the
signed refusal was verified again. Environment files are root-owned 0600 and controller SQLite is
UID1001 mode0600. No model run, public ingress or fixture CI was started by this receipt.

## Web deployment receipt

The pilot web application is deployed at https://openinspect-pilot.vercel.app from source
`87c13cf2710405bb2c5d554811ca57f5643cf111`. Vercel deployment
`dpl_ErmHdyvbTWMm87QUoUyMd9ptnK2j` is READY. The project is the existing `openinspect-pilot` under
`corn-previews`; its production target is this isolated pilot, not the Corn production application.
The web app receives its own sig1 secret and the pilot control-plane URL, not model or GitHub App
credentials. The control plane now has the matching web origin and operator-only admission settings.
Its approved temporary Anthropic key is loaded privately. Health and authenticated missing-owner
refusal were verified again after recreation.

Verification: local production build passed; 21 focused web authentication/proxy tests passed; hosted
Vercel build passed. HTTP `/login` returns200, anonymous `/api/sessions` returns401, and the existing
headed browser renders “Sign-in is temporarily unavailable.” This is expected while controller
DNS/TLS and OAuth bootstrap are pending. It is not proof of successful sign-in or session inspection.

The first remote build exposed a missing upload dependency: `.vercelignore` excluded the shared
coverage policy imported by the web Vitest configuration during TypeScript checking. The published
fix includes that policy and its baseline data. Earlier CLI connection timeouts created no deployment;
a direct Node API probe succeeded with `--dns-result-order=ipv4first`, and that process-local setting
allowed deployment. No global networking configuration was changed.

The TLS proxy image/configuration are staged but not running; see DevOps PR141's runtime-bootstrap
handoff. OAuth client credentials, canonical owner sign-in, media provisioning, controller DNS/TLS,
fixture Actions enablement, and the first real PR/model/session/check run remain outstanding.
