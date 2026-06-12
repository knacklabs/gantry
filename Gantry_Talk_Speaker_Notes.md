# Gantry Talk — Speaker Notes

**Deck:** *Gantry — the agent runtime* · 16 slides + 1 backup
**Suggested length:** 12–15 min talk + Q&A
**Core message:** The agent is the easy part. The trustworthy *runtime* around it is the hard part — and that's Gantry.

> Delivery tips: one idea per slide, don't read the bullets. The two "by example" slides (8, 10–11) are your emotional anchors — slow down there. Numbers in `[brackets]` are verified against the codebase if someone digs in.

---

## Slide 1 — The agent is the new application core
**Time: ~45s. Tone: open strong, no jargon.**

Open with the thesis, not the product. "For thirty years we built software users had to come *to* — a site, an app, a login. Agents flip that: the software meets people where they already work — Slack, Telegram, their inbox." Pause. "When the agent becomes the front door, it becomes the new application core. And that changes what you have to build underneath it." Don't mention Gantry yet — earn it.

→ *Transition:* "But here's the honest part everyone skips."

---

## Slide 2 — The demo works. Production doesn't.
**Time: ~75s. Tone: candid, this is where you build trust.**

"Every agent demo works. Then you try to ship it to real users with real data — and it falls apart." Walk the list, but make each one a real failure, not a bullet: remembers the *wrong person's* data; can reach too many tools; give it shell access without a gate and your secrets are one prompt away; nobody approved that action; no audit trail when it goes wrong; it doesn't even know who it's talking to. "None of these are model problems. A smarter model doesn't fix any of them. These are *runtime* problems."

→ *Transition:* "Which means we're missing a layer of the stack."

---

## Slide 3 — The new full stack
**Time: ~60s.**

"We all know the stack: frontend, backend, database. When the agent is the core, there's a new layer — a runtime for the agent itself." Point to the four jobs of that runtime: memory, tools, gate, audit. "Channels bring people in, web surfaces the records, the database holds durable state and audit — and the agent runtime is the new piece that makes the rest safe to use."

> ⚠️ Caveat: this slide lists "Voice." Voice is **roadmap, not shipped** — say "voice-ready" or skip it. Slack, Teams, and Telegram are real today.

→ *Transition:* "So let me say plainly what Gantry is — and isn't."

---

## Slide 4 — What Gantry is
**Time: ~50s. Tone: slow, deliberate. This is your definition slide.**

Read the definition once, clearly: "an enterprise-grade agent runtime — the host process that gives AI agents a controlled place to run, people or applications to respond to, tools to use, durable memory, and an immutable audit trail." Then the disarming part: "It is *not* a chatbot. Not an LLM wrapper. Not a workflow engine." Pause. "It's the thing that sits underneath all of those and makes them safe."

→ *Transition:* "Here's the whole thing on one map."

---

## Slide 5 — The runtime map
**Time: ~75s. Tone: orient, don't itemize.**

Don't read every box — the audience will read. Trace the *flow* with your hand: "Humans and external systems and your own backend apps all come in on the left. Everything — everything — flows through one host process. A control server takes ingress, an orchestrator queues the conversation, a scheduler runs durable jobs, and agents run as *isolated, signed* runners." Land on the key design choice: "Notice the Model Gateway — it brokers credentials, so the provider keys never live inside the agent. And everything lands in a durable store: state, audit, job state." `[verified: spawned runners are isolated; gateway brokers model credentials]`

→ *Transition:* "The organizing idea that makes this work is one word: conversation."

---

## Slide 6 — Conversation is the runtime boundary
**Time: ~75s. Tone: this is the conceptual core — sell it.**

"This is the single most important idea in the talk. The *conversation* is the boundary. Every channel — Slack, Telegram, Teams, web, even a scheduled job — becomes a conversation." Then the payoff: "The agents themselves are **stateless**. Memory, approvals, audit — they don't live in the agent, they live with the conversation. A DM has your personal memory; a group or channel has shared memory. A scheduled job runs against the *same* memory boundary as the chat it belongs to. Approvals are controlled by the people in that conversation. And every run gets a *fresh* runner." `[verified: agents stateless, fresh runner per run, memory scoped to subject/conversation]`

