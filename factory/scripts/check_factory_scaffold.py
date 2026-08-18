#!/usr/bin/env python3
from __future__ import annotations

# UTF-8 console safety (standalone entrypoint — see factory_lib for rationale):
# force UTF-8 stdout/stderr so non-Latin-1 glyphs don't crash a cp1252 console.
import sys as _utf8_sys
for _stream in (_utf8_sys.stdout, _utf8_sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
required = [
    root / '.codex' / 'config.toml',
    root / '.codex' / 'explore.config.toml',
    root / '.codex' / 'hooks.json',
    root / 'factory' / 'prompts' / 'planner.md',
    root / 'factory' / 'prompts' / 'decomposer.md',
    root / 'factory' / 'prompts' / 'griller.md',
    root / 'factory' / 'prompts' / 'implementer.md',
    root / 'factory' / 'prompts' / 'reviewer.md',
    root / 'factory' / 'prompts' / 'tester-functional.md',
    root / 'factory' / 'schemas' / 'review.json',
    root / 'factory' / 'schemas' / 'test-automated.json',
    root / 'factory' / 'schemas' / 'test-functional.json',
    root / 'factory' / 'schemas' / 'decomposition.json',
    root / 'factory' / 'schemas' / 'roadmap.json',
    root / 'factory' / 'schemas' / 'grill.json',
    root / 'factory' / 'schemas' / 'signal.json',
    root / 'factory' / 'schemas' / 'lesson.json',
    root / 'factory' / 'scripts' / 'record_grill_from_json.py',
    root / 'factory' / 'scripts' / 'verify.py',
    root / 'factory' / 'scripts' / 'record_decomposition_from_json.py',
    root / 'factory' / 'scripts' / 'record_test_from_json.py',
    root / 'factory' / 'scripts' / 'forge.py',
    root / 'factory' / 'scripts' / 'record_signoff.py',
    root / 'factory' / 'scripts' / 'pre_compact.py',
    root / 'factory' / 'scripts' / 'check_dual_runtime.py',
    root / 'factory' / 'scripts' / 'check_repo_budget.py',
    root / 'factory' / 'skills' / 'rejected' / '.gitkeep',
    root / '.claude' / 'CLAUDE.md',
    root / '.claude' / 'settings.json',
    root / 'forge',
    root / '.claude' / 'skills' / 'forge' / 'SKILL.md',
    root / '.codex' / 'skills' / 'forge' / 'SKILL.md',
    root / 'factory' / 'skills' / 'forge.md',
    root / 'CLAUDE.md',
    root / '.codex' / 'agents' / 'planner-high.toml',
    root / '.codex' / 'agents' / 'docs-decomposer.toml',
    root / '.codex' / 'agents' / 'functional-checker.toml',
    root / 'constitution' / 'README.md',
    root / 'harness.yaml',
    root / '.envrc',
    root / '.gitattributes',
    root / 'WORKFLOW.md',
    root / 'docs' / 'FACTORY.md',
    root / 'docs' / 'QUALITY.md',
    root / 'docs' / 'ROLES.md',
    root / 'docs' / 'product' / 'README.md',
    root / 'docs' / 'product' / 'BRIEF.md',
    root / 'docs' / 'architecture' / 'README.md',
    root / 'docs' / 'decisions' / 'README.md',
    root / 'docs' / 'context' / 'README.md',
]
missing = [str(path.relative_to(root)) for path in required if not path.exists()]
if missing:
    print('Missing factory scaffold files:')
    for item in missing:
        print(f'- {item}')
    sys.exit(1)
print('Factory scaffold OK')
