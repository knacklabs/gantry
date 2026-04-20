# MyClaw Talk — Speaker Notes (final)

> 30-minute session. Engineering students and early developers.
> 10 slides + Q&A. ~23 min speaking, ~7 min Q&A.
> Plain English. Analogies first, jargon second. Teach *how to think* about tradeoffs, not just what was built.

---

## Slide 1 — Title (0:30)

> "I'm [name]. For the next half hour I'm going to walk you through seven design decisions I made while building a personal AI assistant. I'm going to try to show you not just *what* I built, but *how I thought about each choice* — because that's the useful part if you're going to build your own.
>
> Questions at the end."

Move on. Don't linger.

---

## Slide 2 — Why I built this (2 min)

> "Quick story, then we get into the engineering.
>
> I wanted an AI assistant I could talk to on Telegram. Reminders, research, questions, little coding tasks — the stuff you might have a smart friend help with.
>
> Claude's best model is Opus. Opus is also the expensive one. For my actual usage pattern — lots of conversation, tool calls, long context — running that on the API came out to roughly two thousand dollars a month.
>
> I'm not paying two thousand dollars a month for a personal tool. Probably none of you are either. So the whole project is organized around one question: **how do you get Opus-quality behavior without an Opus-sized bill?**
>
> That question shaped every decision I'm about to show you."

Keep this slide tight. Do NOT get into OAuth or subscription policy. If someone asks in Q&A you have the full answer ready, but for the talk itself the economics story is about the API bill.

---

## Slide 3 — The bet (2.5 min)

**On screen:**

```
Most agent tools:
  "Claude is an API I call."
  (Everything else is their code —
   the agent loop, tools, memory, skills.)

MyClaw:
  "Claude Code is the agent.
   I just added Telegram and Memory."
```

**Spoken:**

> "First choice, the one everything else depends on. Quick terminology so we're on the same page. When I say **Claude**, I mean the model — the thing you send prompts to, that sends text back. When I say **Claude Code**, I mean the agent Anthropic built on top of that model — the CLI tool, the skill system, the `CLAUDE.md` pattern, the permission hook. Two different things.
>
> Most agent tools take Claude the model and build an agent on top. Their own loop. Their own tool handling. Their own skill system. Their own permission layer. Everything from the API up is their code.
>
> I skipped that whole layer. MyClaw uses **Claude Code** as its engine — specifically, a library called the Claude Agent SDK, the same library Claude Code itself runs on. So I didn't write an agent loop. I didn't write a tool dispatcher. I didn't write a skill system.
>
> What I added on top is just **two things: Telegram and memory.** Telegram is how messages get in and out. Memory — we'll get to this near the end — is how the agent remembers you across conversations, because that's the one thing Claude Code doesn't ship.
>
> Every decision in the next seven slides follows from that split: **Claude Code does the agent work. MyClaw does the chat surface and the memory.**"

**If asked in Q&A "why not just use the Claude Code CLI directly as a subprocess?":**
"Considered it. The CLI is made for terminal stdin/stdout. Capturing streams cleanly across many concurrent chats has rough edges. The SDK gives me the same primitives with a proper Node API."

**Speaker-reference file:**
- `packages/agent-runner/src/index.ts:508` — the `query()` call that IS the agent

---

## Slide 4 — Every chat gets its own folder (2.5 min)

> "First decision that falls out of the bet: **every conversation gets its own folder on disk.**
>
> If you've used git, you already know this pattern. A git repo is just a folder with files in it. Here, every Telegram group, every Slack channel, every DM — gets its own folder. Inside that folder: a `CLAUDE.md` which tells the agent what this conversation is about. A `SOUL.md` which tells it who the agent is here. And a workspace where the agent can write files it cares about.
>
> The agent's working directory *is* that folder. So when you say 'save this as a draft,' it writes a file right there. When I come back tomorrow, the file is still there. When the agent looks around — `ls` — it sees the context of this specific conversation.
>
> Why is this good? Two reasons.
>
> One: conversations don't step on each other. The agent for my personal chat never sees files from the agent for my work chat. Real separation, done the easiest possible way — by giving them different folders.
>
> Two: if you've used Claude Code in a code repo, this is the exact same pattern. Which means every primitive Anthropic built for Claude Code — skills, subagents, `CLAUDE.md` — just works. I didn't reinvent isolation; I borrowed Claude Code's model and pointed it at a chat folder instead of a code folder."

