# Design System — MyClaw Talk Deck

> Source of truth for the 30-minute "built because I had to" conference talk.
> Preview: [preview.html](preview.html) · Plan: [i-am-going-nested-sketch.md](~/.claude/plans/i-am-going-nested-sketch.md)

## Product Context

- **What this is:** A 9-slide keynote deck for a 30-minute technical conference talk about MyClaw, a personal Claude-based agent runtime.
- **Who it's for:** Conference audience of developers. Mixed expertise — some are Claude-native (OpenClaw / Hermes users), most are not. Presented in a lit room to a few hundred people at up to 20 feet from the screen.
- **Space/industry:** Developer tools / AI agent frameworks.
- **Project type:** Presentation deck (16:9, one-time use, personal story format).
- **Tone:** Personal, candid, substantive, slightly provocative on the Jan 2026 ToS event, landing on humility. Literary essay energy, not product pitch.

## Aesthetic Direction

- **Direction:** Editorial / Magazine meets Brutally Minimal. Think a typographic essay in a design-forward quarterly.
- **Decoration level:** Minimal. Typography does all the work.
- **Mood:** Serious without cold. Literary without pretentious. Confident without loud.
- **Reference feel:** The New York Times app in dark mode meets the cover of a small-press technical journal.

## Typography

- **Display / Hero:** **Fraunces** (Google Fonts). Weight 400. Italic reserved for the single emphasized noun per headline.
  - *Rationale:* A contemporary opsz serif with character. Reads literary and personal. Pairs with the first-person narrative and the "built out of necessity" framing. Resists the generic-tech-talk look.
- **Body:** **Geist** (Google Fonts). Weight 400 for prose, 500 for callouts.
  - *Rationale:* Clean humanist sans with quietly distinctive glyphs. Legible at 20 feet at 20px+. Not on the overused list (Inter, Roboto, Montserrat, Poppins).
- **Code / Monospace:** **JetBrains Mono** (Google Fonts). Weight 500 for identifiers, 400 for flow motif.
  - *Rationale:* Ligature-free by default, precise, well-tested at projection sizes.
- **Loading:** Google Fonts CDN with `display=swap`. Preconnect hints included.
- **Scale:**
  - Title slide headline: 88–112px, `letter-spacing: -0.03em`, `line-height: 0.96`
  - Section slide headline: 48–56px, `letter-spacing: -0.015em`, `line-height: 1.02`
  - Dollar-amount emphasis (slide 4): 112–128px
  - Body / speaker-visible prose: 18–20px, `line-height: 1.5`
  - Monospace code identifiers: 18px at rest, 20–24px on the flow motif
  - Slide eyebrow / section label: 10–12px, `letter-spacing: 0.2em`, uppercase
  - Tag-line footers: 11–13px

## Color

- **Approach:** Restrained. One accent. Grounded dark palette.
- **Ink (background):** `#0B0D0E`
  - Slide background. Reads black under a bright projector, not harsh under a dim one.
- **Paper (primary text):** `#F5F1EA`
  - Warm off-white. Easier on the eye than pure white at distance.
- **Ember (accent, used sparingly):** `#E8A63C`
  - Reserved for: the dollar amount (slide 4), the italic noun in each display headline, the arrow chain and start/end nodes of the flow motif (slide 7), the memory-technique names (slide 8), and the italic noun in the close thesis (slide 9).
- **Graphite (quiet layer):** `#5C5F63`
  - Slide eyebrows, tag-lines, URL footers, slide-number metadata.
- **Derived tones:** Ink-2 `#14171A` (slight lift for code block / flow band background), Paper-2 `#E9E3D7` (lede / secondary prose), Ember-2 `#F5C678` (monospace code emphasis), Line `#2A2F33` (hairline borders between sections).
- **Dark mode:** N/A — deck is dark-only by design. No light-mode variant.
- **Contrast check:** Paper on Ink ≈ 14.8:1 (AAA). Ember on Ink ≈ 8.6:1 (AAA). Graphite on Ink ≈ 3.7:1 (fails AA for body, passes for decorative metadata only — this is the intended role).

## Spacing

- **Base unit:** 8px.
- **Density:** Spacious. This is a projection deck, not a dashboard.
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64) 4xl(96) 5xl(128).
- **Slide padding:** 96px minimum side padding on a 1280×720 slide canvas. 56–88px top/bottom depending on content block anchor (center vs. bottom).
- **Between blocks inside a slide:** 24–48px.

## Layout

- **Approach:** Grid-disciplined 16:9 with generous asymmetric padding.
- **Canvas:** 1280×720 (scales up cleanly to 1920×1080).
- **One visual per slide.** Never two competing focal points.
- **Vertical anchor rules:**
  - Title slide: center-anchor
  - Scene / story slides (2, 3): center-anchor, left-aligned text
  - Data slides (4): center-anchor, dollar amount is the visual
  - Mechanism slides (6, 7, 8): center-anchor, headline above feature device (flow, grid)
  - Trade-offs slide (9): center-anchor, trade-off list with thesis tagline below
  - Close slide (10): center-anchor, thesis as hero
