"""OS boundary for the trusted, stdlib-only review MCP process.

Arguments are controller-owned paths. The source must already be immutable to
other processes: a read-only bind prevents this process writing, not host writes.
System libraries and the Python installation must come from the trusted image.
No fallback runs tools if namespaces or privilege dropping are unavailable.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

_BOOT = """
import runpy, sys, types
package = types.ModuleType('sandbox_runtime')
package.__path__ = ['/tools/sandbox_runtime']
sys.modules['sandbox_runtime'] = package
sys.argv = ['review_tools', '/source', '/manifest.json']
runpy.run_module('sandbox_runtime.review_tools', run_name='__main__')
"""


def isolated_command(source: Path, manifest: Path, python_args: list[str]) -> list[str]:
    """Build a confined invocation; python_args are trusted program code, not model input."""
    bwrap = shutil.which("bwrap")
    if not bwrap:
        raise RuntimeError("Review isolation unavailable")
    source = source.resolve(strict=True)
    manifest = manifest.resolve(strict=True)
    if not source.is_dir() or not manifest.is_file():
        raise ValueError("Invalid review inputs")
    # Vercel can start even non-root commands with inherited capabilities.
    # Drop them before Bubblewrap creates the inner user namespace.
    setpriv = shutil.which("setpriv")
    if not setpriv:
        raise RuntimeError("Review isolation unavailable")
    command = [setpriv, "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all"]
    command += [
        bwrap,
        "--unshare-all",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--disable-userns",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--clearenv",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
    ]
    # No HOME, /etc, /run, parent procfs, host sockets or credential mount.
    for location in ("/usr", "/lib", "/lib64"):
        if Path(location).exists():
            command += ["--ro-bind", location, location]
    prefix = Path(sys.base_prefix).resolve(strict=True)
    if not prefix.is_relative_to("/usr"):
        command += ["--ro-bind", str(prefix), str(prefix)]
    for name in ("review_source.py", "review_tools.py"):
        command += [
            "--ro-bind",
            str(Path(__file__).with_name(name)),
            f"/tools/sandbox_runtime/{name}",
        ]
    command += [
        "--ro-bind",
        str(source),
        "/source",
        "--ro-bind",
        str(manifest),
        "/manifest.json",
        "--chdir",
        "/tools",
        "--remount-ro",
        "/",
        str(Path(sys.executable).resolve(strict=True)),
        "-I",
        "-S",
        *python_args,
    ]
    return command


def tools_command(source: Path, manifest: Path) -> list[str]:
    return isolated_command(source, manifest, ["-c", _BOOT])


def main() -> int:
    try:
        if len(sys.argv) != 3:
            raise ValueError("Invalid arguments")
        command = tools_command(Path(sys.argv[1]), Path(sys.argv[2]))
        # Keep only MCP stdin/stdout/stderr. Never inherit provider environment or
        # an open host descriptor, even when launched by a credentialed process.
        return subprocess.run(command, env={}, close_fds=True, check=False).returncode
    except (OSError, ValueError, RuntimeError):
        print("Review isolation unavailable", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