**Speaker-reference files:**
- `apps/core/src/runtime/prompt-profile.ts:14` — SOUL filename constant
- `~/myclaw/agents/<group>/` — the actual per-group folder on disk

---

## Slide 5 — Chat that continues (2.5 min)

> "Second decision. This is the part most people get wrong when they build chat agents.
>
> When a message arrives, does the agent already exist, or does it start from scratch? Most naïve setups pick one extreme. Either keep one giant long-running agent process for everything — fragile, leaky, memory grows forever — or spin up a fresh agent for every single message — clean but slow and expensive because you re-load everything each time.
>
> I picked something in between. **A conversation gets an agent. The agent lives for the conversation.**
>
> First message in a conversation? A fresh Node process starts. It loads the system prompt, pulls up memory, warms the cache, answers.
>
> Second message, thirty seconds later? The same process is still alive, waiting. It picks up your follow-up without reloading anything. Context is still in memory. The prompt cache on Anthropic's side is still warm. Memory brief is still loaded. So the second message is both faster *and* cheaper than the first.
>
> Silent for a while? The process exits cleanly. Next time you message, fresh start.
>
> That's the best of both. Isolation when it matters — a crash in one chat can't take down another. Continuity when *it* matters — follow-up messages feel like a real conversation, not a series of cold starts.
>
> Under the hood it's simple. The host writes your follow-up into an `input/` folder the agent is watching. When it's time to shut the agent down, the host drops in a zero-byte `_close` file and the agent sees it and exits. No sockets, no signals — just files."

**Speaker-reference files:**
- `apps/core/src/runtime/agent-spawn-process.ts:77-89` — spawn + stdin handshake
- `apps/core/src/runtime/group-queue.ts:257-296` — follow-up delivery + `_close` sentinel
- `apps/core/src/runtime/agent-spawn.ts:48-76` — 15-key env allowlist (no ambient credential leak)

**If asked "why not a worker thread pool?":**
"OS-level isolation. A real process means a real crash boundary. Worker threads share memory with the host; a bad state in a worker can corrupt the host. Processes don't have that problem."

---

## Slide 6 — The two halves talk through files (2.5 min)

> "Third decision. The host and the agent are two separate processes. How do they talk?
>
> Normal answers: sockets, pipes, a message queue. Something with a proper protocol.
>
> My answer: **the filesystem.**
>
> When the agent wants to send a reply, it writes a JSON file. When it wants to look up a memory, it writes a JSON file. When it needs permission to do something, it writes a JSON file. The host watches a folder. When a new file shows up, the host reads it and does something.
>
> It sounds dumb. It's actually really nice.
>
> Because you can `tail -f` the folder and literally watch the agent think. Every thought it has appears as a file on your disk. When something breaks, you `ls` the folder. The broken file is right there. No packet captures, no WebSocket debuggers — just files.
>
> Of course you have to get a couple of details right. You don't want the host to read a file while the agent is still writing it. So the agent writes to a temp name first, then renames — the rename is atomic on every sane filesystem. You don't want one agent to read another agent's mail, so each group has its own secret token stamped on its files. And you don't want a broken agent to flood the disk, so I cap it at 300 messages per minute.
>
> For a personal assistant, this is perfect — simple, debuggable, and it survives crashes because files don't disappear when processes die. At a million users per day, I'd pick something else. Different tool for a different scale."

**Speaker-reference files:**
- `packages/agent-runner/src/ipc-mcp-stdio.ts:38-52` — atomic write via temp + rename
- `apps/core/src/runtime/ipc-auth.ts:1-32` — per-group secret token (HMAC)
- `apps/core/src/runtime/ipc.ts:42-44` — 300/min rate limit

