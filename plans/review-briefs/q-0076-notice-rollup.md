# Review brief — lite window Q-0076 (job completion notice: 'browser not used' + double-counted tool rows)

Facts (verified in prod events, run 161e4b5d):
- Two tool.activity events exist per gantry-owned call on the Claude-Agent SDK lane: the PostToolUse WRAPPER (tool=Browser|capability_run, family set, authoritative:false, invocationId toolu_*) and the GATEWAY event (tool=browser_act|browser_inspect|browser_open|<capability id>, authoritative:true, invocationId browser-*|capability-run-*).
- They never share an id: the Claude CLI builds hook tool_response from tool_result CONTENT blocks only, so the MCP result's top-level _meta.invocationId (withPrivateToolActivityInvocationId) never reaches query-tool-activity-hook on this lane. The private-id channel is retained for the inline lane; fixing the SDK-lane channel is OUT OF SCOPE — do not propose it.
- Every gateway outcome is mirrored by exactly one wrapper outcome of the same family and outcome; wrapper-only outcomes are failures that never reached the gateway (IPC timeout etc.).

Contract for this diff:
- browserUsed counts authoritative browser successes only (never phase 'browser_action', which nothing emits).
- Rollup: for families browser/capability render authoritative rows only; the count of wrapper failures minus authoritative failures (floored at 0) is rendered as ONE extra failed row per family ("failed before reaching the browser service"). Generic-family tools untouched.
- No change to event emission, ids, or the domain parser.

Focus: off-by-one in the remainder, ordering of the synthetic row among failed rows, the ×N label suffix rule (count 1 → no suffix), any path where a non-authoritative row of a gantry-owned family could still leak into the notice, and that the notification view limits/overflow still hold. Ignore style.
