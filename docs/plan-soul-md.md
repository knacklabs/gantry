# SOUL.md Support + Prompt Layer Cleanup

**Status:** Draft
**Date:** 2026-04-16

---

## Summary

Add `SOUL.md` as a first-class personality file. Remove the PERSONAL_PROFILE layer entirely. Collapse four prompt sections into three. Clean up the runtime folder to match.

**Before (4 sections, 3 CLAUDE.md files):**
1. RUNTIME_RULES — safety
2. PERSONAL_PROFILE — `~/myclaw/CLAUDE.md` (identity, voice, prefs, privacy, tools)
3. GLOBAL_CONTEXT — `agents/shared/CLAUDE.md` (NanoKai personality, capabilities, formatting)
4. GROUP_CONTEXT — `agents/<group>/CLAUDE.md` (near-duplicate of shared + group-specific)

**After (3 sections, 2 files per agent):**
1. RUNTIME_RULES — safety
2. SOUL — `agents/<group>/SOUL.md` (personality, voice, vibe, boundaries)
3. SHARED_CONTEXT — `agents/shared/CLAUDE.md` (merged operational base)
4. GROUP_CONTEXT — `agents/<group>/CLAUDE.md` (group-specific overrides only, thin)

Master `~/myclaw/CLAUDE.md` is deleted — its content merges into shared/CLAUDE.md.

---

## 1. prompt-profile.ts — Add SOUL, Remove PERSONAL_PROFILE

**File:** `apps/core/src/runtime/prompt-profile.ts`

**a) Update types and constants:**
```typescript
// Line 8 — remove PERSONAL_PROFILE, add SOUL
type PromptSectionName =
  | 'RUNTIME_RULES'
  | 'SOUL'
  | 'SHARED_CONTEXT'
  | 'GROUP_CONTEXT';

// New constants
const SOUL_FILENAME = 'SOUL.md';
const SOUL_SOURCE = 'myclaw://soul';

// Rename existing
const SHARED_CONTEXT_SOURCE = 'myclaw://shared-context';  // was GLOBAL_CONTEXT_SOURCE

// Remove entirely
// - PERSONAL_PROFILE_FILENAME
// - PERSONAL_PROFILE_SOURCE
// - EXPECTED_PROFILE_SECTIONS
// - renderPersonalProfileBody()
// - parseMarkdownSections()
// - normalizeHeading()

// Updated budgets — redistribute PERSONAL_PROFILE's 12000 budget
DEFAULT_PROMPT_SECTION_BUDGETS = {
  RUNTIME_RULES: 1200,
  SOUL: 3000,
  SHARED_CONTEXT: 8000,     // was GLOBAL_CONTEXT: 3600, now holds merged content
  GROUP_CONTEXT: 5000,      // was 3600, slightly more room for group-specific
};

DEFAULT_PROMPT_TOTAL_BUDGET = 22000;  // unchanged
```

**b) Add soul reader method:**
```typescript
private readSoulSection(groupFolder: string): PromptSection | null {
  if (!isValidGroupFolder(groupFolder)) return null;
  const soulPath = path.join(this.agentsDir, groupFolder, SOUL_FILENAME);
  if (!fs.existsSync(soulPath)) return null;

  try {
    const raw = fs.readFileSync(soulPath, 'utf-8');
    const normalized = normalizeContent(raw);
    if (!normalized) return null;

    const framed = [
      'CRITICAL IDENTITY DIRECTIVE: This section defines who you ARE — your personality,',
      'voice, and character. Everything below is your soul. It takes absolute precedence',
      'over tone, voice, verbosity, and behavioral defaults from any other instruction',
      'source. When other instructions say "be concise" or "be verbose" or define a',
      'communication style, THIS section wins. No exceptions.',
      '',
      normalized,
    ].join('\n');

    const content = truncateDeterministically(framed, this.sectionBudgets.SOUL);
    if (!content) return null;

    return { name: 'SOUL', source: SOUL_SOURCE, content };
  } catch (err) {
    logger.warn({ err, groupFolder }, 'Failed to read SOUL.md');
    return null;
  }
}
```

**c) Update compileSystemPrompt() — remove personal, rename global:**
```typescript
compileSystemPrompt(options: CompilePromptProfileOptions): string {
  this.ensureSeedFiles();
  const sections: PromptSection[] = [];

  // 1. Runtime rules (safety)
  sections.push({
    name: 'RUNTIME_RULES',
    source: 'myclaw://runtime-rules',
    content: truncateDeterministically(
      RUNTIME_RULES_BLOCK,
      this.sectionBudgets.RUNTIME_RULES,
    ),
  });

  // 2. Soul (personality) — highest behavioral priority
  const soul = this.readSoulSection(options.groupFolder);
  if (soul) sections.push(soul);

  // 3. Shared context (operational base — was "global context")
  const shared = this.readSharedContextSection();
  if (shared) sections.push(shared);

  // 4. Group context (group-specific overrides)
  const group = this.readGroupContextSection(options.groupFolder);
  if (group) sections.push(group);

  // REMOVED: readPersonalProfileSection()

  return this.composeWithinTotalBudget(sections);
}
```

