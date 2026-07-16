# Gantry Web UI Implementation Tracker

Branch: `feature/gantry-web-ui-initiate`

| Packet | Deliverable                                           | Status   | Evidence                                             | Commit     |
| ------ | ----------------------------------------------------- | -------- | ---------------------------------------------------- | ---------- |
| P1     | Static workspace, shell, preferences, `/ui` hosting   | Complete | Web/root build and Chrome checks at 1440px and 390px | `62df6a5a` |
| P2     | Frontend-only docs and tracker                        | Complete | Prettier and diff checks pass                        | `31af0ced` |
| P3     | Dependencies, semantic tokens, shared action boundary | Complete | Typecheck, lint, build, boundary search              | `a1d4728e` |
| P4     | Primitive and composed component lab                  | Complete | Chromium review at 1440px and 390px                  | `a1d4728e` |
| P5     | Operations console                                    | Complete | Six-route Chromium matrix, filters, gate, drawer     | `e29bc6c3` |
| P6     | Agent administration                                  | Complete | Tab matrix, validation, draft retention, pause gate  | `a2cbcb4a` |
| P7     | Chat and rich interactions                            | Complete | Renderer matrix, draft retention, rich action gates  | `4ac965b3` |
| P8     | Jobs, runtime, and activity                           | Complete | Route matrix, cursor, blockers, redaction review     | `f07a2c79` |
| P9     | People                                                | Complete | Identity matrix, invite draft, merge conflict checks | `a99ea954` |
| P10    | Workflows                                             | Complete | Builder matrix, local validation, command gates      | `d3b38885` |
| P11    | Hardening and completion audit                        | Complete | Route audit, focus checks, full build, cleanup       | `a2a2ff2f` |

## Browser Matrix

| Area             | 1440 light/dark | 1024 light/dark | 390 light/dark | Keyboard | Status   |
| ---------------- | --------------- | --------------- | -------------- | -------- | -------- |
| Foundation       | Complete        | Complete        | Complete       | Complete | Complete |
| Component lab    | Complete        | Complete        | Complete       | Complete | Complete |
| Operations       | Complete        | Complete        | Complete       | Complete | Complete |
| Agents           | Complete        | Complete        | Complete       | Complete | Complete |
| Chat             | Complete        | Complete        | Complete       | Complete | Complete |
| Jobs and runtime | Complete        | Complete        | Complete       | Complete | Complete |
| People           | Complete        | Complete        | Complete       | Complete | Complete |
| Workflows        | Complete        | Complete        | Complete       | Complete | Complete |

## Completion Evidence

- All 58 registered route/view states, including the unknown-route fallback,
  render with one page heading, no horizontal overflow, no duplicate IDs, no
  unnamed controls, no browser exceptions, and no failed requests at the
  constrained 390px dark-theme viewport.
- Area matrices pass at 1440px, 1024px, and 390px in light and dark themes.
- Keyboard checks cover the skip link, route tabs, mobile navigation drawer,
  chat session drawer, connection gate, focus return, and Escape dismissal.
- Server-owned actions preserve local drafts and stop at the shared connection
  gate. Preview record counts do not change after gated commands.
- Browser source contains no REST request, SSE, WebSocket, bearer credential,
  API proxy, or query-cache persistence path. Browser storage remains limited
  to `gantry.ui.preferences.v1`.
- Every handwritten file under `apps/web/src` is at or below 350 lines. The
  largest file is 348 lines.
- Production component-lab routes are excluded from the production bundle.
  The main production JavaScript bundle is 115.67 kB gzip.
- `npm run typecheck:web`, `npm run lint:web`, `npm run build:web`,
  `npm run typecheck`, `npm run build`, `git diff --check`, and production
  dependency audit checks pass.
- Provider display vocabulary is recognized as browser presentation while
  provider SDK imports and credential identifiers remain architecture errors.

## Deferred Work

- Browser identity, authentication, pairing, roles, OAuth/OIDC, SAML, and SSO.
- REST, SSE, WebSocket, Control API, SDK contract, persistence, and audit wiring.
- Automated component and end-to-end test harnesses.

Deferred work does not permit fake success. Preview reads remain visibly
non-live and every server-owned command stops at the shared connection gate.

## Known External Gate Debt

Root architecture checks still report the accepted pre-existing core size
budget finding and core messaging formatter provider-location findings. Web
packets introduce no architecture finding.
