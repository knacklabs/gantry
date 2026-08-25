---
slug: web-brand-1
title: Gantry Web Console Brand Mark
status: confirmed
saved: 2026-08-25T18:08:15+00:00
---

# Gantry Web Console Brand Mark

## Status

Approved in the WEB-BRAND-1 design review on 2026-08-25.

## Why

The web console needs one compact, recognisable identity mark that remains
clear in browser chrome, auth pages, and the authenticated navigation shell.

## Behaviour

Use the selected concept 23 as Gantry's canonical browser mark: four square
modules in a stepped assembly. The mark is a transparent 24 by 24 vector with
four 7 by 7 modules at `(1,16)`, `(8.5,8.5)`, `(16,16)`, and `(16,1)`.

The wordmark remains live text. Where the existing `Gantry` or `GANTRY` text is
present, the mark is decorative and has no separate accessible name.

The title-case sidebar wordmark uses Helvetica Neue Regular; the auth lockup
retains its existing uppercase Spline Sans Mono treatment.

Public brand asset URLs include the concept revision query `?v=23-4` so browser
caches cannot retain an earlier mark after a visual correction.

## Acceptance criteria

- Auth pages use a 28px bronze `#C0985F` mark beside the existing uppercase
  `GANTRY` wordmark, with no bordered `G` badge.
- The sidebar uses a 24px `--ink` mark beside the existing `Gantry` label and
  remains legible in both themes.
- Browser icons use a dark `#1B1A18` tile with an off-white `#F7F6F4` mark:
  an SVG favicon and one 180 by 180 touch icon.
- Existing auth copy, routes, navigation labels, page title, layout, and Google
  sign-in treatment do not change.
- The built web console serves the assets under `/ui/` with no external image
  request, PWA manifest, unused icon sizes, duplicate wordmark image, or new
  dependency.

## Boundaries

This is a browser-only visual change. It does not add a public API, schema,
configuration, persistence, runtime authority, or installable PWA surface.
