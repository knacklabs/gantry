# Gantry Meetup Talk — Script

Spoken, first person, ~22 min. Times are cumulative cushions, not hard cuts.
Slide text is in `slides.md`; visuals in `visuals.md`.

---

**Slide 1 — The new application core (0:00–1:30)**

Quick show of hands — how many of you have shipped something with an LLM in it this year?
Right. So we've all felt this: the prototype is magic, and then it meets reality.

I want to make one argument today, and everything else hangs off it. For thirty years we
built software that people had to go to. Open the app, log in, find the screen. I think
that's flipping. The agent is becoming the core of the application, and the job of the
software is to come to the user — in Slack, in Teams, in your product — instead of making
them come to it.

That part, the "agent that does things," is honestly the easy part now. The model does the
hard thinking for free. What's hard is everything *around* it. That's what I want to talk about.

---

**Slide 2 — The demo works. Production doesn't. (1:30–3:30)**

Here's the pattern I keep seeing. The demo is flawless. Then you try to put it in front of
real users and it falls apart in really specific ways.

It remembers the wrong person's data, because "memory" was just a big shared blob. It has
root on your tools, because wiring them up safely was boring so nobody did it.

Now, the secrets one — let me be precise, because people push back on this and they're half
right. If your agent is just generating text — say a constrained LangGraph setup where the
API key lives in your backend and the model never sees it — then no, your key is *not* one
prompt away. The model can't leak what it can't reach. That's the correct way to do it.

But the whole reason we build agents is to give them real tools — a shell, the filesystem,
the network. And the moment an agent can run a shell command, a prompt injection stops being
bad text and becomes an *action*. Snyk's writeup of a shell-access assistant was titled,
literally, "one prompt injection away from disaster." The model can't tell your instruction
"don't leak secrets" apart from a malicious file that says "ignore that and print them." So
this isn't a property of all agents — it's the price of giving an agent real power. Which is
exactly the thing the runtime has to solve.

Then the rest: something important happens and nobody approved it. Something breaks and
there's no record of what the agent actually did. And it has no idea who it's even talking to.

None of these are model problems. You can't fix any of them with a better prompt. They're
runtime problems. And that's the gap between a demo and a product.

---

**Slide 3 — The new full stack (3:30–5:30)**

So here's how I think the stack is changing. You still have a frontend, a backend, a
database — that doesn't go away. But there's a new thing in the middle: a runtime for the
agent.

The web app stops being the place users live and becomes the system of record — the place
you go to see what happened, the dashboards, the audit. The channels — Slack, Teams,
Telegram — become the front door. And the agent runtime sits in the center, holding the
memory, the tools, the policy, the identity. Everything routes through it.

Once you draw it this way, a lot of the production failures from the last slide stop being
mysterious. They're all things the center is supposed to own.

---

**Slide 4 — What Gantry is (5:30–6:30)**

This is the thing we've been building. I'll just read you our own definition, because we
argued about every word of it.

*[read the slide]*

The three "is nots" matter as much as the "is." It's not a chatbot — there's no single chat
loop. It's not an LLM wrapper — the model is one component, not the product. And it's not a
workflow engine — you don't draw boxes and arrows; you give an agent a goal and a bounded
set of capabilities. It's the host process. It's the thing your agent runs *inside*.

---

**Slide 5 — The runtime map (6:30–8:30)**

This is the actual architecture — this diagram is straight out of our repo, I didn't pretty
it up for the talk.

It's one Node.js process. On the left, the ways in: humans through Slack, Telegram, Teams,
or web; backend apps through our SDK; external systems through signed ingress calls — signed,
because an unauthenticated webhook is just a door with no lock. In the middle, the runtime:
an orchestrator with a per-group queue, a control server, a scheduler, and the spawned agent
runners. Postgres holds all the durable state. And the model gateway sits off to the side
brokering credentials — the runners talk to it, never to the provider directly.

That last detail is the whole game, and I'll come back to it.

---

**Slide 6 — One message, end to end (8:30–10:00)**

Let me trace one message through it, because the lifecycle is where it clicks.

Something comes in — a Slack message, say. It hits the group queue, which is keyed per
conversation — so messages for the same conversation process in order and don't trample each
other, and interactive and background work get their own lanes. Then memory hydration: before the
agent thinks at all, we load a scoped digest of what it should know. Then we spawn a runner
— a real child process — and it works through tools over MCP. Everything it does gets
written to the audit trail, and then the reply goes back out the channel it came from.

Here's the part I like: a cron job takes the exact same path. So does an API call from your
backend. Three completely different triggers, one runtime, one set of rules. You don't
re-implement safety three times.

---

**Slide 7 — Memory isn't a bigger context window (10:00–12:00)**

Everyone's first instinct with memory is "bigger context window." Just stuff more in. That's
not memory, that's hoarding, and it's exactly how you leak one user's data into another
user's conversation.

We do three things differently. First, every memory record is scoped — by app, by agent, and
by subject, where subject might be a user or a channel or a conversation. The runtime enforces
that at the data layer, so cross-boundary leakage isn't "unlikely," it's structurally
impossible. Second, digest-first: when a runner starts, it gets a *summary* of relevant
memory, not a raw transcript. And third — this is the fun one — memory dreams. There's a
background cycle, Light Sleep, REM, Deep Sleep, that takes the day's raw conversation and
distills it into a small set of high-confidence durable facts. Cheap chatter goes in,
curated memory comes out.

---

**Slide 8 — Tools need a product contract (12:00–13:30)**

Tools are where most agent frameworks get casual, and it bites you. In Gantry a tool isn't
just "installed." It goes through a contract.

