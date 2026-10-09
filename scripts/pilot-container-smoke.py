#!/usr/bin/env python3
"""Boot trusted pilot images with synthetic config and no network; clean up owned containers."""

import argparse
import os
import pathlib
import subprocess
import tempfile
import time


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs).stdout.strip()


parser = argparse.ArgumentParser()
parser.add_argument("--control-plane-image", required=True)
parser.add_argument("--controller-image", required=True)
images = parser.parse_args()

with tempfile.TemporaryDirectory(prefix="openinspect-container-proof-") as root:
    root = pathlib.Path(root)
    names = []
    try:
        for service, uid, port, image in [
            ("control-plane", 1000, 8787, images.control_plane_image),
            ("review-controller", 1001, 8788, images.controller_image),
        ]:
            data = root / service
            data.mkdir(mode=0o700)
            run("sudo", "chown", str(uid) + ":" + str(uid), str(data))
            env = {}
            mounts = ["--mount", f"type=bind,src={data},dst=/data"]
            if service == "control-plane":
                env = {
                    "DEPLOYMENT_NAME": "synthetic-pilot",
                    "GITHUB_BOT_USERNAME": "synthetic",
                    "TOKEN_ENCRYPTION_KEY": "c3ludGhldGljLW9ubHktMDAwMDAwMDAwMDAwMDAwMDA=",
                    "PROVIDER_ACCOUNTS_ENCRYPTION_KEY": "c3ludGhldGljLW9ubHktMDAwMDAwMDAwMDAwMDAwMDA=",
                    "REPO_SECRETS_ENCRYPTION_KEY": "c3ludGhldGljLW9ubHktMDAwMDAwMDAwMDAwMDAwMDA=",
                    "OBJECT_STORE_PROVIDER": "gcs",
                    "OBJECT_STORE_BUCKET": "synthetic-not-accessed",
                    "SANDBOX_PROVIDER": "vercel",
                }
            else:
                secrets = root / "secrets"
                secrets.mkdir(mode=0o700)
                for name in ["github-app.pem", "review-service-secret"]:
                    p = secrets / name
                    p.write_text("synthetic-placeholder-never-authenticates")
                    p.chmod(0o400)
                run("sudo", "chown", "-R", "1001:1001", str(secrets))
                mounts += ["--mount", f"type=bind,src={secrets},dst=/run/secrets,readonly"]
                env = {
                    "REVIEW_REPOSITORY": "fixture/test",
                    "REVIEW_REPOSITORY_ID": "123",
                    "REVIEW_OWNER_ID": "456",
                    "REVIEW_OIDC_AUDIENCE": "https://synthetic.invalid",
                    "REVIEW_WORKFLOW_PATH": ".github/workflows/review.yml",
                    "REVIEW_APP_ID": "789",
                    "REVIEW_INSTALLATION_ID": "987",
                    "REVIEW_APP_KEY_FILE": "/run/secrets/github-app.pem",
                    "REVIEW_SERVICE_SECRET_FILE": "/run/secrets/review-service-secret",
                    "REVIEW_CONTROL_PLANE_ORIGIN": "http://control-plane:8787",
                }
            name = f"openinspect-proof-{service}-{os.getpid()}"
            names.append(name)
            args = [
                "docker",
                "run",
                "-d",
                "--name",
                name,
                "--network",
                "none",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--tmpfs",
                "/tmp:mode=1777,size=128m",
                *mounts,
            ]
            for k, v in env.items():
                args += ["-e", k + "=" + v]
            run(*args, image)

            def health(name, port, service):
                for _ in range(40):
                    p = subprocess.run(
                        [
                            "docker",
                            "exec",
                            name,
                            "node",
                            "-e",
                            f"fetch('http://127.0.0.1:{port}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
                        ],
                        capture_output=True,
                    )
                    if p.returncode == 0:
                        return
                    if run("docker", "inspect", "-f", "{{.State.Running}}", name) != "true":
                        raise RuntimeError(run("docker", "logs", name))
                    time.sleep(0.25)
                raise RuntimeError("health timeout " + service)

            health(name, port, service)
            route = "/reviews" if service == "review-controller" else "/managed-reviews"
            run(
                "docker",
                "exec",
                name,
                "node",
                "-e",
                f"fetch('http://127.0.0.1:{port}{route}',{{method:'POST',body:'{{}}'}}).then(r=>process.exit(r.status===401?0:1))",
            )
            run(
                "docker",
                "exec",
                name,
                "node",
                "-e",
                f"if(process.getuid()!=={uid})process.exit(1);require('fs').writeFileSync('/data/restart-proof','synthetic')",
            )
            run("docker", "restart", name)
            health(name, port, service)
            run(
                "docker",
                "exec",
                name,
                "node",
                "-e",
                "if(require('fs').readFileSync('/data/restart-proof','utf8')!=='synthetic')process.exit(1)",
            )
            run("docker", "stop", "-t", "40", name)
            assert run("docker", "inspect", "-f", "{{.State.ExitCode}}", name) == "0"
            print(
                "PASS",
                service,
                "nonroot, read-only root, health, anonymous 401, restart persistence, clean exit",
                flush=True,
            )
    finally:
        for name in names:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        run("sudo", "chown", "-R", str(os.getuid()) + ":" + str(os.getgid()), str(root))
