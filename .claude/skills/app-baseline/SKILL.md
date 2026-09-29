---
name: app-baseline
description: The baseline every Forge client app gets without anyone asking. Use for any frontend or UI work in a Forge client repo, including screens, layout, navigation, forms, tables and prototype demos, before building or changing it.
---

# App baseline

Client apps are business systems of records, often first built as a customer prototype. Every one
gets this baseline, whether or not the story names it. The stack and its rules live in the repo's
conventions (`stack.md`, `frontend.md`) and the standards page; the design craft lives in the
impeccable and emil-design-eng skills. This page lists what must be there and points to them.

## 1. Components

- shadcn/ui only, installed with its CLI (`npx shadcn@latest add <component>`). One set of
  accessible components you own as code.
- Never hand-roll something shadcn already has (dialog, menu, select, tabs, table). A second
  version drifts in look and accessibility.
- Tailwind theme tokens only (`bg-primary`, `text-muted-foreground`), never an ad-hoc colour. The
  look and dark mode change in one place.
- Icons from lucide-react. It is what shadcn uses, so icons match.

## 2. App shell

- shadcn's Sidebar block: collapsible, grouped sections, icon plus label, a clear active item, and
  a sheet on mobile. People always know where they are and can get anywhere.
- Top bar with breadcrumbs, so a deep record shows its path back.
- ⌘K / Ctrl+K command palette (shadcn Command) for search and navigation. Power users skip the
  menu.
- User menu with profile and sign out, and a theme switch (light, dark, system). Every app is
  expected to have them.

## 3. Pages

- Each page has a header: title, one-line description, and one primary action. One obvious next
  step per page.
- Sign-in and forgot-password pages, and protected routes. A records app is never open to anyone.
- 404 and 403 pages that say what happened and link home. A dead end is never a blank screen.

## 4. Lists

- shadcn's data table (TanStack Table) with sorting, filters, pagination, column visibility, row
  actions and bulk select. Records are worked in lists.
- Page, sort, filters and search live in the URL. A shared link or a refresh shows the same view.

## 5. Forms

- shadcn Form with react-hook-form and zod, reusing the shared package's validators. The client
  and the API agree on what is valid.
- Inline messages next to the field that say how to fix it ("Enter a date after the start date").
  The user fixes it without guessing.
- Submit is disabled while saving. No double submits.
- Warn before leaving with unsaved changes. Nobody loses work to a stray click.

## 6. Feedback

- Sonner toasts for success and errors. Every save gets an answer.
- A confirm dialog (shadcn AlertDialog) before anything destructive, naming what will be lost. A
  mistake costs a click, not data.

## 7. States

- Loading skeletons shaped like the content. The page doesn't jump when data arrives.
- Empty states that say what the screen is for and offer the next action as a button. A new user
  knows what to do first.
- Errors that say what happened, in plain words, and offer retry. The client can recover alone.

## 8. Everywhere

- Keyboard access and visible focus on every control; a label on every control; contrast as
  impeccable's audit checks it. Accessibility is never simplified away.
- Dates, numbers and currency formatted with `Intl` in the user's locale and time zone; stored in
  UTC. People read their own formats.
- A page title per route and a favicon. Tabs and bookmarks stay readable.
- Every record shows who created it or last changed it, and when (from the audit fields in the
  data rules). A system of records answers "who did this?".

## 9. Design ownership

impeccable owns visual design and the checking pass: shape before building, then audit and polish
before a demo. emil-design-eng owns interaction feel; invoke it with a specific task. Where they
disagree, the frontend conventions settle it:

- Stagger only when a list appears as a list.
- App motion stays under 300 ms.
- Content is visible by default; enter with `@starting-style` or transitions.
- One ease-out token: `cubic-bezier(0.23, 1, 0.32, 1)`.
- CSS and the Web Animations API first; Motion only for springs or drag.
- impeccable's bounded checking: one batched inspection, at most one more round.
- Prototypes are app UI in impeccable's Operate mode: Emil's restraint wins over bold effects.
- Popovers scale from their trigger via Radix's transform-origin variable.
- No animation on keyboard-driven or very frequent actions.

## 10. Prototype demos

- Build the shell and the one demo workflow to this baseline first; everything else waits. The
  customer judges the whole app by the path they see.
- Demo data and the feedback toolbar follow the stack conventions when the repo has them.

## 11. Dashboard and charts

- Charts use shadcn's Chart components (built on Recharts, themed from the same tokens); no other
  chart library. Charts match the app and follow light and dark.
- Home after sign-in is a dashboard from shadcn's dashboard block: 3-4 KPI cards, each with its
  trend against the previous period; one main chart over time; a recent-activity table. People
  see how things stand before they go looking.
- The KPIs are the numbers from the customer's problem card (hours spent, orders delayed), so the
  dashboard shows the saving; in a prototype they come from the demo data. The customer watches
  the problem they paid to fix shrink.
- Numbers come from real queries, never hard-coded. A dashboard that lies once is never trusted.
- The date range lives in the URL, with presets (7 days, 30 days, quarter, custom). A shared link
  shows the same period.
- Numbers use tabular figures and the user's locale. Columns line up and read naturally.
- Charts never rely on colour alone, have axis labels, and offer a readable table view for screen
  readers. Everyone can read the numbers.
- Loading skeletons and empty states match the rest of the app. The dashboard is no exception.

## 12. Done means

Run this before calling any UI change finished:

- [ ] Only shadcn components and theme tokens; no hand-rolled copies, no raw colours.
- [ ] The screen sits in the shell with a sidebar item, breadcrumbs and a page header.
- [ ] Lists keep their state in the URL; forms validate inline, block double submits and warn on
      unsaved changes.
- [ ] Loading, empty and error states render, each with its next action.
- [ ] Destructive actions confirm; saves and failures toast.
- [ ] Keyboard-only walk-through works with visible focus; every control has a label.
- [ ] Dates, numbers and money use the user's locale and time zone.
- [ ] Records show who created or changed them and when.
- [ ] Home is the dashboard: problem-card KPIs with trends, one chart over time, recent activity,
      all from real queries, with the date range in the URL.
- [ ] Charts are shadcn Chart only, with axis labels, more than colour, and a table view.
- [ ] Light and dark themes and the mobile width both look right.
- [ ] impeccable's audit and polish pass ran, with emil-design-eng's checklist inside it.