---

## Slide 7 — Every tool asks me first + live demo (4 min)

**Do the demo first. Sixty seconds.**

> "Watch. I'm going to tell this agent to write a file. Normally, the agent just does it. But…"

Trigger the agent. Phone lights up with a Telegram notification. Hold it up. Tap approve. The agent writes the file.

> "Okay. What just happened.
>
> The Claude Agent SDK has a safety hook. Before the agent does *anything* — write a file, run a command, call an API — the SDK checks with you: 'agent wants to do X. Allow or deny?' Most people use this hook to block dangerous commands. Maybe block `rm -rf`. Maybe block git pushes.
>
> MyClaw uses it for **every** tool, by default. Every file write. Every shell command. Every API call. They all flow through the hook, into a Telegram message, onto my phone. I tap a button. The tool runs.
>
> Why is that interesting? Because it changes the relationship. Normally an agent does stuff and tells you after. With this, the agent is always asking. It feels less like running a script and more like texting with a very fast coworker. 'Hey, should I do this?' 'Yep.' 'Okay, doing it.'
>
> If I say no, the SDK hands back a denial to the agent — not as a crash, but as a regular tool result that says 'denied.' The agent just adapts. 'Okay, I won't write that file. Want me to try another approach?' The permission system is a conversation, not a kill switch.
>
> And one detail for anyone who knows the space — both of the other popular Claude-based chat tools don't use this hook. They built their own approval systems from scratch. I didn't have to, because I sit on the SDK that ships one."

**Speaker-reference files:**
- `packages/agent-runner/src/index.ts:545-583` — the permission hook
- `packages/agent-runner/src/ipc-mcp-stdio.ts:420-557` — multi-choice question tool
- `packages/agent-runner/src/index.ts:70` — 5-minute default timeout

**If the demo fails:** fallback to pre-recorded screencast. Do NOT skip. This is the slide the audience will remember.

---

## Slide 8 — Why it's affordable (2.5 min)

> "Okay, back to the money question. Two thousand a month was the problem. How does MyClaw actually dodge that?
>
> The single biggest win is **caching.**
>
> Anthropic charges you less if they've seen your prompt before. Like way less. Maybe one-tenth the price for the cached portion.
>
> The catch: cache hits need the beginning of your prompt to be byte-for-byte identical turn after turn. If anything near the top changes — the date, the current directory, today's weather — the cache breaks and you pay full price.
>
> So my whole prompt layout is designed around **keeping the top stable.** Runtime rules, the agent's personality, shared documentation — all the stuff that basically never changes — sits at the very top. Group-specific notes come below. Memory and the actual user message go at the very bottom.
>
> There's a flag in the SDK I turn on that tells Claude Code 'don't auto-inject the current date or working directory into my system prompt. I'll handle that myself, way down at the bottom, so it doesn't break the cache.'
>
> Net effect: on every turn, maybe 15 thousand tokens are cache-hits. Maybe 500 tokens are new. I pay for the 500. The bill drops by roughly ten times.
>
> That's the whole trick. It's not magic, it's just understanding how the pricing works and arranging your prompt to take advantage of it."

**Speaker-reference files:**
- `packages/agent-runner/src/index.ts:97-118` — system prompt build with `excludeDynamicSections: true`
- `apps/core/src/runtime/prompt-profile.ts:144-167` — the stable-first section ordering

---

## Slide 9 — Memory that sleeps (3 min)

