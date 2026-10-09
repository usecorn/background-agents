# Deploying the synthetic GCP pilot

Use the existing VM and ownership from DevOps PR 141. Infrastructure, DNS, bucket and IAM changes
belong in DevOps. This application configuration starts two trusted services with loopback-only
ports; it does not open public ingress. Run synthetic fixtures only.

## Build and verify images

From the application checkout:

```sh
docker build -f packages/control-plane/Dockerfile -t openinspect-control-plane:pilot .
docker build -f packages/review-controller/Dockerfile -t openinspect-review-controller:pilot .
python3 scripts/pilot-container-smoke.py \
  --control-plane-image openinspect-control-plane:pilot \
  --controller-image openinspect-review-controller:pilot
```

The smoke requires Docker and sudo for disposable UID-owned directories. It uses synthetic
configuration with networking disabled, checks health/authentication/restart/drain, and removes its
own containers and temporary files. It proves image boot behavior, not provider access or reviews.
Push the verified images to the existing pilot Artifact Registry and record their immutable digests.
If registry upload is unavailable, the first synthetic pilot can use `docker save` / IAP transfer /
`docker load` on the authorized VM. Compare archive SHA-256 on both machines and compare loaded
image IDs with the verified local IDs. Set Compose image values to those full `sha256:` image IDs;
this pins the local content without requiring registry-write privileges. Record that deployment uses
locally loaded images and cannot pull replacements from the registry.

## Host files

Use the existing data disk under `/var/lib/openinspect-staging`:

- `control-plane/`: UID 1000, mode 0700, control-plane databases only.
- `review-controller/data/`: UID 1001, mode 0700, controller SQLite. Create this subdirectory.
- `review-controller/secrets/`: UID 1001, mode 0700, mounted read-only only in the controller. The
  admin receipt records the staged `github-app.pem` (UID 1001, mode 0400). Create the separate
  `review-service-secret` file privately; use the same value in the control-plane environment as
  `SERVICE_AUTH_SECRET_REVIEW_CONTROLLER`.

Keep root-owned mode-0600 environment files outside the mounted data directories. Do not put either
service's secrets in the other's environment. The controller App key never belongs in the control
plane or worker. No admin credentials or host Docker socket are mounted.

Control-plane configuration needs its normal encryption keys and deployment settings, the private
GCS media bucket name (`OBJECT_STORE_BUCKET`), Vercel token/team/project/trusted base snapshot,
`VERCEL_MAX_SANDBOX_TIMEOUT_MS` sufficient for the two-hour review allocation, the approved
`ANTHROPIC_API_KEY`, and `WORKER_URL` pointing to the authenticated TLS callback endpoint. Configure
web authentication and `WEB_APP_URL`, then set `MANAGED_REVIEW_OWNER_USER_ID` to the verified
operator's canonical user ID. Do not invent a user ID or disable authentication for bootstrap.

Controller settings are listed in [its README](../packages/review-controller/README.md). The current
admin receipt gives fixture repository ID `1412360568`, owner ID `162482407`, App ID `5255005` and
installation ID `169720908`. Verify these against the receipt when deploying. Set the intended
workflow path and TLS OIDC audience before enabling the fixture workflow.

## Start privately

Create a root-private Compose interpolation file naming:

```text
CONTROL_PLANE_IMAGE=<registry/control-plane@sha256:digest>
REVIEW_CONTROLLER_IMAGE=<registry/review-controller@sha256:digest>
CONTROL_PLANE_ENV_FILE=<absolute private environment file>
REVIEW_CONTROLLER_ENV_FILE=<absolute private environment file>
```

Copy `docker-compose.pilot.yml` to the host and run:

```sh
sudo docker compose --env-file /path/to/pilot-images.env -f docker-compose.pilot.yml config --quiet
sudo docker compose --env-file /path/to/pilot-images.env -f docker-compose.pilot.yml up -d
curl --fail http://127.0.0.1:8787/healthz
curl --fail http://127.0.0.1:8788/healthz
```

Do not combine this file with the repository's S3/Litestream Compose stack. The pilot uses the GCS
adapter; media storage is not database backup. Keep the App key as a read-only secret mount outside
the controller's data mount. The two HTTP ports remain loopback-only until the agreed TLS routes are
configured and verified. Health responses do not prove GitHub, storage, model or Vercel access.

Before a live review, verify the worker callback path, trusted snapshot and worker confinement;
check App installation scope using the staged key; then enable only the synthetic repository's
workflow. Record actual PR/check/session IDs and worker cleanup. Extended restoration and real-data
custody remain outstanding in [PILOT_STATUS.md](PILOT_STATUS.md).

## TLS proxy preparation

The optional `docker-compose.pilot-tls.yml` overlay adds Caddy with a separate UID and certificate
directory. It defaults to loopback binding. Build and test it before staging on the host:

```sh
docker build -f deploy/pilot/Dockerfile.caddy -t openinspect-pilot-caddy:local .
python3 scripts/pilot-proxy-smoke.py --image openinspect-pilot-caddy:local
```

The base image is digest-pinned. Its file capability is removed because this proxy listens on
unprivileged port 8443 inside the container; all Linux capabilities remain dropped. Pin the resulting
image ID in `TLS_PROXY_IMAGE`, using the same verified image-transfer procedure as the other services.
Create `/var/lib/openinspect-staging/tls` as UID/GID1002, mode0700. Copy the two files under
`deploy/pilot/` (`Caddyfile` and `pilot-routes.caddy`) into `/etc/openinspect-pilot/`, readable by the
container UID through their file mounts, and copy the TLS Compose overlay there.

The route smoke runs the actual Caddy configuration with rejecting synthetic backends. It proves
the 15 allowed/denied routing cases and preserves upstream 401 responses; it does not prove real
backend authentication, WebSocket session traffic, or public TLS certificate issuance. Backend
authentication remains mandatory: the web header matcher only selects a route, and the control plane
must still validate its signature. Managed-review administration and health endpoints are denied at
the proxy. Worker access is limited to session WebSockets and sandbox-error reports. Access logging
is disabled because WebSocket URLs can contain tokens.

After the admin establishes DNS and reviews the endpoint, coordinate the separate DevOps HTTPS
firewall change. Set `PILOT_HTTPS_BIND=0.0.0.0` in the private Compose interpolation file only when
ready to enable ingress. Caddy uses the ACME TLS-ALPN challenge on TCP443; port80 and HTTP redirects
are disabled. The public certificate cannot be issued while the firewall remains closed. Start with:

```sh
sudo docker compose --env-file /etc/openinspect-pilot/images.env \
  -f /etc/openinspect-pilot/compose.yml \
  -f /etc/openinspect-pilot/docker-compose.pilot-tls.yml up -d --pull never
```

Before enabling fixture Actions, verify certificate trust and hostname, unsigned `/reviews` returns
401, unsigned session APIs are denied, a forged web signature is rejected, private managed routes
return404, and the real worker's authenticated WebSocket connects. Keep the check optional. To remove
public service, stop `tls-proxy` and disable the DevOps HTTPS firewall; preserve its certificate data.
