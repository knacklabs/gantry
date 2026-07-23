# Doc-Gardening Conventions

How documentation stays alive in an agent-authored codebase. Agents generate code at high throughput — docs rot within days without automated upkeep.

Inspired by: [Harness Engineering at OpenAI](https://openai.com/index/harness-engineering/) — "A recurring 'doc-gardening' agent scans for stale or obsolete documentation that does not reflect the real code behavior and opens fix-up pull requests."

## What Gets Gardened

| Target | What's Checked |
|--------|---------------|
| `AGENTS.md` | All file references exist on disk. All linked docs are current. Re-verified after any structural change (new module, new convention doc). |
| `docs/*.md` | Architecture, patterns, domain model, API docs — all must reflect actual code. |
| `plans/` | Active plans with no progress in 3+ days flagged stale. Completed plans not moved to `plans/done/` flagged. |
| `quality-grades.md` | Grades must match actual metrics from latest CI run. |
| Code comments | References to removed/renamed files, functions, or modules. |

## Doc-Gardening Agent Behavior

**Schedule:** Runs daily at midnight UTC, or after every 10 merged PRs — whichever comes first.

**What it does:**
- Scans all docs for broken references, stale dates, mentions of renamed/removed code, outdated examples
- Opens targeted fix PRs — small, one concern per PR
- Updates verification badges on design docs:
  - `✅ Verified` — content matches code, verified within 30 days
  - `⚠️ Needs Review` — not verified in 30+ days, or related code changed
  - `❌ Stale` — not verified in 60+ days, or references broken code

**What it does NOT do:**
- Rewrite docs from scratch — patches specific issues only
- Add new documentation — that's the implementing agent's job
- Remove docs without human approval — flags for review instead

**PR conventions:**
- Branch: `docs/garden/<target>-<date>` (e.g., `docs/garden/agents-md-2025-01-15`)
- Title: `docs: fix <specific issue>` (e.g., `docs: fix broken link to auth module in AGENTS.md`)
- One concern per PR. Never bundle unrelated fixes.

## check-docs.ts Linter (CI-Enforced)

Runs on every PR. Blocks merge on failure.

**Rules:**

| Rule | Severity | Description |
|------|----------|-------------|
| `FILE_REF_EXISTS` | error | Every file path referenced in `AGENTS.md` must exist on disk. |
| `DOC_HAS_VERIFIED_DATE` | error | Every `docs/*.md` file must end with `Last verified: YYYY-MM-DD`. |
| `VERIFIED_DATE_FRESH` | warn | `Last verified` date must be within 30 days. |
| `CROSS_LINKS_RESOLVE` | error | All `[text](path)` links between docs must resolve to existing files. |
| `CODE_EXAMPLES_VALID` | warn | Code examples in docs must compile, or be marked `` ```pseudocode ``. |
| `DOC_HAS_BADGE` | warn | Design docs must have a verification badge (`✅` / `⚠️` / `❌`). |
| `DOC_HAS_PURPOSE` | warn | Every doc must start with a one-line purpose statement (first non-empty line after `#` heading). |

**Error format:**
> "DOC_STALE: docs/architecture.md last verified 2024-11-01 (45 days ago). Update or re-verify. See conventions/doc-gardening.md"

## Freshness Rules

| Condition | Action |
|-----------|--------|
| PR changes code related to a doc | Doc must be updated in the same PR, or CI flags it. |
| Doc not updated in 30 days | Marked `⚠️ Needs Review`. Gardening agent opens review PR. |
| Doc not updated in 60 days | Marked `❌ Stale`. Gardening agent opens fix PR or flags for removal. |
| `AGENTS.md` after structural change | Must be re-verified. CI blocks merge until `Last verified` is bumped. |
| Plan active with no commit in 3 days | Gardening agent comments on plan PR: "Still active?" |

**"Related code" detection:** The gardening agent maps docs to code via:
- Explicit file paths in doc content
- Module names matching `apps/api/src/<module>/` or `apps/web/src/<module>/`
- Import paths referenced in code examples

## Doc Structure Requirements

Every doc must follow this structure:

```markdown
# Title

Purpose statement — one line explaining what this doc covers and why it exists.

⚠️ Needs Review <!-- verification badge -->

## Content sections...

<!-- code examples include file path context -->
<!-- apps/api/src/auth/guard/jwt.guard.ts -->
```ts
@Injectable()
export class JwtGuard extends AuthGuard('jwt') { ... }
```

Last verified: 2025-01-15
```

**Rules:**
- First line after `#` heading: one-line purpose statement
- Last line: `Last verified: YYYY-MM-DD`
- Headings follow consistent hierarchy — no skipping levels (`##` → `####` is invalid)
- Code examples include a comment with the file path where the code lives
- Code examples that aren't real must use `` ```pseudocode `` fence

## Anti-Patterns

| Anti-Pattern | Why It's Bad | Fix |
|-------------|-------------|-----|
| Aspirational docs | Describes what we *want*, not what *exists*. Agents read docs as truth and generate wrong code. | Document actual state. Use `plans/` for future state. |
| Untested code examples | Copy-pasted snippets drift from real code. Agents copy broken patterns. | Examples must compile or be marked `pseudocode`. |
| Permanent TODOs | `<!-- TODO: document error handling -->` sits forever. Agents ignore it. | Gardening agent converts stale TODOs (7+ days) to GitHub issues. |
| Duplicated information | Same auth flow described in 3 docs. One gets updated, others don't. Agents read the stale one. | Single source of truth. Other docs link, never copy. |
| Orphaned docs | Doc exists but nothing links to it. Nobody reads it. It rots. | Every doc must be reachable from `AGENTS.md` or `docs/index.md`. |

## Agent Responsibilities

| When | Who | Does What |
|------|-----|-----------|
| Writing new code | Implementing agent | Creates/updates related docs in the same PR. |
| Merging PRs | CI (`check-docs.ts`) | Validates all doc rules. Blocks on error. |
| Daily / every 10 PRs | Gardening agent | Scans for rot. Opens fix PRs. Updates badges. |
| Reviewing gardening PRs | Human or senior agent | Approves doc fixes. Ensures no meaning is lost. |

Last verified: 2025-03-15
