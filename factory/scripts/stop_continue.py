#!/usr/bin/env python3
from __future__ import annotations

import json

try:
    from factory_lib import load_json, repo_root, run_state_path
except (ImportError, SyntaxError):
    print(json.dumps({"continue": True}))
    raise SystemExit(0)

# Quiet by default: pr_ready.py is the deterministic artifact gate.
# This hook never blocks; at most it leaves a one-line reminder.
try:
    run_state = load_json(run_state_path(repo_root()), default={})
except (json.JSONDecodeError, OSError, TypeError, ValueError):
    print(json.dumps({"continue": True}))
    raise SystemExit(0)
if run_state.get("phase") == "implementing":
    print(json.dumps({
        "continue": True,
        "systemMessage": "Phase is implementing; artifacts may be incomplete — pr_ready.py is the gate.",
    }))
else:
    print(json.dumps({"continue": True}))
