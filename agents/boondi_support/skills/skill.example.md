# Skill authoring reference (example + all options)

This is a **reference/template only — NOT an active skill.** It lives at
`skills/skill.example.md` (a loose file, not `skills/<id>/SKILL.md`), so Gantry
never materializes or loads it. Copy it as the starting point for a real skill.

A skill is a **folder** under `skills/`:

```
skills/
  my-skill/            ← folder name == the skill id you list in settings.yaml
    SKILL.md           ← REQUIRED. Frontmatter + body (the instructions).
    gantry.skill.json  ← OPTIONAL. Declares privileged actions (see below).
    references/         ← OPTIONAL. Extra files the body links to, read on demand.
      pricing.md
```

A flat `skills/my-skill.md` is **never discovered** — the loader scans
sub-directories of `skills/` and skips any that lack a `SKILL.md` inside.

---

## 1. SKILL.md — full example

```markdown
---
name: my-skill
description: One or two sentences naming exactly WHEN to use this skill. This is the only line the model sees by default, so it must enumerate the trigger conditions (the questions/intents that should pull the skill in).
user_invocable: false
disclosure: progressive
required_env: MY_API_TOKEN, MY_OTHER_SECRET
---

# My Skill — human-readable title

Everything below the closing `---` is the body: the actual instructions the
model follows once it opens the skill. Keep it focused. Push long tables and
data into `references/*.md` and link to them so the always-on prompt stays lean.

## When to use
...

## How to answer
...
```

---

## 2. Frontmatter options

> **Parser is flat `key: value`, not real YAML.** The file must start with
> `---` on line 1, and the block ends at the **first** closing `---`. Each key
> must start with a letter (`[A-Za-z][A-Za-z0-9_-]*`); the value is the rest of
> the line as a raw string. There are **no nested maps and no YAML arrays** —
> lists are written as comma/space-separated strings (see `required_env`).
> Lines starting with `#` are treated as comments and ignored.

### Read by Gantry

| Key | Required | What it does |
|-----|----------|--------------|
| `name` | **Yes** | Skill identity. **Must match the folder id** (case-insensitive, after sanitizing to `[A-Za-z0-9._-]`, max 120 chars) or materialization fails. Cannot be a reserved name (`claude-api`, `claude-in-chrome`, and other SDK-native names). |
| `description` | **Yes, in practice** | The trigger text. Injected into the always-on prompt and used by the model to decide relevance. With `disclosure: progressive` it is the **only** thing the model sees until it opens the skill — so spell out the intents/keywords that should trigger it. Captured into the catalog when the skill is registered. |
| `disclosure` | No | Gantry-specific. Only the literal value `progressive` is recognized. When set, Gantry's always-on skill block injects **only** `name` + `description` + a pointer to the folder, and the body is loaded on demand (smaller prompt prefix, lower latency, but one extra fetch on turns that need the body). **Omit it** (or any other value) to inline the full body every turn — the right default while a body is small or needed on most turns. |
| `required_env` | No | Comma/space-separated list of capability-secret names the skill needs (e.g. `FOO, BAR`). They become required secrets, provisioned through Gantry's secret flow — never hardcode secrets in the body. **Aliases (any one works):** `required_env`, `required_env_vars`, `env`, `env_vars`. |

### NOT read by Gantry (valid to include, but inert here)

| Key | Status |
|-----|--------|
| `user_invocable` / `user-invocable` | A Claude-native "can a human run this as a `/slash-command`" flag. **No effect for channel agents** like Boondi (there is no human typing slash commands). Harmless to keep as documentation of intent. |
| `allowed-tools` | **Not** read from frontmatter. Tool access is governed by the agent's `settings.yaml` capabilities / tool policy, not by the skill file. |
| `license`, `version`, `metadata`, … | Ignored by Gantry's parser. (`version` and content hash come from the catalog/storage, not frontmatter.) |

---

## 3. gantry.skill.json — privileged actions (optional)

Only needed if the skill must **run commands** that use capability secrets (a
knowledge-base skill like `boondi-kb` does **not** need this). Action
permissions are declared here, **not** in frontmatter:

```json
{
  "actions": [
    {
      "id": "validate-discount",
      "capabilityId": "my-skill.discount.validate",
      "displayName": "Validate a discount code",
      "risk": "read",
      "can": "Check whether a discount code is currently valid and its terms.",
      "cannot": "Create, edit, or delete discount codes.",
      "requiredEnvVars": ["MY_API_TOKEN"],
      "commandTemplates": ["node scripts/validate-discount.mjs {code}"]
    }
  ]
}
```

- `risk` is one of `read` | `write` | `admin`.
- `capabilityId` must be unique within the manifest; **max 20 actions**.
- `commandTemplates` are bound as `run_command` tool rules — the only commands
  the action is allowed to run.

---

## 4. Turning a skill on

A `SKILL.md` on disk is **inert until declared**. Enable it in the agent's
`settings.yaml` (runtime config, under `GANTRY_HOME` — not in this repo):

```yaml
agents:
  boondi_support:
    plugins:
      guardrail:
        file: guardrails/guardrail.ts
        model: haiku
        mode: both
      skills:
        - my-skill        # ← the folder id; must match skills/my-skill/
        - boondi-kb
```

`plugins.guardrail` activates one exact agent-owned guardrail file. `mode` may
be `both`, `deterministic`, or `classifier`; omitted mode defaults to `both`.
For Boondi-style policies that export an inline system prompt block, `both`
means deterministic screening followed by the main agent run, not a separate
classifier guardrail.
`plugins.skills` is a plain **list of folder ids** — there is no place in yaml
for `description`, `disclosure`, `user_invocable`, or any per-skill metadata.
All of that lives in the skill's frontmatter (above). yaml only switches skills
on/off.

---

## ⚠️ Editor warning: don't let a Markdown formatter touch SKILL.md

A Markdown format-on-save (Prettier / markdownlint / remark) does **not**
understand YAML frontmatter the way this loader does, and can silently destroy
it — turning `name: x` into a `## name: x` heading, dropping the closing `---`
fence, and converting `_italics_` → `*italics*`. A broken fence means the loader
parses **no name and no description**. If you edit skill files in an IDE,
exclude `**/skills/**/*.md` (or `SKILL.md`) from format-on-save, or edit them
with formatting disabled.
