"""A rendered contract block must not stale the approval it is excluded from.

`render_task_contract_block` appends a harness-generated block to the task plan
and the block itself tells the reader it is "excluded from the plan's approval
and grill digests, so a re-render never stales either".

It was not excluded. `strip_derived_sections` substitutes a newline for the
block, and the block is appended after one, so stripping left one MORE trailing
newline than the file carried before the block existed. `plan_body_digest`
hashed that one byte, so the first render changed the digest and `task approve`
refused with "the plan CHANGED after <name> approved it" against authored text
that was byte-identical. It fires at the last gate before a PR, and the message
sends the reader hunting for a content change that never happened.
"""
from __future__ import annotations

import hashlib

from test_gates import repo  # noqa: I001 — puts factory/scripts on sys.path
from factory_lib import (  # noqa: E402
    CONTRACT_BLOCK_END, CONTRACT_BLOCK_START, plan_body_digest,
)

__all__ = ["repo"]

PLAN = """---
issue: STORY-1
story: STORY-1
decisions_reviewed: []
---

# STORY-1-T1 — a task

## Problem

Something needs doing.
"""

BLOCK = f"""
{CONTRACT_BLOCK_START}
## Contract (recorded)

Rendered by the harness from the recorded decomposition.
{CONTRACT_BLOCK_END}
"""


def test_rendering_the_contract_block_does_not_change_the_plan_digest(repo):
    path = repo / "plan.md"
    path.write_text(PLAN, encoding="utf-8")
    before = plan_body_digest(path)

    path.write_text(PLAN + BLOCK, encoding="utf-8")

    assert plan_body_digest(path) == before


def test_re_rendering_a_changed_contract_block_still_does_not_change_it(repo):
    """A scope widening re-renders the block; approval must survive that."""
    path = repo / "plan.md"
    path.write_text(PLAN + BLOCK, encoding="utf-8")
    before = plan_body_digest(path)

    wider = BLOCK.replace("Rendered by the harness", "Rendered, now with 19 files")
    path.write_text(PLAN + wider, encoding="utf-8")

    assert plan_body_digest(path) == before


def test_an_authored_edit_still_changes_the_digest(repo):
    """The exclusion must not swallow a real change to the authored body."""
    path = repo / "plan.md"
    path.write_text(PLAN + BLOCK, encoding="utf-8")
    before = plan_body_digest(path)

    path.write_text(PLAN.replace("Something needs doing.", "Something else.") + BLOCK,
                    encoding="utf-8")

    assert plan_body_digest(path) != before