> "Last piece. Memory. Three moves.
>
> **Write.** Every conversation, the agent notices things — 'user prefers dark mode,' 'project X deadline is Friday,' 'don't draft emails in a formal tone.' Those get saved to a little database on disk, one per group.
>
> **Read.** Before the agent replies to a new message, it searches that database. Two ways at once — word match for exact terms, meaning match for paraphrases. Top results get stapled to the start of what the agent sees. So when you say 'remind me about that thing,' the agent actually has the context. You never see it happen; it just feels like the agent remembers.
>
> **Dream.** Memory gets messy. You told the agent three times you prefer dark mode, slightly different wording each time. Now there are three notes about the same thing. At 3am every night, a job wakes up, finds those clusters, merges them into one cleaner note, and drops notes that nobody's been using. I call it dreaming because that's what your brain does during sleep — consolidate the noisy day into long-term structure.
>
> And what actually ends up in the database? After dreaming runs, you have **two layers living together.** The raw notes from recent conversations — still there, still searchable, still the source of truth for specific details. And the consolidated summaries dreaming produced — shorter, higher-confidence, more useful for recurring context.
>
> The agent doesn't pick one or the other. It just searches, and the ranking naturally floats summaries to the top because they score higher. Raw chunks stay as a safety net — if a summary loses a detail you actually needed, the original is still there.
>
> Over weeks, the ratio shifts. Fresh memory is mostly raw. Old memory is mostly consolidated. That's the self-cleaning property — the database gets *denser*, not bigger.
>
> Why I care about this for cost: **shorter memory means shorter context on every reply, means fewer tokens, means smaller bill.** The memory system isn't separate from the economics story — it's the same story."

**Speaker-reference files:**
- `apps/core/src/memory/memory-retrieval.ts:13-134` — two-way search + combined ranking
- `apps/core/src/memory/memory-dreaming.ts:195-215` — nightly scoring sweep
- `apps/core/src/memory/memory-service.ts:363-423` — dedup at write time
- `apps/core/src/memory/memory-service.ts:726-750` — usage feedback loop

**If asked "what IR techniques did you use":**
"Standard stuff — BM25 for the word side, embeddings for the meaning side, reciprocal-rank fusion to combine them, and Jaccard for diversity in MMR because it's cheaper than another embedding call. Happy to go deeper."

---

## Slide 10 — What I gave up + close (1.5 min)

Say it plainly. Audience respects candor.

> "A few things I gave up to make these choices.
>
> One: the economics depend on Anthropic's prompt cache. I'm *not* strictly locked in to Claude — the SDK respects an env variable called `ANTHROPIC_BASE_URL`, so I can point MyClaw at a proxy like LiteLLM or OpenRouter and route to OpenAI, Bedrock, Vertex, Gemini, whatever. But the prompt caching I showed you two slides ago is Anthropic-specific. A proxy pointed at a non-Anthropic provider usually can't route those cache-control headers cleanly. So I *could* swap providers tomorrow, but the two-grand-to-affordable math would break. Provider flexibility exists. The economics are still Anthropic-shaped.
>
> Two: I only built two channels — Telegram and Slack. If you need iMessage, Signal, Discord — this isn't the tool.
>
> Three: the filesystem IPC is simple and debuggable, but it's not fast. For one user it's great. For a million users, I'd have to replace the bus with something real.
>
> This is a personal tool built for one person's constraints. That's the point. It probably fits some of yours. If not, that's fine."

Pause. Click to the close thesis.

> "Last slide. If you take one idea home:
>
> **Don't stop at the model. Use Claude Code.**
>
> Most people treat Claude as an API you call. The stronger bet is to treat Claude Code — the agent Anthropic already built — as the engine you build on. All seven choices I walked through followed from that.
>
> If you're building your own assistant, start there. Pick your primitive, and let the rest of your design fall out of it.
>
> Repo's on the slide. Questions."

Keep it tight. The last thing they see should be the thesis line.

**Alternate close if you prefer the metaphor:** "The model is the fuel. Claude Code is the engine." Same meaning, more aphoristic. Pick whichever lands in your voice.

---

## Anticipated Q&A

**Q: Doesn't this hit the same ToS issue that blocked OpenClaw earlier this year?**
A: Technically, yes — the OAuth token path in MyClaw's code is the same one Anthropic restricted. I'm open about that. MyClaw is a personal tool. For real daily usage I'm on API keys — that's what I architected for, and the whole talk is about making that path affordable. The OAuth code exists because I wrote it before enforcement and because the SDK supports it. I don't pitch subscription use as a feature. If I shipped it to other people as a subscription-evasion layer, I'd feel bad about that. I don't.

