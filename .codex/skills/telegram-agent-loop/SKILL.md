---
name: telegram-agent-loop
description: Use when Codex must drive a Kai or Telegram-hosted agent test through Chrome, send prompts in a visible Telegram topic, monitor responses like a user, iterate with follow-up instructions, and cross-check MyClaw CLI/runtime evidence until the agent certifies a job or issue as fixed.
---

# Telegram Agent Loop

Use this skill for operator-style verification loops where a remote agent in Telegram must run or certify a MyClaw job.

## Ground Rules

- Use the `chrome:Chrome` skill and the existing Chrome/Telegram tab for Telegram only.
- Do not use Chrome, CDP, or the Telegram browser profile as the MyClaw job Browser. If the tested job needs Browser, instruct the agent to use MyClaw Browser tools and the job's MyClaw profile.
- Interact with Telegram like a user: read the visible thread, focus the message box, paste or type the prompt, send it, and watch the visible status.
- Keep messages concise and action-oriented. Include exact job ids, run ids, expected tools, and acceptance criteria.
- Treat the Telegram agent's report as a claim. Cross-check it with local MyClaw CLI/runtime evidence before calling the issue fixed.

## Loop

1. **Open and orient**
   - Claim the existing Telegram tab through Chrome.
   - Verify the visible topic is the intended Kai group/topic before sending.
   - Read the latest visible messages so the follow-up matches current state.

2. **Send the instruction**
   - Use the visible Telegram composer, not hidden APIs.
   - State what the agent must do, how to avoid browser/profile mixing, and what proof to report.
   - Include pass/fail criteria: terminal status, run id, event ids, required tools, tool activity, browser activity, and exact blocker text if failed.

3. **Monitor**
   - Wait for visible status changes such as queued, working, running, completed, or failed.
   - Poll local evidence in parallel with CLI commands such as:
     - `node dist/cli/index.js jobs show <job_id>`
     - `node dist/cli/index.js jobs events <job_id> --run <run_id> --limit 30`
   - Prefer local runtime events for factual state; use Telegram for agent reasoning and certification.

4. **Intervene only on concrete gaps**
   - If the job is ready but paused, tell the agent to resume and run now.
   - If tool activity is missing, ask the agent to exercise the required tool and report the event id.
   - If Browser setup is required, tell the agent to use the MyClaw Browser profile shown by readiness, never the Chrome/Telegram tab.
   - If credentials are needed, tell the agent to use the approved credential path without printing secrets.

5. **Certify**
   - Accept certification only when the agent report and local evidence agree.
   - Required proof for scheduled jobs: job visible, run produced, terminal status known, required tool preflight persisted, Browser either used or explicitly blocked, and no generic timeout without diagnostics.
   - If the agent reports success but local events disagree, send a corrective follow-up with the mismatch.

## Follow-Up Template

```text
Current local evidence:
- Job status: <status>
- Run id: <run_id or none>
- Latest event ids: <ids>
- Missing proof: <gap>

Continue from here. Do not restart from scratch unless the current run is terminal. Use the visible MyClaw/Kai workflow, report exact event ids, and stop only when the job is terminal and certified.
```