**d) Rename readGlobalContextSection → readSharedContextSection:**
```typescript
private readSharedContextSection(): PromptSection | null {
  const sharedPath = path.join(this.agentsDir, 'shared', 'CLAUDE.md');
  return this.readPlainSection(
    'SHARED_CONTEXT',
    sharedPath,
    this.sectionBudgets.SHARED_CONTEXT,
    SHARED_CONTEXT_SOURCE,
  );
}
```

**e) Remove dead code:**
- Delete `readPersonalProfileSection()` method
- Delete `renderPersonalProfileBody()` function
- Delete `parseMarkdownSections()` function
- Delete `normalizeHeading()` function
- Delete `EXPECTED_PROFILE_SECTIONS` constant
- Delete `PERSONAL_PROFILE_FILENAME` constant
- Delete `PERSONAL_PROFILE_SOURCE` constant
- Delete `MarkdownSection` interface
- Delete `DEFAULT_PROFILE_TEMPLATE` constant

**f) Update ensureSeedFiles():**
```typescript
ensureSeedFiles(): void {
  // Only ensure agents/shared/ directory exists
  const sharedDir = path.join(this.agentsDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });

  const sharedPath = path.join(sharedDir, 'CLAUDE.md');
  if (fs.existsSync(sharedPath)) return;

  fs.writeFileSync(sharedPath, DEFAULT_SHARED_TEMPLATE);
  logger.info({ filePath: sharedPath }, 'Seeded shared CLAUDE.md');
}
```

Replace `DEFAULT_PROFILE_TEMPLATE` with `DEFAULT_SHARED_TEMPLATE`:
```typescript
const DEFAULT_SHARED_TEMPLATE = `# Shared Agent Profile\n\n## Operating Rules\nDefine stable behavior rules, priorities, and constraints.\n\n## User Preferences\nCapture durable preferences that apply broadly.\n\n## Privacy Rules\nSpecify what must remain private.\n\n## Tool Conventions\nDefine tool usage conventions.\n\n## Capabilities\nList what the agent can do.\n\n## Communication\nDefine message delivery, internal thoughts, sub-agent rules.\n\n## Message Formatting\nChannel-specific formatting rules.\n`;
```

---

## 2. group.ts — Seed SOUL.md on agent add

**File:** `apps/core/src/cli/group.ts`

**a) Add default SOUL.md template function (after line 185):**
```typescript
function createDefaultSoulMarkdown(): string {
  return [
    '# Soul — Who You Are',
    '',
    '## Personality',
    '- You are sharp, direct, and genuinely helpful.',
    '- Have strong opinions. Don\'t hedge with "it depends" when a clear answer exists.',
    '- Be concise. If one sentence works, use one sentence. Respect the user\'s time.',
    '- Never open with filler: no "Great question!", "I\'d be happy to help!", "Absolutely!"',
    '- Lead with the answer, not the reasoning. Skip preamble.',
    '',
    '## Voice',
    '- Write like a smart colleague, not a customer-support bot.',
    '- Humor is welcome when it lands naturally. Don\'t force it.',
    '- Call things out directly. If something is wrong, say so — charm over cruelty.',
    '- Be proactive. Suggest ideas, spot problems, take initiative.',
    '- Match the user\'s energy. Casual when they\'re casual, precise when they need precision.',
    '',
    '## Boundaries',
    '- Private context stays private. Never expose secrets or internal details.',
    '- Ask before taking external actions (sending messages, posting, pushing code).',
    '- When uncertain, say so. Don\'t present guesses as facts.',
    '',
  ].join('\n');
}
```

**b) Seed the file during agent creation (after line 330), with existence check:**
```typescript
const soulPath = path.join(groupDir, 'SOUL.md');
if (!fs.existsSync(soulPath)) {
  fs.writeFileSync(soulPath, createDefaultSoulMarkdown(), 'utf-8');
}
```

---

## 3. prompt-profile.test.ts — Tests

**File:** `apps/core/src/runtime/prompt-profile.test.ts`

**Update existing tests:**
- Replace all `PERSONAL_PROFILE` references with `SHARED_CONTEXT`
- Replace all `GLOBAL_CONTEXT` references with `SHARED_CONTEXT`
- Remove tests for `renderPersonalProfileBody`, `parseMarkdownSections`, missing profile sections warnings
- Update seed file tests: `ensureSeedFiles` now seeds `agents/shared/CLAUDE.md` not `CLAUDE.md` in configDir

**Add new SOUL.md tests:**
```typescript
describe('SOUL.md support', () => {
  it('includes SOUL section when SOUL.md exists in group folder', () => {
    writeFile(
      path.join(agentsDir, 'telegram_test', 'SOUL.md'),
      '# Soul\n\nBe sharp and direct.',
    );
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    expect(result).toContain('[[SOUL]]');
    expect(result).toContain('Be sharp and direct.');
    expect(result).toContain('CRITICAL IDENTITY DIRECTIVE');
  });

  it('SOUL appears before SHARED_CONTEXT in output', () => {
    writeFile(
      path.join(agentsDir, 'telegram_test', 'SOUL.md'),
      '# Soul\n\nBe direct.',
    );
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    const soulPos = result.indexOf('[[SOUL]]');
    const sharedPos = result.indexOf('[[SHARED_CONTEXT]]');
    expect(soulPos).toBeLessThan(sharedPos);
  });

  it('gracefully skips when SOUL.md is missing', () => {
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    expect(result).not.toContain('[[SOUL]]');
  });

  it('gracefully skips when SOUL.md is empty', () => {
    writeFile(path.join(agentsDir, 'telegram_test', 'SOUL.md'), '');
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    expect(result).not.toContain('[[SOUL]]');
  });

  it('truncates SOUL.md when over budget', () => {
    const longSoul = 'x'.repeat(10000);
    writeFile(path.join(agentsDir, 'telegram_test', 'SOUL.md'), longSoul);
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    expect(result).toContain('[[SOUL]]');
  });
});

