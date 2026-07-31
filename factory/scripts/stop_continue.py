#!/usr/bin/env python3
from __future__ import annotations

import json

from factory_lib import load_json, repo_root, run_state_path

# Quiet by default: pr_ready.py is the deterministic artifact gate.
# This hook never blocks; at most it leaves a one-line reminder.
run_state = load_json(run_state_path(repo_root()), default={})
if run_state.get("phase") == "implementing":
    print(json.dumps({
        "continue": True,
        "systemMessage": "Phase is implementing; artifacts may be incomplete — pr_ready.py is the gate.",
    }))
else:
    print(json.dumps({"continue": True}))
