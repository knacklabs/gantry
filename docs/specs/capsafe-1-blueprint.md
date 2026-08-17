# CAPSAFE-1 matcher cutover blueprint

This blueprint is anchored to `a94ca0ee7`. Line numbers below describe that
revision and are intended to make the next bounded implementation stage
mechanical. Decisions 0129 and 0130 are the binding behavior.

## Outcome and boundaries

The matcher cutover should reuse the remaining-argv logic already owned by
`apps/core/src/shared/tool-rule-matcher.ts`. The implementation should extract
that logic into one argv-pattern kernel, add one exported local-CLI wrapper,
and make structured execution and later compiler coverage call that wrapper.
The private arity-exact matcher in
`apps/core/src/jobs/structured-local-cli-invocation.ts` should be deleted in
the same change; there is no legacy exact-arity mode.

This changes command-shape matching only. It does not grant a capability and
does not add a classifier or cached allow for `capability_run`. The host still
resolves the current app, agent, person, capability selection, executable
identity, sandbox, and egress policy before launch. Runner-side approval may
only hand the validated dispatcher request to that host boundary, as required
by Decision 0130.

Shell syntax is invalid in a reviewed template, not in a structured argv data
value. Do not scan or reinterpret `args` as shell text: `capability_run` passes
an argv array directly to the sandbox runner, so a JSON value containing `>`,
`;`, or `$()` is data and cannot create a pipe, redirect, or expansion.

## Root cause confirmed

| Location at `a94ca0ee7`                                                            | Current behavior                                                                                                   | Cutover consequence                                                                                |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `structured-local-cli-invocation.ts:111-184`, `resolveGrantedLocalCliInvocation()` | Current authority is resolved correctly, but lines 143-150 route each reviewed template through a private matcher. | Keep the authority/executable flow; replace only the matcher call and stale recovery wording.      |
| `structured-local-cli-invocation.ts:216-241`, `structuredArgvMatchesTemplate()`    | Lines 231 and 236-238 require equal arity and prevent every non-flag pattern, including `*`, from matching a flag. | This is the rigidity to remove. Delete the function, its comment, and its callers.                 |
| `structured-local-cli-invocation.ts:243-250`, `globMatches()`                      | Private mixed-token glob implementation used only by the private structured matcher.                               | Delete it; the shared matcher already owns equivalent single-argv glob matching.                   |
| `tool-rule-matcher.ts:543-572`, `bashScopeMatchesLeaf()`                           | A final standalone `*` already matches the remaining argv, including zero entries; other patterns stay positional. | Extract its cardinality and token loop into the shared kernel instead of creating another matcher. |
| `tool-rule-matcher.ts:594-603`, `globPatternMatches()` / `escapeRegex()`           | A mixed-token glob matches exactly one argv entry.                                                                 | Reuse unchanged from the shared kernel.                                                            |

The launch ordering is already fail closed and must remain so:
`runStructuredLocalCliCapability()` calls the resolver at
`structured-local-cli-invocation.ts:64`; the resolver validates bounds at
line 120, resolves current person-scoped authority at lines 122-137, matches a
reviewed local-CLI binding at lines 139-151, verifies the immutable executable
at lines 152-156, and only then returns an invocation for the sandbox runner.

## Shared matcher contract

Add this public, local-CLI-specific entry point beside
`bashScopeMatchesLeaf()` in `tool-rule-matcher.ts`:

```ts
export function localCliCommandTemplateMatchesArgv(input: {
  executablePath: string;
  template: string;
  argv: readonly string[];
}): boolean;
```

It should fail closed unless all of these are true:

1. `hasBashShellControlSyntax(template)` is false. Check this before parsing so
   a trailing control operator such as `;` or `&&` cannot pass merely because
   `parseBashCommand()` produced one non-empty leaf.
2. Parsing with `parseBashCommand()` succeeds and produces exactly one command
   leaf.
3. The template leaf has no redirects.
4. Both the parsed template argv and invocation `argv` start with
   `executablePath` exactly. No wildcard,
   interpreter alias, or basename match is allowed for the executable.
5. At least one literal operation token follows the executable; existing
   `validateLocalCliCommandTemplate()` remains the catalog-write validation
   boundary for this invariant.
6. The shared argv-pattern kernel matches the remaining tokens under the
   local-CLI wildcard policy below.

Factor the cardinality/token loop currently in `bashScopeMatchesLeaf()` into
this private kernel with an explicit non-terminal wildcard policy:

```ts
function argvPatternMatches(
  patternArgs: readonly string[],
  argv: readonly string[],
  nonTerminalWildcard: 'one-arg' | 'one-non-flag',
): boolean;
```

The algorithm is:

- When the last pattern token is standalone `*`, compare the fixed prefix and
  allow zero or more remaining argv entries. Reaching that terminal wildcard
  returns `true`; flags and flag values are intentionally included.
