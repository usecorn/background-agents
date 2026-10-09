#!/usr/bin/env python3
"""Exercise the actual Caddy route configuration against rejecting local backends.

No live credentials or cloud calls. This proves routing, not backend authentication
or public certificate issuance. Requires Linux Docker with host networking.
"""

import argparse
import http.client
import http.server
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]


class Reject(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(401)
        self.send_header("X-Smoke-Backend", str(self.server.server_port))
        self.end_headers()

    do_POST = do_GET

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    servers = [http.server.ThreadingHTTPServer(("127.0.0.1", 0), Reject) for _ in range(2)]
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    name = "openinspect-proxy-smoke-" + uuid.uuid4().hex
    try:
        with tempfile.TemporaryDirectory(prefix="openinspect-proxy-smoke-") as directory:
            config = pathlib.Path(directory) / "Caddyfile"
            config.write_text(
                "{\n admin off\n auto_https off\n}\n"
                f"http://127.0.0.1:{port} {{\n import /etc/caddy/pilot-routes.caddy\n}}\n"
            )
            config.chmod(0o644)
            command = [
                "docker",
                "run",
                "--detach",
                "--name",
                name,
                "--network",
                "host",
                "--user",
                "1002:1002",
                "--read-only",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges:true",
                "--tmpfs",
                "/config:uid=1002,gid=1002,mode=0700",
                "--tmpfs",
                "/data:uid=1002,gid=1002,mode=0700",
                "--mount",
                f"type=bind,src={config},dst=/etc/caddy/Caddyfile,readonly",
                "--mount",
                f"type=bind,src={ROOT / 'deploy/pilot/pilot-routes.caddy'},dst=/etc/caddy/pilot-routes.caddy,readonly",
                "--env",
                f"CONTROL_PLANE_UPSTREAM=127.0.0.1:{servers[0].server_port}",
                "--env",
                f"REVIEW_UPSTREAM=127.0.0.1:{servers[1].server_port}",
                args.image,
            ]
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL)

            def request(method, path, headers=None):
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
                try:
                    connection.request(method, path, headers=headers or {})
                    response = connection.getresponse()
                    return response.status, response.getheader("X-Smoke-Backend")
                finally:
                    connection.close()

            for attempt in range(50):
                try:
                    request("GET", "/")
                    break
                except OSError:
                    if attempt == 49:
                        subprocess.run(["docker", "logs", name], check=False)
                        raise
                    time.sleep(0.1)
            web = {
                "X-OpenInspect-Service": "web",
                "X-OpenInspect-Service-Signature": "sig1.invalid",
            }
            cases = [
                ("GET", "/", {}, None),
                ("GET", "/healthz", web, None),
                ("POST", "/managed-reviews", web, None),
                ("POST", "/managed-reviews/example/launch", web, None),
                ("GET", "/sessions", {}, None),
                ("GET", "/sessions", {"X-OpenInspect-Service": "web"}, None),
                ("GET", "/sessions", web, 0),
                ("POST", "/reviews", {}, 1),
                ("GET", "/reviews/12345678-1234-1234-1234-123456789abc", {}, 1),
                ("GET", "/reviews", {}, None),
                ("GET", "/reviews/invalid", {}, None),
                ("GET", "/sessions/managed-review-example/ws", {}, None),
                (
                    "GET",
                    "/sessions/managed-review-example/ws",
                    {"Connection": "Upgrade", "Upgrade": "websocket"},
                    0,
                ),
                ("POST", "/sessions/managed-review-example/sandbox-error", {}, 0),
                ("POST", "/sessions/managed-review-example/scm-credentials", {}, None),
            ]
            for method, path, headers, backend in cases:
                actual = request(method, path, headers)
                expected = (
                    (404, None) if backend is None else (401, str(servers[backend].server_port))
                )
                assert actual == expected, (method, path, actual, expected)
            print(f"PASS: {len(cases)} Caddy route cases; backend rejection preserved")
    finally:
        subprocess.run(
            ["docker", "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        for server in servers:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
