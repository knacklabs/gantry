# Gantry Web UI Implementation Tracker

Branch: `feature/gantry-web-ui-initiate`

| Packet | Deliverable                                           | Status   | Evidence                                             | Commit      |
| ------ | ----------------------------------------------------- | -------- | ---------------------------------------------------- | ----------- |
| P1     | Static workspace, shell, preferences, `/ui` hosting   | Complete | Web/root build and Chrome checks at 1440px and 390px | `62df6a5a`  |
| P2     | Frontend-only docs and tracker                        | Complete | Prettier and diff checks pass                        | `31af0ced`  |
| P3     | Dependencies, semantic tokens, shared action boundary | Complete | Typecheck, lint, build, boundary search              | This commit |
| P4     | Primitive and composed component lab                  | Complete | Chromium review at 1440px and 390px                  | This commit |
| P5     | Operations console                                    | Pending  | Route and interaction browser checks                 | Pending     |
| P6     | Agent administration                                  | Pending  | Route and draft browser checks                       | Pending     |
| P7     | Chat and rich interactions                            | Pending  | Renderer and composer browser checks                 | Pending     |
| P8     | Jobs, runtime, and activity                           | Pending  | Table, timeline, and responsive checks               | Pending     |
| P9     | People                                                | Pending  | Detail, invite, and merge-preview checks             | Pending     |
| P10    | Workflows                                             | Pending  | Builder, review, and run-view checks                 | Pending     |
| P11    | Hardening and completion audit                        | Pending  | Full build, cleanup, responsive matrix               | Pending     |

## Browser Matrix

| Area             | 1440 light/dark | 1024 light/dark | 390 light/dark | Keyboard       | Status      |
| ---------------- | --------------- | --------------- | -------------- | -------------- | ----------- |
| Foundation       | Light complete  | Pending         | Light complete | Basic complete | In progress |
| Component lab    | Light complete  | Pending         | Light complete | Basic complete | In progress |
| Operations       | Pending         | Pending         | Pending        | Pending        | Pending     |
| Agents           | Pending         | Pending         | Pending        | Pending        | Pending     |
| Chat             | Pending         | Pending         | Pending        | Pending        | Pending     |
| Jobs and runtime | Pending         | Pending         | Pending        | Pending        | Pending     |
| People           | Pending         | Pending         | Pending        | Pending        | Pending     |
| Workflows        | Pending         | Pending         | Pending        | Pending        | Pending     |

## Deferred Work

- Browser identity, authentication, pairing, roles, OAuth/OIDC, SAML, and SSO.
- REST, SSE, WebSocket, Control API, SDK contract, persistence, and audit wiring.
- Automated component and end-to-end test harnesses.

Deferred work does not permit fake success. Preview reads remain visibly
non-live and every server-owned command stops at the shared connection gate.

## Known External Gate Debt

Root architecture checks currently report pre-existing core-only findings in
`permission-classifier.ts` and `messaging/text-styles.ts`. Web packets must not
increase those counts or introduce new architecture findings.
