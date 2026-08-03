# Gantry architecture atlas

Five bounded views explain Gantry without collapsing the whole runtime into one unreadable diagram.

> Source snapshot: Gantry `69ac5b7`. Runtime behavior is derived from current source and accepted decisions. Historical prompts and audits remain context, not current authority.

| View | Use it to understand | Open |
| --- | --- | --- |
| System architecture | Product boundary, routing identity, host authority, stores, models, and capabilities | [Interactive HTML](./gantry-system.architecture.html) · [Typed source](./gantry-system.architecture.json) |
| Live turn | The provider-to-delivery sequence and its durability points | [Interactive HTML](./live-turn.sequence.html) · [Typed source](./live-turn.sequence.json) |
| Memory and dreaming | App memory, optional hybrid recall, dream review, and the separate company brain | [Interactive HTML](./memory-dreaming.dataflow.html) · [Typed source](./memory-dreaming.dataflow.json) |
| Permission execution | Mandatory policy order, reviewed authority, and terminal settlements | [Interactive HTML](./permission-execution.lifecycle.html) · [Typed source](./permission-execution.lifecycle.json) |
| Fleet execution | Role separation, horizontal live capacity, Postgres coordination, and shared artifacts | [Interactive HTML](./fleet-execution.architecture.html) · [Typed source](./fleet-execution.architecture.json) |

## How to explore

The HTML files need no server-side application and can be opened from static hosting. Each page includes guided views, focus and relationship lenses, search, keyboard navigation, light/dark themes, zoom, and export controls. The diagrams intentionally start with animation disabled so frequent technical inspection is immediate and reduced-motion safe.

Use the guided views first, then select a component or relationship to isolate its neighborhood. In the architecture views, `SRC` badges expose revision-verified repository evidence.

See [Known viewer limitations](./known-limitations.md) for interaction issues inherited from the pinned Archify v2.13.0 viewer and safe ways to continue when they occur.

## Evidence and verification

- [Source evidence](./source-evidence.md) identifies the current authority order and subsystem entrypoints.
- [Delivery receipts](./delivery-receipts.json) record the generator, source revision, hashes, 9/9 showcase result, and visual-review status.
- `python3 scripts/check_documentation.py` verifies artifact pairing, hashes, revision metadata, and local links.

The HTML is generated output. Review or edit the typed JSON, validate it with Archify, deliver it atomically, inspect the actual result, then update the receipt. Do not hand-edit the delivered HTML.
