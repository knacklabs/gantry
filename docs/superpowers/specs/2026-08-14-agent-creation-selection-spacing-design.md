# Agent Creation Selection and Spacing Design

## Goal

Make Agent Creation inventory lists visually consistent, easier to scan, and faster to select without changing the broader console design or introducing another UI dependency.

## Scope

- Update the Agent Creation dialog only for layout and multi-select list composition.
- Continue using Gantry's installed shadcn Radix `Checkbox` primitive everywhere.
- Replace the dialog's remaining raw checkbox input with that shared primitive.
- Do not add row selection to data tables that have no batch action.

## Spacing Contract

- Header, scrolling content, and footer share 20px horizontal padding.
- Footer keeps 16px vertical padding so actions remain compact.
- The step rail keeps 12px outer padding and 8px item padding.
- Major content sections and selection-column stacks use 24px gaps.
- Selection titles sit 8px above their lists.
- Selection rows use 12px padding and a 12px control-to-content gap.
- Labels and risk badges use an 8px gap instead of touching.
- On two-column layouts, each column owns its vertical stack so a tall group does not create empty space beneath the shorter neighboring group.

## Multi-select Contract

Every non-empty Agent Creation checkbox group shows a group-scoped `Select all` control above its item rows.

The control has three visible and accessible states:

1. **Unchecked** — no items in that group are selected.
2. **Checked** — every item in that group is selected.
3. **Indeterminate** — some, but not all, items are selected.

Click behavior:

- Unchecked or indeterminate selects every available item in that group.
- Checked clears every selected item in that group.
- Empty groups show the existing empty message and no disabled select-all control.

The control uses Radix's native `checked="indeterminate"` state. Its accessible label names the group, for example `Select all capabilities`. Individual checkbox labels remain fully clickable.

## Visual Treatment

- Follow the supplied Beautiful UI reference for dense list rhythm and visible partial selection.
- Preserve Gantry's semantic tokens, borders, radii, typography, themes, and focus rings.
- Use no raw colors, new animations, copied CSS, or Beautiful UI dependency.

## Failure and Data Behavior

- Selection remains local form state until the existing draft/save workflow persists it.
- Select-all operates only on the currently loaded safe option IDs in its group.
- Loading and unavailable-option behavior remains unchanged.

## Verification

- Typecheck, deterministic web build, and focused formatting.
- Existing web tests, reporting the known unrelated app-shell assertion separately if it remains.
- Manual dark- and light-theme checks at desktop and narrow widths.
- Keyboard check for each group: focus, Space toggle, indeterminate state, select all, and clear all.
- Confirm no raw `type="checkbox"` remains in `apps/web/src`.
