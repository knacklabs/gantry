# Gantry Web UI Implementation Tracker

Branch: `feature/gantry-web-ui-initiate`

| Packet | Deliverable                                           | Status   | Evidence                                             | Commit      |
| ------ | ----------------------------------------------------- | -------- | ---------------------------------------------------- | ----------- |
| P1     | Static workspace, shell, preferences, `/ui` hosting   | Complete | Web/root build and Chrome checks at 1440px and 390px | `62df6a5a`  |
| P2     | Frontend-only docs and tracker                        | Complete | Prettier and diff checks pass                        | `31af0ced`  |
| P3     | Dependencies, semantic tokens, shared action boundary | Complete | Typecheck, lint, build, boundary search              | `a1d4728e`  |
| P4     | Primitive and composed component lab                  | Complete | Chromium review at 1440px and 390px                  | `a1d4728e`  |
| P5     | Operations console                                    | Complete | Six-route Chromium matrix, filters, gate, drawer     | `e29bc6c3`  |
| P6     | Agent administration                                  | Complete | Tab matrix, validation, draft retention, pause gate  | `a2cbcb4a`  |
| P7     | Chat and rich interactions                            | Complete | Renderer matrix, draft retention, rich action gates  | `4ac965b3`  |
| P8     | Jobs, runtime, and activity                           | Complete | Route matrix, cursor, blockers, redaction review     | `f07a2c79`  |
| P9     | People                                                | Complete | Identity matrix, invite draft, merge conflict checks | `a99ea954`  |
| P10    | Workflows                                             | Complete | Builder matrix, local validation, command gates      | This commit |
| P11    | Hardening and completion audit                        | Pending  | Full build, cleanup, responsive matrix               | Pending     |

## Browser Matrix

| Area             | 1440 light/dark | 1024 light/dark | 390 light/dark | Keyboard       | Status      |
| ---------------- | --------------- | --------------- | -------------- | -------------- | ----------- |
| Foundation       | Light complete  | Pending         | Light complete | Basic complete | In progress |
| Component lab    | Light complete  | Pending         | Light complete | Basic complete | In progress |
| Operations       | Complete        | Complete        | Complete       | Basic complete | Complete    |
| Agents           | Complete        | Complete        | Complete       | Basic complete | Complete    |
| Chat             | Complete        | Complete        | Complete       | Basic complete | Complete    |
| Jobs and runtime | Complete        | Complete        | Complete       | Basic complete | Complete    |
| People           | Complete        | Complete        | Complete       | Basic complete | Complete    |
| Workflows        | Complete        | Complete        | Complete       | Basic complete | Complete    |

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
