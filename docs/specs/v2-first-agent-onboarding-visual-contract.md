# V2 first-agent onboarding visual contract

The supplied visual source is versioned for review at
`docs/reference/onboarding/gantry-onboarding-v2.dc.html` (SHA-256
`c1dc1305abd4876f74ac7b0c8e097205c891b3478fb3ab7f7db1ec6f72259a45`). It is
review-only source material, never web runtime code. It is authoritative for
typography, colour, spacing, borders, artwork, desktop/tablet composition, and
motion primitives only. The behavioural spec and active decisions override its
prototype data, timers, navigation, credential handling, and readiness claims;
the deliberate visual deviations below override the source HTML.

## Viewports

Compare splash and four-step states after fonts load at 1920×956, 1469×800,
1280×800, 1024×768, and 768×1024. At 768px and above, the route has a sticky
header, a 266px fixed left rail, and independently scrolling content. Below
768px, compare 375×812 and use normal document scrolling.

Visual tests use the repository-pinned Playwright Chromium build at device
scale 1, `en-GB`, UTC, and the checked-in Fontsource/Iconify package versions.
They wait for `document.fonts.ready`; static comparisons disable CSS motion,
while motion comparisons seek named deterministic timestamps. In that pinned
environment, reviewed baselines permit zero unexpected changed pixels.

## Typography and colour

Use Schibsted Grotesk for display, DM Sans for UI/body, and DM Mono for labels,
input detail, and verification text. Use existing Gantry light/dark tokens, a
15px base size, the reference near-black woven-grid splash background, and its
matching light surface treatment. Do not substitute remote fonts.

## Artwork and motion

`apps/web/src/assets/onboarding/` owns the Gantry splash mark, rail-step marks,
and KnackLabs mark. The splash mark reveals and glows its cells in staggered
order; rail marks add completed green cells and pulse the current cell. The
KnackLabs mark stays static. Splash role text rolls over 16.8 seconds; CTA hover
lifts and active press settles. Every entrance, loop, hover, and SVG effect has
a static reduced-motion equivalent for both system and saved preference.

## Key layout invariants

- Splash content is centrally aligned, with identity fields between body copy
  and CTA.
- Desktop/tablet screens use the fixed vertical rail—not a top stepper—and its
  footer lockup is centred in the rail.
- Step 1 keeps the model-card heading band outside its internal scroller; only
  provider, credential, validation, and model selection scroll.
- Step 2 keeps its centred heading, channel pills, and bottom navigation
  visible while its accordion body owns overflow.
- Global navigation remains visible and Sonner notices attach to the viewport
  bottom-right, never a component-local overlay.

## Deliberate deviations from the prototype

- The splash owns required employee name and job-title fields; Step 1 begins
  with model setup. Both fields use the reference name-field treatment.
- Skip is absent, and Step 4 cannot expose Console handoff before verified
  readiness.
- Model providers appear as Anthropic, Amazon Bedrock, OpenAI, OpenRouter, and
  Google Vertex AI. Authentication mode, agent harness, typed model credential,
  and policy-disabled states live inside the Step 1 scroller using the same
  field rhythm as the reference.
- Model setup says `Validate configuration`, `Validating configuration`, and
  `Configuration validated`; it never claims upstream reachability.
- Slack uses the reference Create/Connect presentation, but the backend owns
  its manifest and real discovery. Step 3 has no fixture conversation or
  approver defaults.
- Step 4 adds pending, inbound-received, expired, projection-failed, and
  completed cards using the reference verification-card geometry. Drawers use
  the existing dialog primitive and the reference card/border/type tokens.
- The mobile natural-scroll layout and unavailable/setup-only provider states
  are owned by this contract because the prototype does not define them.

## Evidence

Freeze animation for static screenshot comparison. Capture deterministic frames
for splash reveal/glow, role roll, CTA hover/press, rail progression, provider
selection, accordion transitions, drawer slide, and reduced-motion mode. State
captures cover focus, disabled, successful configuration, inline validation,
policy-disabled/deferred setup, empty discovery, failed runtime projection,
pending/inbound/expired/completed verification, and both disclosure drawers.
Compare unchanged primitives directly to the HTML and deliberate deviations to
reviewed baselines produced from this contract. Store evidence in Forge task
evidence, never in the web bundle.
