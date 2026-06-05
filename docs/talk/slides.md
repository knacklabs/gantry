# Gantry Meetup Talk — Slides

On-screen text only. Deliberately sparse — the slide is a backdrop; the talking happens
out loud (see `script.md`). Visuals are briefed in `visuals.md`.

Target: ~22 minutes, comparison slide capped at 4 minutes.

---

### Slide 1 — The new application core

> **The agent is the new application core.**
>
> Users shouldn't have to travel to your software.
> It should meet them where they already work.

*Visual: conceptual hero (visuals.md → AI-1)*

---

### Slide 2 — The demo works. Production doesn't.

> **Every agent demo works.
> Then you try to ship it.**
>
> - It remembers the wrong person's data
> - It has root on your tools
> - Give it a shell, and your secrets are one injection away
> - Nobody approved that action
> - No audit trail when it goes wrong
> - It doesn't know who it's talking to

*Visual: AI-2 (optional mood image) or plain type*
*Backing (speaker reference): the secrets risk is NOT universal — a text-only agent can't
leak a key it never sees. It applies to agents with shell/file/system access (the autonomous
class). OWASP LLM Top 10 2025 — LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure.*

---

### Slide 3 — The new full stack

> **Frontend. Backend. Database.**
> **— and now a runtime for the agent.**
>
> The agent runtime sits at the center.
> Web surfaces become the system of record.
> Channels are where users actually are.

*Visual: `docs/talk/assets/diagram-01-new-full-stack.png`*

---

### Slide 4 — What Gantry is

> *"Gantry is an enterprise-grade agent runtime: the host process that gives
> AI agents a controlled place to run, people or applications to respond to,
> tools to use, durable memory, and an immutable audit trail.*
>
> *It is not a chatbot. It is not an LLM wrapper. It is not a workflow engine."*
>
> — README, verbatim

---

### Slide 5 — The runtime map

> **One Node.js process. Everything flows through it.**

*Visual: `docs/talk/assets/diagram-02-runtime-map.png`*

---

### Slide 6 — One message, end to end

> **Message → queue → memory → runner → tools → audit → reply**
>
> Same path for a Slack message, a cron job, and an API call.

*Visual: `docs/talk/assets/diagram-03-message-lifecycle.png`*

---

### Slide 7 — Memory isn't a bigger context window

> **Memory is scoped, not stuffed.**
>
> - Scoped by app, agent, and subject — leakage is structurally impossible
> - Digest-first: the runner starts with a summary, not a transcript
> - It "dreams": Light Sleep → REM → Deep Sleep turns chatter into durable memory

*Visual: `docs/talk/assets/diagram-04-memory-dreaming.png`*

---

### Slide 8 — Tools need a product contract

> **A tool isn't "installed." It's requested, reviewed, approved, and versioned.**
>
> source → capability → grant
> request → review → approval → audit → next-run activation
>
> An agent can ask for a new tool. It can't give itself one.

*Visual: `docs/talk/assets/diagram-05-tool-lifecycle.png`*

---

### Slide 9 — Trust boundaries

> **The conversation is the security perimeter.**
>
> - Every tool call passes a two-axis gate: *who's asking* and *what they're asking for*
> - Provider keys never reach the agent — only loopback gateway tokens
> - Secrets are scoped per capability, not dumped in one .env
> - Agents cannot grant themselves approval

*Visual: AI-3 (conceptual) or plain type*

---

### Slide 10 — Three shapes, one runtime

> **Realtime chat. Async jobs. Application action requests.**
>
> Not three products — three patterns most real apps use at once.
> Same runtime. Same scoped memory. Same gate. Same audit trail.

*Visual: `docs/talk/assets/diagram-06-three-patterns.png`*

---

### Slide 11 — The market, honestly

> **Everyone runs agents. The difference is the runtime around them.**
>
> - **OpenClaw** — open-source, self-hosted personal agent. Capable; safety is yours to set up.
> - **NemoClaw** — NVIDIA blueprints for a local, "more secure" always-on agent (OpenShell sandbox).
> - **Microsoft Scout** — built on OpenClaw, wrapped in Microsoft 365 identity and governance.
> - **Gantry** — safe by default, walled per user, embeddable through an API. Runs anywhere.

*Visual: `docs/talk/assets/diagram-07-market-map.png` — 4-column positioning, NOT the editorial Bad/Good matrix*

---

### Slide 12 — The thesis

> **The agent is the easy part.**
> **The runtime you can trust with a business is the hard part.**

*Visual: AI-4 (conceptual closer)*
