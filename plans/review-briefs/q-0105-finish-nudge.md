# Review brief — lite window Q-0105 (one-shot nudge when a scheduled run ends without its Outcome line)

Facts: runs 790aecae (16:02Z) and 8169590a (01:50Z) ended with exit 0 mid-work — the model narrated an action ("Let me close the browser and write Lead 1.") without calling the tool, the SDK emitted a result, and the run was reported completed with work lost and no `Outcome:` line (the contract appended to every scheduled run prompt).

Contract for this diff (runner, SDK lane only):
- In the `result` branch, for scheduled runs only, if the visible assistant text since the last result lacks `/\bOutcome:/i` and no nudge has been sent this run, push ONE follow-up through the existing steering gate so the query continues; mark nudged. Never for non-scheduled runs, never twice, never after close.
- Output shape unchanged (`continuedByFollowup` already exists). One INFO log line.

BY DESIGN: a run that genuinely finished but forgot the line gets one extra short turn to add it. Focus: no nudge loop; no nudge on error results (the failure path throws before this); the follow-up is delivered at the turn boundary, not mid-tool. Ignore style.
