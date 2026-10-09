# OpenInspect pilot implementation evidence

This is an execution record, not a replacement for the pilot plan. No implementation unit is
accepted as complete yet. Live deployment and E2E evidence are outstanding.

## Workspaces

- OpenInspect: `feat/openinspect-review-pilot`, based on upstream `8642fd42`. Upstream remains the
  only remote; never push Corn work there.
- DevOps: isolated sibling checkout `../devops-openinspect-pilot`, branch
  `feat/openinspect-review-pilot`. Original DevOps WIP is untouched.
- Terraform belongs only to DevOps. The application repository is unchanged.
- User authorized git pushes for this session. Code review and correct remote selection still
  precede publication.

## Host foundation (U1, partial)

DevOps commit `a14378d` adds `modules/openinspect-pilot/`, `terraform-openinspect-pilot/` and the
pilot runbook. Dedicated project, network, balanced data disk, Shielded VM, HTTPS ingress, IAP/OS
Login, registry and scoped host/operator IAM are declared.

Verification observed:

- `terraform fmt -check`: PASS.
- Module and root `terraform validate`: PASS.
- Module `terraform test`: two mocked plan tests PASS, including rejection of a production project
  ID.
- Bootstrap `bash -n`: PASS.
- Live Terraform plan/apply, startup, reboot persistence, TLS and rollback: NOT RUN. A mocked plan
  does not prove these behaviors.

## Native GCS storage (U2, partial)

Added a native adapter for the existing object-storage port and Node-host selection via
`OBJECT_STORE_PROVIDER=gcs`. S3 remains the existing default. GCS uses ADC, bounds upload buffering
and binds ranged byte reads to the metadata generation. This is media storage plumbing, not
sensitive-content encryption or backup proof.

Proof-first evidence:

- New adapter suite failed before implementation because its module was absent.
- Six adapter contract tests then PASS with a mocked GCS SDK.
- New provider-selection suite failed before implementation because its module was absent; three
  selection tests then PASS.
- Existing S3 and Node-host tests PASS in the affected test run.
- Existing environment-documentation test detected the new undeclared variable; the variable
  inventory was updated, and all four documentation tests PASS.
- Focused ESLint PASS. Prettier PASS after formatting the new factory.
- Initial TypeScript check found the Node/Workers stream-type boundary mismatch; the adapter now
  documents that boundary. Full control-plane TypeScript checks PASS after the correction, including
  Node, test and integration configurations.
- Node bundle build PASS. The actual bundled host booted with native GCS selected, served `/healthz`
  successfully and shut down with exit code 0 using a disposable synthetic data directory. No cloud
  storage request was made in this smoke test.
- Real GCS operations, encryption, expiry, full backups and restore: NOT RUN.

## Bootstrap access observations

- GCP active user: `thomas@usecorn.com`; no admin user is authenticated in gcloud.
- Corn organization is visible. Organization permission probe returned HTTP 429, so project-creation
  authority is not established.
- Billing permission probe on the existing Corn billing account returned no
  `billing.resourceAssociations.create` permission. New project billing attachment is unavailable to
  this identity.
- GitHub user `dapp-whisperer` is a member of `usecorn`.
- Creating `usecorn/openinspect` returned `CreateRepository` permission denied. Neither that repo
  nor `usecorn/openinspect-pilot-tests` was accessible by name.
- Vercel CLI can list Corn teams; paid sandbox duration and provisioning are not yet verified.
- Persistent Agent Tom browser is running; no GitHub or Cloud Console page was open at the time of
  inspection. Browser authentication has not been established.

Existing DevOps bootstrap docs reserve project/billing bootstrap for admin identities. Do not
substitute a production project or silently weaken org policy. Prepare the complete bootstrap change
and inspect available authorized operator access before escalating a one-time prerequisite to
Thomas.

## Remaining acceptance

U1 still needs bootstrap, packaging and deployed proof. U2 still needs sensitive data custody,
retention and recovery. U3–U6 still require the constrained reviewer, Vercel lifecycle proof,
trusted controller, test-repository gate, autonomous driver, evaluation corpus and value report. No
cloud resource or GitHub setting has been changed by the work recorded here; repository creation was
denied.