- **Border radius:** 0 on slide elements. 2px on preview-page cards. We are not doing rounded corners in the deck itself — brutalist edges support the literary-minimal thesis.

## Motion

- **Approach:** Minimal-functional. Trust the words.
- **Slide transition:** Cut or 200ms crossfade. No builds, no kinetic typography, no flying elements.
- **Demo moment (slide 7):** The live Telegram approval IS the motion. No animated mockup is needed.

## Recurring Visual Motifs

### The flow motif (slide 7)

```
agent ──▶ canUseTool ──▶ your phone ──▶ approve ──▶ tool runs
```

Rendered in **JetBrains Mono**, 20–24px, on a full-width band with Ember hairlines top and bottom. Arrows in Ember, nodes in Paper, terminal state in Graphite. Appears **exactly once** in the deck. This is the photograph-able moment.

### The memory grid (slide 8)

A 4-column one-row grid showing the four retrieval techniques. Each cell has a graphite uppercase label (`lexical`, `semantic`, `recency`, `diversity`) with an italic Fraunces tech name in Ember below (`BM25`, `vectors`, `decay`, `MMR`). Cell backgrounds in Ink-2, 1px Line dividers.

### Italic-ember emphasis

One word per display headline set in italic Fraunces, Ember color. Establishes the literary rhythm. Slide examples:
- Slide 5: *"Personal assistant. Tool-heavy. **Every day.**"*
- Slide 6: *"Not a wrapper. Not a custom loop. **The SDK itself.**"*
- Slide 7: *"The SDK ships **this hook.**"*
- Slide 8: *"So does **the agent.**"*
- Slide 10: *"It's **a runtime.**"*

Never more than one emphasized noun per headline. The restraint is the point.

## Readable-at-20-feet guidance

- Body prose: 20px minimum on 1280×720, scaling to 30px on 1920×1080.
- Code identifiers: 18px minimum. If a slide relies on code being read (slide 6, slide 7), bump to 22–24px.
- Headlines: 48px minimum, 88–112px for title + close slides.
- Tag-lines (graphite footers): 11–13px is acceptable because they are intentionally not for back-row reading.
- **Test procedure:** Export slide as PNG, view at 15% zoom on a 27" monitor. Any text that's illegible there will be illegible from row 20.

## Slide-by-slide intent

| # | Title | Anchor element | Emphasis word (ember) |
|---|---|---|---|
| 1 | MyClaw | Display headline split in two | *built because I had to.* |
| 2 | Me | Narrative block | *November 2025* |
| 3 | January 2026 | Short declarative | *Mine was one of them.* |
| 4 | The API math | Dollar amount | *$2,000* |
| 5 | So I built MyClaw | Three-word thesis block | none (deliberate — give the slide quiet) |
| 6 | Closer to the primitive | Package name in mono | *the SDK itself.* |
| 7 | AskUserQuestion | Flow motif | arrows + *this hook.* |
| 8 | Memory that dreams | Memory grid | *the agent.* + grid names |
| 9 | What I gave up | Trade-off list + tagline | *personal tool.* |
| 10 | Close | Thesis | *a runtime.* |

## Export format

- Target: Keynote (`.key`) or PowerPoint (`.pptx`).
- Font availability check before presenting: Fraunces, Geist, JetBrains Mono must all be installed on the presentation laptop. If presenting on a borrowed machine, embed fonts in the export (`File → Advanced → Embed fonts in the document` in PPT).
- Fallbacks if fonts missing: Fraunces → Georgia. Geist → SF Pro Display. JetBrains Mono → Menlo. All three fallbacks preserve the character-vs-clean-vs-precise contrast.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-17 | Initial design system created | Built for MyClaw conference talk. Literary-minimal aesthetic chosen to match personal-story framing. Dark palette + warm off-white + single amber accent for emphasis. Fraunces/Geist/JetBrains Mono type stack. One recurring flow motif. |

---

## Using this in implementation

Whoever builds the actual deck (Keynote, PowerPoint, reveal.js, or anything else) should:

1. Load Fraunces, Geist, JetBrains Mono at the weights listed above.
2. Set slide master background to Ink (`#0B0D0E`) and default text to Paper (`#F5F1EA`).
3. Define a single "Emphasis Italic" text style using Fraunces italic, weight 400, color Ember (`#E8A63C`). Apply it to exactly one noun per headline.
4. Build the flow motif on slide 7 as a single text line in JetBrains Mono with Ember arrows, on an Ink-2 band with top/bottom Ember hairlines.
5. Build the memory grid on slide 8 as a 4-column table, Ink-2 cells, Line hairlines, Graphite labels, Fraunces italic Ember tech names.
6. Leave the title slide and close slide quiet — no tag-lines, no URLs stealing the moment.
7. The URL `github.com/[...]/myclaw · npx myclaw setup` appears only on the close slide, in Graphite monospace, below the thesis.