→ *Transition:* "Let's watch one message travel through it."

---

## Slide 7 — Request lifecycle (one message, end to end)
**Time: ~60s.**

"Seven steps: message, queue, memory, runner, tools, audit, reply." Say it as a rhythm. The key line: "The same path serves a Slack message, a scheduled job, *and* an API request. Chat, cron, and API all run the identical pipeline — so whatever's true for safety in chat is automatically true for jobs and API calls too." `[verified: ingress → group queue → memory hydration → spawned runner → MCP tools → audit events → outbound delivery]`

→ *Transition:* "Abstract is boring. Let's make it concrete."

---

## Slide 8 — Request lifecycle by example
**Time: ~90s. Tone: this is a story — perform it, don't list it.**

Set the scene: "You're in Slack. You type: 'Post a quick launch tweet and tell the team in #general.'" Then walk the seven steps as a narrative: it arrives and gets attributed to *you*; it's handled in order; it already *remembers* you like short answers and that the product is 'Gantry 2.0'; it plans; it acts — writes the tweet, posts to #general; it records every action, and blocks anything disallowed; it replies in the same chat. Land the closer: "Notice there was no pause to 'consolidate memory.' Answering you is the *awake* part — it stays fast. The remembering happens later. That's deliberate."

> ⚠️ Wording: say "handled **in order**," not "waits its turn." Your backup slide explains a follow-up message usually *doesn't* wait — it's piped into the running agent. Keep the two slides consistent.

→ *Transition:* "That 'it remembers you' step is doing a lot of work. Let's open it up."

---

## Slide 9 — Memory isn't a bigger context window
**Time: ~90s. Tone: this is your most technically differentiated slide.**

"The lazy way to do agent memory is to stuff more transcript into the context window. We don't. Memory is **scoped, not stuffed**." Three points: it's scoped by app, agent, and user/conversation — so one person's memory can't leak into another's *by design*; the runner starts from compact **boundary digests**, not a transcript replay; and — the fun part — "it *dreams*. While it's idle, raw chatter gets distilled into durable memory through sleep-like passes: a light sweep, a REM cross-check for conflicts, and a deep pass that promotes only high-confidence facts." `[verified: subject scoping with no default fallback; digest-first hydration; dream phases light/rem/deep exist in code]`

> ⚠️ Soften "leakage is structurally impossible" → "leakage is prevented by construction." The sleep-phase one-liners are illustrative, not literal per-phase logic — fine to present, just know it.

→ *Transition:* "Let me show you memory being born — over two days."

---

## Slide 10 — Memory by example · Monday (capture)
**Time: ~75s. Tone: storytelling continues.**

"Monday. You ask for release notes, you say 'keep them short,' and you lock the product name: 'Gantry 2.0.' The chat ends — and here's the surprising part: **nothing is saved yet.**" Show the scratchpad: three *candidates*, each with a confidence score. "A memory starts as a candidate, not a fact." Then dreaming decides: 'prefers short answers' and 'name is Gantry 2.0' are confident and lasting → promoted. 'User is busy today' is transient and low-confidence → discarded. "The system forgets the noise on purpose." `[verified: candidate→promote pipeline; ~0.7 confidence threshold matches 0.50 discarded vs 0.90/0.95 promoted]`

→ *Transition:* "Now jump to Wednesday."

---

## Slide 11 — Memory by example · Wednesday (continuation)
**Time: ~75s. Tone: the payoff — let it land.**

"Two days later. Brand-new session — the agent's never seen this conversation. But *before* it reads your message, it gets a quiet briefing: the two memories that survived, tied to you." You type 'Write the launch announcement.' The agent replies — short, uses 'Gantry 2.0' without asking, picks up the launch thread. "It never re-asked the name. It stayed short. It continued where you left off — across a session boundary. *That's* the difference between memory and a big context window."

→ *Transition:* "Memory is one capability. Tools are the other — and tools are where things get dangerous."

---

## Slide 12 — Tools need a product contract
**Time: ~60s.**