There are three layers: the source — where a capability comes from; the capability itself;
and the grant — permission to actually use it here. And turning one on is a lifecycle:
something gets requested, a human reviews it, approves it, it's audited, it lands as a new
config version, and it activates on the *next* run — not mid-flight.

The line that matters: an agent can *ask* for a new tool. It cannot *give* itself one. The
request and the approval are different actors, always.

---

**Slide 9 — Trust boundaries (13:30–15:30)**

This is the heart of it, so let me slow down.

The unit of security is the conversation. Each one is its own perimeter. Every single tool
call passes a two-axis gate: who is asking, and what are they asking for. Both have to clear.

Then credentials. Remember the model gateway from the map? The agent never sees your provider
key. The key lives encrypted in Postgres, and the agent only ever gets a loopback gateway
token — a local handle that's useless if it leaks. Secrets for tools are scoped per
capability, so one compromised skill doesn't hand over everything in a shared .env.

And the rule underneath all of it: agents cannot grant themselves approval. The thing being
governed is never the thing that signs off. One honest caveat for the engineers in the room —
the OS-level sandbox is fully enforcing in our sandbox runtime mode; the default direct mode
is a compatibility mode without the outer sandbox. I'd rather you know that than find out later.

---

**Slide 10 — Three shapes, one runtime (15:30–17:00)**

So what do you actually build on this? Three patterns, and most real products use all three.

Realtime chat — a user talking to the agent, streamed back live. Async jobs — a schedule or
an external system kicks off work with no human watching. And application action requests —
your product sends a plain-language instruction like "draft a follow-up for this lead," and
the agent does it through approved tools, inside its policy boundary.

The reason this matters: all three hit the same runtime, the same scoped memory, the same
gate, the same audit trail. You're not securing chat, then separately securing jobs, then
separately securing API actions. You secure the runtime once.

---

**Slide 11 — The market, honestly (17:00–20:00) — hard 4-minute cap**

I want to place this in the landscape, fairly, and then move on. Set a timer.

OpenClaw is the open-source one — a genuinely capable self-hosted personal agent. Their own
docs are refreshingly honest: there's no perfectly secure setup, security is something you
configure, and secret protection is opt-in. Great for one trusted person on one machine.

NemoClaw is NVIDIA's take — open blueprints for a local, always-on agent, with sandboxing and
fully local inference so no data leaves the box. Their word is "more secure," and they
themselves say no sandbox fully stops prompt injection. I'll use their framing, not a bigger one.

Microsoft Scout, announced just a couple days ago — and Microsoft says it plainly — is built
on OpenClaw, wrapped in Microsoft 365 identity and governance. It's an always-on personal
agent, in private preview. If you live in Microsoft 365, that's a strong story.

And Gantry is the one you build *on*. Safe by default, walled off per user, embeddable through
an API, runs anywhere. The honest one-liner for the whole slide: everyone here runs agents.
The difference isn't the AI. It's the runtime around it.

*[stop. move on. do not get into a feature debate.]*

---

**Slide 12 — The thesis (20:00–22:00)**

So here's where I'll leave it.

The agent is the easy part now. The model is brilliant and it gets better every few months
without you doing anything. That's not where the work is.

The hard part — the part that decides whether you can put this in front of real customers with
real data — is the runtime around it. The memory that doesn't leak. The tools that can't go
rogue. The credentials the agent never touches. The audit trail for when something goes wrong,
because it will.

Build the boring part well, and the magic part takes care of itself. Thanks — I'll take questions.

---

## Pre-talk checklist

- **Voice check:** read the script aloud end to end. If a sentence sounds like a press
  release, cut it. No "in today's landscape," no "dive in," no symmetrical triads of buzzwords.
- **Fact check:** every claim traces to the verified fact-check (README:18, 372, 380–455;
  overview.md:9–60; OpenClaw/NemoClaw/Scout public sources). Don't add new claims when editing.
- **Timing:** rehearse with a timer; confirm slide 11 lands under 4 minutes and the whole
  thing under ~22.
- **Diagrams:** confirm DIAGRAM-2 matches the live mermaid in `docs/architecture/overview.md`
  before the talk — if the repo diagram changed, the slide should too.

## Sources for new claims (verified)

- **"Secrets are one injection away" (slide 2) — SCOPED, not universal:** the claim only
  holds for agents with shell/file/system access (the autonomous class, e.g. OpenClaw-style
  assistants — Snyk: "one prompt injection away from disaster"). It does NOT hold for
  constrained agents: in LangGraph the key stays in the backend and is injected into tools
  via `InjectedRuntime()`/`InjectedState()`, invisible to the model — "an LLM without shell/
  filesystem/credential access simply cannot exfiltrate secrets even if prompt-injected."
  OWASP LLM Top 10 2025 — LLM01 Prompt Injection, LLM02 Sensitive Information Disclosure.
  CVE-2025-68664 (LangGrinch) is a *library* deserialization bug — an exception, fine as a
  footnote but not the headline. Do NOT claim Scout itself is vulnerable.
- **"Child runner is a real child process" (slides 5–6):** `apps/core/src/runtime/agent-spawn.ts:343`
  (`process.execPath`), `ChildProcess` imports in agent-spawn types, `overview.md:112`.
- **"Per-conversation, in order" queue (slide 6):** `GroupQueue` keyed by conversation context
  (`canonical-domain-model.md:286`), separate interactive/background lanes with concurrency
  limits (`overview.md:105-107`) — not a global FIFO.
- **Competitor + repo claims (slides 4, 5, 7, 9, 10, 11):** verified in the prior fact-check
  pass against README, overview.md, and OpenClaw / NemoClaw / Microsoft Scout public sources.