**Q: How does MyClaw authenticate with Anthropic for real usage?**
A: `ANTHROPIC_API_KEY`. Directly, or through a credential gateway called OneCLI that ships with MyClaw — supports env-only, managed-only, or hybrid credential modes.

**Q: Can you actually swap to a different provider?**
A: Yes. Set `ANTHROPIC_BASE_URL` and point it at LiteLLM, OpenRouter's "Anthropic Skin", or any Anthropic-protocol-compatible proxy. You can also use AWS Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) or Google Vertex (`CLAUDE_CODE_USE_VERTEX=1`) directly. Caveat: prompt caching semantics don't travel cleanly through a proxy targeting a non-Anthropic upstream, so the cost win on slide 8 becomes provider-specific.

**Q: Why not use a worker thread pool instead of a subprocess?**
A: OS-level isolation. A real process boundary means a real crash boundary. Worker threads share memory with the host; bad state in a worker can corrupt the host. Processes can't do that.

**Q: Isn't filesystem IPC going to fall over at scale?**
A: Yes, eventually. Rate-limited to 300 files/minute/group. Single-user or small-team: no problem. A public service with thousands of users would need a real transport. I picked filesystem because I can watch `tail -f` and see every decision — that observability is worth the ceiling for a personal tool.

**Q: What about OpenAI, Gemini, local models without a proxy?**
A: Not first-class — the codebase targets Claude. Via `ANTHROPIC_BASE_URL` + a proxy like LiteLLM, you can route to any of them. Native multi-provider support would mean writing my own agent loop, which is exactly what I was trying to avoid.

**Q: How is memory different from something like Mem0 or LangChain's memory modules?**
A: Different shape, different tradeoff. Mem0 is a service. LangChain's memory is usually conversation buffer or vector store. MyClaw's is a local SQLite with a two-way search, semantic dedup at write time, usage feedback, and a nightly consolidation job. It's tuned for long-lived single-user context, not for general-purpose use.

**Q: Can the agent schedule its own future tasks?**
A: Yes — there's a scheduler exposed to the agent as a tool. It can create cron jobs, intervals, or one-shot tasks that fire later and deliver results back to the channel. I didn't have stage time for it, happy to walk through after.

**Q: Why is your permission system better than the other tools'?**
A: I didn't say it's better. I said it's different. Mine uses the SDK's native hook, theirs wrap raw API calls and built their own. Mine gates every tool by default — theirs gate dangerous commands specifically. Pick the right tradeoff for your workload: if you want mostly-autonomous background runs, you don't want every tool asking for approval.

**Q: Can you show me the repo?**
A: Yes. [Pull up the URL on slide 10. Offer live code spelunking during Q&A.]

---

## Morning-of checklist

1. **Practice the slide 7 demo three times.** Phone on WiFi, agent on laptop, Telegram bot active, file-write target identified. If it fails live, pivot to pre-recorded screencast.
2. **Record a 45-second screencast** of the demo as fallback. Keep it on the presenter laptop.
3. **Time the full talk once with a stopwatch.** If you're over 22 minutes by slide 10, shave slide 9 to 2.5 min (drop the "two-layers" detail, save for Q&A).
4. **Confirm your API math.** If you're on stage saying "$2,000/mo" and someone challenges the arithmetic, be ready with actual invoice or token math.
5. **Open your critical files on a second monitor** — `packages/agent-runner/src/index.ts`, the memory files, the IPC files. When a Q&A question gets specific, you have receipts.
6. **Know the `ANTHROPIC_BASE_URL` + LiteLLM answer cold.** Someone will ask.
7. **Rehearse slide 3 (the bet) out loud once.** The model-vs-runtime framing is load-bearing for the whole talk. If it doesn't land, the rest doesn't either.
