# ASKFLOOR-1 spec validation (read-only, no edits, keep reading TIGHT)

Adversarially validate the draft spec `docs/specs/askfloor-1-judge-actually-judges.md` (fall back to any `docs/specs/askfloor-1*.md`) against the actual codebase. Scope is small; answer fast. The spec makes auto-mode first-asks context-aware for gantry-native tools without touching the autonomous lane.

Verify with file:line evidence:
1. **send_message destination-awareness.** Where the EXTERNAL_MUTATION bucket fires (`application/permissions/gantry-tool-risk.ts`), where the tool input's destination (jid/conversation) is available at classification time, and whether the conversation-route registry (the approver-gate authority) is reachable from that seam WITHOUT new plumbing. Is "registered owned route ⇒ low" implementable deterministically there? Any spoofing risk (agent-supplied jid that LOOKS registered)?
2. **browser_* action-awareness.** The `browser_` high-default and its ponytail comment; the set of browser action verbs/tools that exist; which are provably non-mutating; whether argument shapes make read-vs-mutate deterministic. Cite the browser tool dispatch surface.
3. **Read-only gate widening.** What `evaluateAutoPermissionReadOnlyGate` covers today and the concrete proven-read cases it misses (reviewed MCP read bindings pattern).
4. **Blast-radius honesty.** Confirm AC3's byte-for-byte claims are enforceable: autonomous lane (0121), ask mode, auto_strict, YOLO backstop, unmapped/scheduler/admin/destructive asks — name any code path where this story's changes could leak into them.
5. **Decision hygiene.** Does this need a decision record amending anything (0043 risk-only, #212 posture), or is it pure calibration inside the existing contract?

Output: numbered findings — claim, file:line, severity (blocker | design-gap | nit), smallest spec amendment. End with: implementable as written? No edits anywhere.
