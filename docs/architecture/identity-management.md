# Identity Management

Gantry resolves a canonical **person** before reading or writing personal
memory. A person is the stable human identity inside one `appId`; provider user
ids, emails, phone numbers, and web SDK user ids are aliases.

The public Control API uses `person` and `personId`. The current Postgres
implementation stores people in the existing `users` table and exposes
`users.id` as `personId`. The `user_aliases` table stores provider/email/phone
aliases with `verified`, `unverified`, or `retired` verification state.

Identity resolution is exact-match only. Gantry does not merge people by display
name and does not auto-link identities across providers. Missing aliases create
one active person plus one unverified alias when `createIfMissing` is not
`false`; with `createIfMissing=false`, the result is `unresolved` and personal
memory hydration is skipped.

Personal memory APIs accept `personId` as the public subject field. Runtime
storage normalizes this to `subjectType='user'`, `subjectId=personId`, and
`userId=personId`. Group, channel, and conversation memory remain keyed by
conversation scope and are never moved by person merges.

Live runtime turns use canonical person resolution for personal-memory work in
direct/private conversations. Group, channel, thread, and topic conversations
remain conversation-scoped for long-term memory: they hydrate and store group or
channel memory only, not sender personal memory.

SDK app-session turns use `evidenceType='web_user'` only when the caller
provides an explicit `senderId`. Anonymous SDK turns keep the internal `sdk`
sender sentinel and do not create or resolve a person. `phone` evidence stays
supported in the resolve API and service layer for exact-match alias lookups,
but this slice does not add a new live voice adapter seam.

People admin APIs list aliases and personal memory counts only. They do not
return memory contents. Merge preview is read-only. Merge apply is atomic and
idempotent, moves aliases and `subjectType='user'` personal memory rows to the
target person, and records `person_merge_audit`.