- Without a terminal standalone `*`, require equal lengths.
- A non-terminal standalone `*` consumes exactly one argv entry. In
  `one-non-flag` mode it fails when that value starts with `-`.
- Literals compare exactly. A mixed-token glob delegates to
  `globPatternMatches()` and therefore cannot span argv entries.
- Missing values fail closed.

`localCliCommandTemplateMatchesArgv()` must call the kernel with
`one-non-flag`. `bashScopeMatchesLeaf()` must keep its existing normalization,
safe-interpreter handling, and RunCommand behavior, then call the same kernel
with `one-arg`. That avoids an unrelated RunCommand compatibility change while
making the terminal-remainder implementation shared. Structured execution and
the CAPSAFE compiler stage both import the local-CLI wrapper; neither should
reimplement wildcard or glob matching.

## Exact edit plan

### `apps/core/src/shared/tool-rule-matcher.ts`

1. Refactor `bashScopeMatchesLeaf()` at lines 543-572. Keep lines 547-556
   responsible for RunCommand normalization, parsing, executable safety, and
   interpreter projection. Move lines 557-571 into `argvPatternMatches()` and
   have the RunCommand wrapper call it with `one-arg`.
2. Add `localCliCommandTemplateMatchesArgv()` beside that function. It owns the
   existing `hasBashShellControlSyntax()` pre-check, the
   simple-leaf/no-redirect/exact-executable checks, and calls the kernel with
   `one-non-flag`. Reuse the helper already imported by this module; do not add
   another shell-syntax detector.
3. Keep `leafArgvForScope()` at lines 574-586 RunCommand-only. Local CLI must
   not inherit Python interpreter aliases or generated-skill path projection.
4. Reuse `globPatternMatches()` and `escapeRegex()` at lines 594-603. Do not add
   a second regular-expression glob helper.

### `apps/core/src/jobs/structured-local-cli-invocation.ts`

1. At imports lines 7-8, remove `BashCommandLeaf` and `parseBashCommand`; import
   `localCliCommandTemplateMatchesArgv()` from
   `../shared/tool-rule-matcher.js`.
2. In `resolveGrantedLocalCliInvocation()` lines 139-151, remove the synthetic
   `BashCommandLeaf` and call the shared wrapper with the binding's pinned
   executable, template, and `[executable, ...input.args]`.
3. Keep grant selection at lines 122-137, executable verification at lines
   152-160, `validateStructuredArgs()` at lines 186-210, and
   `verifyImmutableExecutable()` at lines 260 onward unchanged.
4. Update the mismatch guidance at lines 164-183. Remove the claim that every
   `*` means exactly one value. State that a terminal standalone `*` covers the
   remaining args while a non-terminal `*` covers one positional value.
5. Delete lines 216-250 in full: the arity-exact comment,
   `structuredArgvMatchesTemplate()`, and `globMatches()`.

### Compiler reuse in the following bounded stage

`compileCapabilityTemplateMismatch()` must import
`localCliCommandTemplateMatchesArgv()` before proposing a widening. If the
observed argv is already covered, it returns no amendment. Its candidate
coverage checks must call the same wrapper rather than recreate terminal-`*`
semantics. Genuine uncovered prefixes retain the existing host amendment path;
the matcher stage does not delete that path.

## Test matrix

Put the proof in
`apps/core/test/unit/runner/capability-structured-invocation.test.ts` under a
suite or test name containing the exact identifier `CAPSAFE-1-MATCHER`.