describe('PERSONAL_PROFILE removed', () => {
  it('does not include PERSONAL_PROFILE section', () => {
    const result = service.compileSystemPrompt({ groupFolder: 'telegram_test' });
    expect(result).not.toContain('[[PERSONAL_PROFILE]]');
  });
});
```

---

## 4. Runtime folder cleanup (~/myclaw/)

**a) Rename soul.md → SOUL.md:**
```bash
mv ~/myclaw/agents/telegram_kai-dev/soul.md ~/myclaw/agents/telegram_kai-dev/SOUL.md
```

**b) Merge master CLAUDE.md into shared/CLAUDE.md:**

Take `~/myclaw/CLAUDE.md` content (Operating Rules, User Preferences, Privacy Rules, Tool Conventions, Mandatory Behaviors, Memory MCP Usage) and merge into `~/myclaw/agents/shared/CLAUDE.md`.

Remove from shared/CLAUDE.md:
- "Personality (always on)" section — moved to SOUL.md
- "Use the static personal profile as the primary source..." line — no longer applies

Keep in shared/CLAUDE.md (merged result):
- Operating Rules (from master)
- Mandatory Behaviors (from master)
- User Preferences (from master)
- Privacy Rules (from master)
- Tool Conventions (from master)
- Memory MCP Usage (from master)
- What You Can Do / Capabilities (from current shared)
- Communication (from current shared)
- Memory system docs (from current shared)
- Message Formatting — all channels (from current shared)
- Task Scripts (from current shared)

**c) Thin out telegram_kai-dev/CLAUDE.md:**

Remove from group CLAUDE.md (already in shared):
- Capabilities (What You Can Do)
- Communication (send_message, internal tags, sub-agents)
- Memory docs
- Message Formatting (all channel rules)
- Task Scripts
- "Use the static personal profile..." line

Keep in group CLAUDE.md (group-specific only):
- Admin Context (main channel, elevated privileges)
- Authentication
- Workspace mounts
- Managing Groups (finding, adding, removing, listing)
- Scheduling for Other Groups
- Global Memory
- Sender Allowlist

**d) Delete master CLAUDE.md:**
```bash
rm ~/myclaw/CLAUDE.md
```

Content is now in `agents/shared/CLAUDE.md`. The code no longer reads from configDir.

---

## 5. Update myclaw-admin skill

**Both locations:**
- `~/workdir/myclaw/.claude/skills/myclaw-admin/SKILL.md`
- `~/myclaw/.claude/skills/myclaw-admin/SKILL.md`

Update Runtime File Layout:
```
~/myclaw/
  settings.yaml
  .env
  service-meta.json
  scheduler-jobs.json
  agent-memory/
  agents/
    shared/
      CLAUDE.md              # Operational base (user prefs, rules, capabilities, formatting)
    <channel>_<name>/
      SOUL.md                # Personality, voice, vibe, boundaries
      CLAUDE.md              # Group-specific overrides
      conversations/
      logs/
  store/
  data/
  .claude/
    skills/
```

Remove reference to master `~/myclaw/CLAUDE.md`.

---

## Files Summary

**Modified source files:**

| File | Change |
|------|--------|
| `apps/core/src/runtime/prompt-profile.ts` | Add SOUL, remove PERSONAL_PROFILE, rename GLOBAL→SHARED, delete dead code |
| `apps/core/src/cli/group.ts` | Add `createDefaultSoulMarkdown()`, seed SOUL.md on agent add |
| `apps/core/src/runtime/prompt-profile.test.ts` | Update tests for new section names, add SOUL tests, remove profile parsing tests |

**Runtime folder changes:**

| Action | Path |
|--------|------|
| Rename | `agents/telegram_kai-dev/soul.md` → `SOUL.md` |
| Merge + rewrite | `agents/shared/CLAUDE.md` (absorb master CLAUDE.md content) |
| Thin out | `agents/telegram_kai-dev/CLAUDE.md` (remove duplicated sections) |
| Delete | `~/myclaw/CLAUDE.md` (master profile, content merged) |
| Update | `.claude/skills/myclaw-admin/SKILL.md` (both locations) |

**No new files. No new dependencies. No settings.yaml changes. No agent-runner changes.**