"A tool in Gantry isn't just 'installed.' It goes through a contract: it's **requested, reviewed, approved, versioned** — and only then activated, on the next run." Trace it: a source (a skill, an MCP server, a CLI) becomes a reviewed capability; request, review, approval — and the critical rule — "approval **can't approve itself**." Every step is audited and versioned in config. "Capabilities don't just appear. Someone — not the agent — signs off." `[verified: capability changes go through reviewed runtime tools, not direct mutation; settings.yaml is source of truth]`

→ *Transition:* "Underneath both memory and tools is one security model."

---

## Slide 13 — Trust boundaries
**Time: ~75s. Tone: confident, this is the enterprise close.**

"The conversation is the security perimeter." Four guarantees: every tool call is gated by *who* (principal), *where* (conversation scope), and *what* (requested capability); provider keys **never reach the agent** — it only ever sees loopback gateway tokens; business-tool secrets are scoped per capability, not dumped into one big .env; and agents **cannot grant themselves approval**. "If you've ever worried about handing an agent your credentials — this is the slide that answers it." `[verified: gateway-brokered credentials, per-capability scoping, self-approval prevented]`

→ *Transition:* "So what does this actually let you build?"

---

## Slide 14 — Three shapes, one runtime
**Time: ~50s.**

"Three patterns: realtime chat, async jobs, and application action requests — your app asking the agent to *do* something. These aren't three products. Most real applications need all three at once. And they all share the same runtime — same memory scope, same gate, same audit." Tie back: "One safety model, three shapes."

→ *Transition:* "Let me be honest about the landscape."

---

## Slide 15 — The market, honestly
**Time: ~75s. Tone: fair, not dismissive — credibility comes from fairness.**

"Everyone runs agents now. The difference is the runtime *around* them." Be fair to each: the open-source option is capable but safety is yours to wire up; the NVIDIA-style stack ties you to their sandboxes; the Microsoft option is powerful but locks you into their identity and compliance world. "Gantry's bet is **provider-neutral**: scoped memory, approval gates, audit, and an embeddable API — runtime safety you own, not rent."

> ⚠️ These competitor names appear anonymized. Verify the real-world claims (and decide if the placeholder names are intentional) before any external audience.

→ *Transition:* "Which brings me back to where I started."

---

## Slide 16 — The thesis / Thanks
**Time: ~30s. Tone: land it, then stop talking.**

"The agent is the easy part. The runtime you can trust with a business is the hard part." Pause. "That's what we're building. Thanks — happy to take questions." Then *stop* — let the silence invite questions.

---

## Slide 17 — BACKUP · "What if I send two messages?"
**Only if asked. Time: ~60s.**

Pull this up if someone asks about concurrency or interruptions. "There's no countdown timer — it depends on what the agent's doing when your second message lands." Walk the table: still working on #1 → your follow-up is **piped into the live agent**, no wait; just finished but still idle (up to 30 min) → it slips into the same warm session; if a live hand-off can't happen (e.g. a different thread) → it waits for the current run to finish; nothing running → picked up on the next poll, ~2 seconds. "And several messages within ~2 seconds get bundled into one prompt." `[verified: live continuation/piping, ~30 min idle window, ~2s poll interval, ≤10 messages bundled]`

---

## Anticipated Q&A (keep in your back pocket)

- **"How is memory isolation actually enforced?"** Subject resolution has no default fallback — if the runtime can't identify whose memory it is, it *refuses* rather than guessing. Cross-user leakage isn't a policy, it's a structural default.
- **"What happens if dreaming hasn't run yet?"** Passively-learned facts stay as candidates until a dream pass promotes them — so they won't appear in a new chat immediately. If you want something remembered *now*, you tell the agent explicitly and it's saved directly. (Good honesty point — don't oversell.)
- **"Does this slow down responses?"** No — consolidation (dreaming) runs separately in the background, never in the reply path. Answering is the awake loop; dreaming is the asleep loop.
- **"Which channels are live today?"** Slack, Telegram, and Teams are implemented. Voice is roadmap.
- **"Why not just use a bigger context window?"** Context windows are per-session and get re-stuffed every time; they don't scope by user, don't survive cleanly across sessions, and don't forget noise. Scoped durable memory does all three.