| Case                                                           | Reviewed template / input                                                                                         | Expected proof                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Terminal remainder with flags                                  | `<exe> records update *`; argv `records update sheet-1 A1:B2 --values-json [["a,b"]]`                             | Authorized; sandbox receives every argv entry byte-for-byte, including the comma-containing JSON value.   |
| Terminal remainder with no suffix                              | `<exe> records update *`; argv `records update`                                                                   | Authorized because terminal `*` is zero-or-more.                                                          |
| Non-terminal wildcard: one positional                          | `<exe> records * update *`; argv `records sheet-1 update --values-json payload`                                   | Authorized; the first `*` consumes exactly `sheet-1`, and the terminal `*` consumes the remainder.        |
| Non-terminal wildcard: missing, excess before literal, or flag | Same template; omit the sheet id, add a second token before `update`, or place `--sheet` in the non-terminal slot | Denied with `capability_template_mismatch`; a non-terminal `*` is exactly one non-flag argv entry.        |
| Wrong operation                                                | Reviewed `records update *`; invoke `records delete ...`                                                          | Denied with `capability_template_mismatch`; terminal remainder cannot cross the literal operation prefix. |
| Mixed-token glob                                               | `<exe> records region-* update *`                                                                                 | `region-us` may match one argv entry; `region us` or a different literal path does not.                   |
| Invalid structured args                                        | NUL, per-argument overflow, total-byte overflow, and argument-count overflow                                      | Existing `invalid_args` cases remain green and the sandbox is not started.                                |
| No current grant                                               | Invoke a capability id absent from current person-scoped selections                                               | `permission_denied`; the matcher cannot manufacture authority.                                            |
| Person-scope mismatch                                          | Current binding belongs to a different person                                                                     | Existing `permission_denied` proof remains green.                                                         |
| Executable identity mismatch                                   | Wrong hash, writable executable, or executable under the agent-writable root                                      | Existing `executable_identity_mismatch` proofs remain green and the sandbox is not started.               |
| Template executable mismatch                                   | Template starts with another executable, a basename, or an executable wildcard                                    | `localCliCommandTemplateMatchesArgv()` returns false.                                                     |
| Shell control syntax in template                               | Pipe, interior or trailing `;`/`&&`, substitution, or multiple leaves in the reviewed template                    | Wrapper returns false. Do not test these as argv data values.                                             |
| Redirection in template                                        | `<`, `>`, or a parsed redirect on the reviewed template                                                           | Wrapper returns false even for a non-destructive redirect.                                                |
| Environment assignment in template                             | A leading `TOKEN=x`, `CONFIG=x`, proxy, credential, or CA assignment                                              | Wrapper returns false; existing catalog validation remains unchanged.                                     |

The existing assertions at
`capability-structured-invocation.test.ts:207-227` encode the old behavior and
are deletion/replacement targets: the flag suffix and extra operand under
`records list *` must become authorized proofs. Keep the exact-template excess
case at lines 213-218 as the no-terminal-wildcard falsifier.

Focused implementation command:

```bash
npm run test:unit -- apps/core/test/unit/runner/capability-structured-invocation.test.ts -t CAPSAFE-1-MATCHER
```

Then run the stage command recorded by the decomposition:

```bash
npm run test:unit -- capability-structured-invocation
```

## Deletion and cleanup proof

Delete in the matcher stage:

- `structuredArgvMatchesTemplate()` and its arity-exact/no-flag comment;
- the private `globMatches()` helper;
- their now-unused parser and leaf-type imports;
- stale mismatch copy saying `*` is always exactly one value;
- tests/comments that require a terminal wildcard to reject extra args or
  flags.

Do not delete `validateStructuredArgs()`, current grant/person resolution,
immutable executable verification, sandbox/egress enforcement, or the genuine
mismatch amendment path. Those are independent fail-closed boundaries, and
Decision 0130 relies on the host retaining them.

After implementation, these searches should find no active structured
arity-exact matcher or stale guidance:

```bash
rg -n "structuredArgvMatchesTemplate|arity-exact|exactly one value" apps/core/src/jobs/structured-local-cli-invocation.ts apps/core/test/unit/runner/capability-structured-invocation.test.ts
rg -n "localCliCommandTemplateMatchesArgv" apps/core/src/jobs/structured-local-cli-invocation.ts apps/core/src/jobs/capability-template-compiler.ts apps/core/src/shared/tool-rule-matcher.ts
```

The first search should return no matches. After the compiler stage, the second
should show one definition and the structured-execution/compiler callers.

## Surface Impact Matrix

| Surface                      | Classification      | Reason                                                                                                                                               |
| ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior             | Changed             | A terminal local-CLI `*` authorizes the remaining structured argv, including flags and values.                                                       |
| `settings.yaml`              | Unchanged by design | Existing reviewed templates and capability selections remain the authority; no new field or format is introduced.                                    |
| Postgres/runtime projection  | Unchanged by design | No schema or grant projection changes; current capability definitions are interpreted with the accepted semantics.                                   |
| Control API                  | Unchanged by design | No request or response shape changes.                                                                                                                |
| SDK/contracts                | Unchanged by design | `capability_run` remains `{ capabilityId, args[] }`.                                                                                                 |
| CLI                          | Unchanged by design | The Gantry CLI surface is unchanged; only host matching of a selected local CLI capability changes.                                                  |
| Gantry MCP tools/admin skill | Changed             | `capability_run` reaches the same host resolver, which now uses the shared terminal-remainder matcher. Its dispatcher bypass remains authority-free. |
| Channel/provider adapters    | Unchanged by design | No provider callback or channel permission path changes.                                                                                             |
| Docs/prompts                 | Changed             | Mismatch guidance must describe terminal remainder semantics; this blueprint records the cutover.                                                    |
| Audit/events                 | Unchanged by design | Decision, mismatch, and execution audit paths remain current; only whether a reviewed call matches changes.                                          |
| Tests/verification           | Changed             | Add the enumerated `CAPSAFE-1-MATCHER` matrix and remove arity-exact expectations.                                                                   |
