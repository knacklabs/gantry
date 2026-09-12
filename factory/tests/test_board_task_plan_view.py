"""The task-plan view in the board drawer.

A reader of a long task plan needs two things: no progress bar above the
text (it reported the step in flight, which is not what they opened the plan
for), and a poll-driven refresh that does not throw them back to the top.

String checks on the page source: the board has no JS test runner. They pin
the mechanism -- the repaint path compares markup and restores the body's
scroll offset -- not the behaviour in a browser.
"""
from __future__ import annotations

from test_gates import HARNESS  # noqa: F401

PAGE = (HARNESS / "factory" / "board" / "index.html").read_text(encoding="utf-8")


def test_the_task_plan_view_has_no_progress_bar():
    assert "taskProgress" not in PAGE
    assert "task-progress" not in PAGE and "tp-bar" not in PAGE
    assert "Nothing in flight" not in PAGE


def test_a_poll_driven_repaint_keeps_the_readers_place():
    # Same markup: no repaint at all. Different markup: repaint, then put the
    # body back where it was. Only the poll path asks for this; opening a
    # story or switching a tab still starts at the top.
    assert "function paintDrawer({keepScroll = false} = {})" in PAGE
    assert "if (keepScroll && html === paintedDrawer) return;" in PAGE
    assert 'panel.querySelector(".panel-body").scrollTop = scrollTop' in PAGE
    assert PAGE.count("paintDrawer({keepScroll: true})") == 1

def test_the_page_polls_every_ten_seconds_and_never_stacks_drawer_requests():
    assert "const POLL_LIVE = 10000, POLL_IDLE = 20000;" in PAGE
    assert "stateIsHot(lastState) ? 30 : 45" in PAGE
    assert "if (drawerFetching) return;" in PAGE
    assert "finally { drawerFetching = false; }" in PAGE
