# Gantry Meetup Talk — Visuals

Two buckets. **Architecture diagrams are NOT AI-generated** — AI image tools garble box
labels and arrows into convincing nonsense. Build those from the repo's real mermaid. AI
generation is reserved for conceptual hero images where there's no text to get wrong.

---

## Brand palette

Use the KnackLabs dark palette across the deck (pulled from the live site's CSS variables):

- **Background black:** `#0b0b0b` (`--black-900`) — pure `#000000` for depth/subgraph fills
- **Deep evergreen:** `#0c3529` (`--green-800`) — panels, node fills
- **Mid green:** `#18884f` (`--green-600`) and `#1c6b49` (`--green-700`) — borders, dividers
- **Mint accent:** `#6af1b0` (`--green-300`) — the signature brand color; key terms,
  connectors, restrained glow only
- **Off-white linework / text:** `#f8f8f8` (`#fff` for max contrast)
- **Muted slate:** `#758696` — secondary text / captions

Repo-local logo references:

- `docs/talk/assets/knacklabs-logo-dark-bg.png`
- `docs/talk/assets/knacklabs-logo-full-dark.png`

---

## Professional architecture diagram standard

Use image generation only for tasteful background plates. The actual architecture diagram
must look like a professional C4/cloud-reference diagram:

- one abstraction level per slide
- labeled boxes, boundaries, and arrows
- left-to-right or top-to-bottom flow
- grouped trust/runtime/data boundaries
- no cinematic 3D objects as the primary diagram
- no generated readable text
- exact labels rendered by the deck/HTML layer

The Mermaid files under `docs/talk/assets/diagram-*.mmd` are the topology source of truth.
Use them to brief the image/background style, then render exact labels and arrows
deterministically in the deck.

Final diagram PNGs are 1600x900. Before using them in PPT, inspect that labels remain
centered inside boxes and connector lines do not cross readable text.

---

## Build these as professional diagrams

Keep one visual language across all of them: same font, 2–3 colors max, the agent runtime
always the visual center of gravity.

- **DIAGRAM-1 (Slide 3, new full stack):** Four boxes — Channels (Slack/Teams/Telegram),
  Web surfaces (records/dashboards), Database, and the Agent Runtime in the middle, larger,
  with arrows pointing *into* it. The point: the runtime is the new center, not a side service.
  - Source: `docs/talk/assets/diagram-01-new-full-stack.mmd`
  - Final PNG: `docs/talk/assets/diagram-01-new-full-stack.png`

- **DIAGRAM-2 (Slide 5, runtime map):** Use the first mermaid block in
  `docs/architecture/overview.md` as the architecture reference, but use the slide-safe
  grouped version here so labels and connectors stay readable. It shows ingress surfaces,
  runtime orchestration/control/scheduler/runners, Postgres, the model gateway, credentials,
  and outbound webhooks.
  - Source: `docs/talk/assets/diagram-02-runtime-map.mmd`
  - Final PNG: `docs/talk/assets/diagram-02-runtime-map.png`

- **DIAGRAM-3 (Slide 6, lifecycle):** A single left-to-right pipeline:
  `message/event → group queue → memory hydration → spawned runner → MCP/tools → audit + outbound`.
  Then a small callout: three input icons (Slack bubble, clock, API) all feeding the same pipe.
  - Source: `docs/talk/assets/diagram-03-message-lifecycle.mmd`
  - Final PNG: `docs/talk/assets/diagram-03-message-lifecycle.png`

- **DIAGRAM-4 (Slide 7, dreaming):** Horizontal three-stage flow — Light Sleep → REM →
  Deep Sleep — with a one-line label under each, raw chatter going in the left, a few
  curated durable items coming out the right.
  - Source: `docs/talk/assets/diagram-04-memory-dreaming.mmd`
  - Final PNG: `docs/talk/assets/diagram-04-memory-dreaming.png`

- **DIAGRAM-5 (Slide 8, tool lifecycle):** A loop:
  `request → review → approval → audit → config version → next-run activation`.
  Put a small lock icon on "approval" with the caption "agent can't approve itself."
  - Source: `docs/talk/assets/diagram-05-tool-lifecycle.mmd`
  - Final PNG: `docs/talk/assets/diagram-05-tool-lifecycle.png`

- **DIAGRAM-6 (Slide 10, three patterns):** Three lanes (chat / jobs / action requests)
  collapsing into one shared bar labeled "runtime · memory · gate · audit."
  - Source: `docs/talk/assets/diagram-06-three-patterns.mmd`
  - Final PNG: `docs/talk/assets/diagram-06-three-patterns.png`

- **DIAGRAM-7 (Slide 11, market):** Four plain columns, one trait line each. Neutral styling.
  Do **not** reuse the repo's `agent-runtime-comparison.html` Bad/Good matrix on stage — it's
  Gantry's own editorial positioning, not a neutral benchmark.
  - Source: `docs/talk/assets/diagram-07-market-map.mmd`
  - Final PNG: `docs/talk/assets/diagram-07-market-map.png`

---

## AI-generate these (conceptual only — no readable labels)

Style prompt to prepend to all of them, for consistency:

> *"Editorial tech-conference illustration, clean and restrained, KnackLabs dark palette
> (near-black #0b0b0b, deep evergreen #0c3529, off-white #f8f8f8 linework, restrained mint
> #6af1b0 glow), subtle geometric forms, no text, no UI screenshots, no logos, generous
> negative space, 16:9."*

- **AI-1 (Slide 1, hero):** "A single calm figure at the center of several softly glowing
  conduits that reach outward toward distant clusters of people — the conduits carry work
  *to* the people rather than pulling them in. Sense of a quiet hub. No text."
  - Generated asset: `docs/talk/assets/slide-01-agent-core.png`

- **AI-2 (Slide 2, optional):** "A polished glass demo object on a pedestal with hairline
  fractures spreading under stress, dim industrial production floor behind it. Tension
  between the shiny prototype and the harsh environment. No text."
  - Generated asset: `docs/talk/assets/slide-02-production-stress.png`

- **AI-3 (Slide 9, optional):** "Concentric protective rings around a small bright core,
  each ring a checkpoint or gate, one figure outside unable to reach in without passing
  through. Sense of layered, deliberate containment. No text."
  - Generated asset: `docs/talk/assets/slide-09-trust-boundaries.png`

- **AI-4 (Slide 12, closer):** "A small simple shape resting effortlessly on top of a
  massive, intricate, load-bearing foundation that is mostly underground — the visible tip
  is easy, the structure beneath is the real work. No text."
  - Generated asset: `docs/talk/assets/slide-12-runtime-foundation.png`

> Tooling note: if you must put any text in an image, use Ideogram or GPT-image (better
> spelling) — but for these four, keep them text-free so they age well and translate.
