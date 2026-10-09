---
artifact_contract: "ce-handoff/v1"
created_at: "2026-10-09T19:27:00Z"
title: "OpenInspect first-run GitHub bootstrap"
summary: "Admin-machine prerequisites for the first synthetic PR review on the existing pilot VM."
keywords: ["openinspect", "github-app", "fixture-repository", "admin-bootstrap"]
resume_focus:
  "Provide the isolated fixture repository and scoped GitHub App needed for the first working
  review."
repository: "usecorn/background-agents"
branch: "feat/openinspect-review-pilot"
head: "b2d666c0"
---

# OpenInspect: GitHub bootstrap handoff for the admin agent

## Immediate objective

Thomas asked us to focus on getting one working path: a synthetic test PR starts an isolated review,
its session is inspectable, and the trusted controller publishes the GitHub check. Preserve
completed work. Extended recovery, full staging automation and broader evaluation are follow-up
work, not prerequisites for this first synthetic run. Keep the check optional.

This handoff captures the one-time GitHub prerequisites for that path. It does not request another
VM, another environment, a model broker, or production integration. Thomas explicitly requires admin
credentials and logins to stay on the admin machine.

## Verified current state

- Application fork: [usecorn/background-agents](https://github.com/usecorn/background-agents),
  branch `feat/openinspect-review-pilot`. Published code is an implementation checkpoint; launch
  integration is still being completed. See [PILOT_STATUS.md](PILOT_STATUS.md).
- Infrastructure: [DevOps PR 141](https://github.com/usecorn/devops/pull/141), observed at
  `e5780a38d3e09932005f46d861ff2f5839483e0a`. Its
  `docs/runbooks/openinspect-application-readiness.md` records the simplified first-run scope;
  `docs/runbooks/openinspect-staging-receipt.md` records the actual host and access grants.
- `openinspect-staging` in project `openinspect-staging-corn`, zone `us-central1-a`, is running.
  Ordinary Thomas IAP SSH succeeded; `docker ps` returned no running containers.
- The development GitHub identity is `dapp-whisperer`. A current lookup could not resolve
  `usecorn/openinspect-pilot-tests` for that identity. This does not distinguish an absent
  repository from a private repository without access; inspect before creating anything.
- The latest admin handoff records no pilot GitHub App or fixture installation as provisioned.
  Recheck current state to avoid duplicating work by another agent.

## Bootstrap needed on the admin machine

1. Establish the dedicated **`usecorn/openinspect-pilot-tests`** repository, with a `main` branch
   and synthetic contents only. If it already exists, verify its intended ownership and access
   rather than creating a replacement. Grant `dapp-whisperer` repository write access so the
   development agent can create fixture branches and PRs and clean them up. Do not grant
   organization administration or ruleset bypass.
2. Create a dedicated GitHub App, for example **Corn OpenInspect Pilot**, and install it on **only
   that fixture repository**, using selected-repository access. Repository permissions: **Contents:
   read**, **Pull requests: read**, **Checks: write**; GitHub's required metadata read access is
   implicit. No organization permissions, contents write, Actions write, administration, or
   production-repository access is needed. Webhooks can remain disabled: the current design uses
   Actions OIDC to start reviews and the App to publish checks.
3. Generate its App private key and arrange private delivery to the controller on the pilot host,
   following the DevOps custody guidance. Prefer Secret Manager as the durable source; record the
   resource/version identifier and the eventual controller-only mount path. The controller reads
   `REVIEW_APP_KEY_FILE`, an absolute PEM path with no group/other access, readable by its UID 1001.
   Never commit the PEM or return its contents in chat. Keep it out of the web app, control-plane
   container, worker sandbox and Actions secrets. Any GCP IAM/Secret Manager Terraform belongs in
   DevOps, not this application fork.
4. Check inherited repository access, Actions secrets, runner eligibility and federation trust
   before enabling fixture CI. Use GitHub-hosted runners for this first run, with no production
   credentials. Preserve the existing organization signing/review rules. The application agent will
   supply the fixture workflow after the endpoint is ready; its OIDC request requires
   `id-token: write`, not an App key. Do not enable a required merge gate.

The App key and the model key serve different purposes. The latest admin handoff permits the model
API key in the constrained review sandbox. That does **not** authorize exposing the GitHub App key,
installation tokens, GCP credentials or sandbox-management token to it.

## Return these non-secret details

```text
Fixture repository URL:
Fixture repository numeric ID:
Repository owner numeric ID:
Development identity confirmed with write access: dapp-whisperer
GitHub App name and numeric App ID:
GitHub App installation ID:
Installation repository selection confirmed: only the fixture repository
App private-key Secret Manager resource/version (identifier only):
Controller-only key mount path and delivery status:
Any remaining bootstrap restriction or inherited-access issue:
```

The application agent can derive repository IDs once repository access is available. If a secret is
staged but not yet mounted because the deployment layout is unfinished, state that explicitly; do
not create another service to solve it. Keep actual credential values on the admin machine, in
Secret Manager, or on the authorized pilot host.

## Application work that remains with the development agent

The bootstrap does not prove the application works. The development agent still owns managed session
creation/launch wiring, minimal image and deployment configuration, the fixture workflow, and the
real clean/suspicious PR runs. Hostname/TLS and narrowly scoped worker callbacks must be ready
before remote execution. Public HTTPS is currently disabled; retain the DevOps ingress boundary
until the application is ready. Record actual PR/check/session IDs and worker cleanup; local unit
tests are not live end-to-end evidence.
