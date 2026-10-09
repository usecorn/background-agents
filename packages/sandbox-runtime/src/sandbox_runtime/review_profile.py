"""Controller-owned OpenCode launch profile; never constructed from repository config."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from . import review_isolation

_PROVIDER_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "openai": "OPENAI_API_KEY"}


@dataclass(frozen=True)
class ReviewProfile:
    source_root: Path
    manifest_path: Path
    state_root: Path
    provider: str
    model: str

    def environment(self) -> dict[str, str]:
        source = self.source_root.resolve(strict=True)
        manifest = self.manifest_path.resolve(strict=True)
        state = self.state_root.resolve()
        if (
            source.is_relative_to(state)
            or state.is_relative_to(source)
            or manifest.is_relative_to(source)
        ):
            raise ValueError("Review source and trusted state must be separate")
        if self.provider not in _PROVIDER_KEYS or not self.model:
            raise ValueError("Unsupported review model provider")
        if not source.is_dir() or not manifest.is_file():
            raise ValueError("Invalid review source")
        key_name = _PROVIDER_KEYS[self.provider]
        credential = os.environ.get(key_name)
        if not credential:
            raise ValueError("Review provider credential unavailable")
        for directory in ("home", "config", "data", "cache", "state", "work"):
            (state / directory).mkdir(parents=True, mode=0o700, exist_ok=True)
        permission = {"*": "deny", "review_source_*": "allow"}
        model = f"{self.provider}/{self.model}"
        config = {
            "model": model,
            "small_model": model,
            "enabled_providers": [self.provider],
            "default_agent": "reviewer",
            "permission": permission,
            "agent": {
                "build": {"disable": True},
                "plan": {"disable": True},
                "general": {"disable": True},
                "explore": {"disable": True},
                "reviewer": {
                    "description": "Inspect controller-assigned source using bounded review tools.",
                    "mode": "primary",
                    "model": model,
                    "permission": permission,
                },
            },
            "instructions": [],
            "plugin": [],
            "share": "disabled",
            "autoupdate": False,
            "lsp": False,
            "formatter": False,
            "mcp": {
                "review_source": {
                    "type": "local",
                    "command": [
                        sys.executable,
                        str(Path(review_isolation.__file__).resolve()),
                        str(source),
                        str(manifest),
                    ],
                    "enabled": True,
                }
            },
        }
        # All inherited OpenCode, Node/Bun, npm, proxy, Git and bridge settings are
        # discarded. The provider key goes only to OpenCode, not the confined tool.
        return {
            "PATH": "/opt/openinspect/node/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME": str(state / "home"),
            "XDG_CONFIG_HOME": str(state / "config"),
            "XDG_DATA_HOME": str(state / "data"),
            "XDG_CACHE_HOME": str(state / "cache"),
            "XDG_STATE_HOME": str(state / "state"),
            "OPENCODE_CONFIG_CONTENT": json.dumps(config),
            "OPENCODE_CLIENT": "serve",
            "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
            "OPENCODE_DISABLE_DEFAULT_PLUGINS": "1",
            "OPENCODE_DISABLE_EXTERNAL_SKILLS": "1",
            "OPENCODE_DISABLE_CLAUDE_CODE": "1",
            "OPENCODE_DISABLE_LSP_DOWNLOAD": "1",
            "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER": "1",
            "OPENCODE_PURE": "1",
            key_name: credential,
        }
