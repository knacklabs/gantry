#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[2]
required = [
    root / '.codex' / 'config.toml',
    root / '.codex' / 'explore.config.toml',
    root / '.codex' / 'hooks.json',
    root / '.agents' / 'prompts' / 'planner.md',
    root / '.agents' / 'prompts' / 'decomposer.md',
    root / '.agents' / 'prompts' / 'griller.md',
    root / '.agents' / 'prompts' / 'implementer.md',
    root / '.agents' / 'prompts' / 'reviewer.md',
    root / '.agents' / 'prompts' / 'tester-functional.md',
    root / '.agents' / 'schemas' / 'review.json',
    root / '.agents' / 'schemas' / 'test-automated.json',
    root / '.agents' / 'schemas' / 'test-functional.json',
    root / '.agents' / 'schemas' / 'decomposition.json',
    root / '.agents' / 'schemas' / 'roadmap.json',
    root / '.agents' / 'schemas' / 'grill.json',
    root / '.agents' / 'schemas' / 'signal.json',
    root / '.agents' / 'schemas' / 'lesson.json',
    root / '.agents' / 'scripts' / 'record_grill_from_json.py',
    root / '.agents' / 'scripts' / 'verify.py',
    root / '.agents' / 'scripts' / 'record_decomposition_from_json.py',
    root / '.agents' / 'scripts' / 'render_linear_task_graph.py',
    root / '.agents' / 'scripts' / 'record_test_from_json.py',
    root / '.agents' / 'scripts' / 'forge.py',
    root / '.agents' / 'scripts' / 'record_signoff.py',
    root / '.agents' / 'scripts' / 'pre_compact.py',
    root / '.agents' / 'scripts' / 'check_dual_runtime.py',
    root / '.agents' / 'scripts' / 'check_repo_budget.py',
    root / '.agents' / 'skills' / 'rejected' / '.gitkeep',
    root / '.claude' / 'CLAUDE.md',
    root / '.claude' / 'settings.json',
    root / 'forge',
    root / '.claude' / 'skills' / 'forge' / 'SKILL.md',
    root / '.codex' / 'skills' / 'forge' / 'SKILL.md',
    root / '.agents' / 'skills' / 'forge.md',
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
