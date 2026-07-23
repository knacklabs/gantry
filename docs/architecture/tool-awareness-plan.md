# Tool awareness across Anthropic SDK and DeepAgents

**Status:** proposed design; no implementation in this document
**Primary outcome:** an agent should choose an already available tool, skill, or
connected MCP source from the user's intent without the user naming that tool.
**Biggest lever:** replace the generic `CAPABILITY_GUIDANCE` prompt content with
a deterministic, agent-scoped Capability Catalog shared by both runtimes.

## Executive decision

Build one runtime-agnostic, read-only `AgentPromptCapabilityCatalog` from the
same active source bindings and reviewed capability selections that already
drive runtime projection. Render it once in the existing 1,500-character
`CAPABILITY_GUIDANCE` section, include its digest in the existing provider
session access fingerprint, and feed the compiled prompt to both
`anthropic_sdk` and DeepAgents exactly as today.

That is the minimum change that directly solves the complaint. It tells the
model, before it plans, which useful actions, skills, and MCP sources this agent
actually has. It also tells the model when to search connected MCP inventory
and when acquisition is necessary. It does not add a new permission system, a
semantic index, or a second prompt pipeline.

Finish the honest `mcp_search_tools` state and acquisition refresh work already
owned by #237. Add Claude-native Tool Search refinements and description quality
gates after the shared catalog is measured. Do not build a DeepAgents-specific
retriever unless behavioral evaluation shows that the catalog plus
`mcp_search_tools` stops selecting accurately at the actual projected tool
counts.

## Product model and invariants

**Product model:** the Capability Catalog is a read-only prompt projection of
an agent's connected inventory and selected reviewed authority; it never grants
authority, and every call remains subject to the existing runtime projection,
permission, sandbox, credential, and call-time checks.

The design preserves these invariants:

1. An active skill binding means the skill's instructions are installed for
   this agent. It does not grant every action mentioned by that skill.
2. An active MCP source binding means its inventory can be discovered. It does
   not make every server tool callable.
3. Only an active selected reviewed capability may be described as a ready
   action. A semantic capability definition in the app-wide catalog is not
   authority by itself.
4. `mcp_search_tools` discovers inventory. `mcp_call_tool` remains the
   call-time authority check.
5. Catalog text and search results never turn MCP-provided descriptions or
   server instructions into trusted instructions.
6. Locked agents see provisioned capabilities only and never receive acquire or
   approval guidance.
7. Persistent capability selection is unchanged. Transient approval is
   unchanged. The catalog only makes their current outcomes visible to the
   model.

## Success criteria

The work is complete when all of the following are true:

- On both `anthropic_sdk` and DeepAgents, prompts that describe a task but do
  not name a tool cause the agent to choose the matching selected capability or
  installed skill.
- A task matching a connected, inventory-only MCP source causes the agent to
  call `mcp_search_tools`; a `Callable now` result is called and an `Acquire
first` result enters the reviewed acquisition flow.
- After an install or approval, the next turn contains the new catalog entry
  and does not resume a provider session or prompt-cache namespace created for
  the old access projection.
- The catalog never labels an unselected capability or inventory-only MCP tool
  as ready.
- The same canonical catalog data and rendering rules serve worker and inline
  execution in both runtime families.
- The static catalog is stable across ordinary turns and changes only when its
  agent access or reviewed descriptive metadata changes.

## Current state

### Shared prompt assembly

`CAPABILITY_GUIDANCE` is live, but it is generic rather than populated from the
agent's access:

- The prompt compiler gives the section a 1,500-character budget within a
  26,000-character total budget (`apps/core/src/application/agents/prompt-profile-service.ts:34-45`).
- `capabilityGuidancePrompt` accepts only persona and access preset. Its text
  discusses memory, rendering, mounted tools, and delegation, but receives no
  skill, MCP, or selected-capability data
  (`apps/core/src/application/agents/prompt-profile-service.ts:127-155`).
- The function is used to create the live `CAPABILITY_GUIDANCE` section
  (`apps/core/src/application/agents/prompt-profile-service.ts:524-533`). The
  live `OPERATING_GUIDANCE_BLOCK` separately gives generic MCP and acquisition
  directions (`apps/core/src/application/agents/prompt-profile-service.ts:188-215`,
  `apps/core/src/application/agents/prompt-profile-service.ts:239-246`). The
  section is therefore under-populated, not dead.
- `compileSpawnSystemPrompt` passes agent identity, persona, access preset,
  model identity, and runtime context, but no resolved access catalog
  (`apps/core/src/runtime/agent-spawn-prompt.ts:13-68`).
- Real access is resolved later in the turn: tool policy, selected skill
  bindings, selected MCP source ids, and semantic definitions are loaded and
  fingerprinted in `group-agent-runner`
  (`apps/core/src/runtime/group-agent-runner.ts:365-386`), then supplied to the
  runner (`apps/core/src/runtime/group-agent-runner.ts:530-553`). Skill context
  currently contains ids and display strings, not descriptions
  (`apps/core/src/runtime/group-run-context.ts:38-62`).
- The shared runner prompt wraps the compiled profile into the static identity
  prefix and adds another static, generic `PUBLIC_CATALOG`
  (`apps/core/src/runner/gantry-agent-system-prompt.ts:47-59`,
  `apps/core/src/runner/gantry-agent-system-prompt.ts:68-102`,
  `apps/core/src/runner/gantry-agent-system-prompt.ts:144-163`). That list can
  name tools that are not mounted and cannot tell the model what is specific to
  this agent.

The only detailed access summary available to the model today is reactive.
`capabilityStatusText()` can list mounted actions, selected skills, and MCP
sources (`apps/core/src/runner/mcp/context.ts:215-265`,
`apps/core/src/runner/mcp/context.ts:321-352`), but it is appended to MCP proxy
tool results rather than placed in the initial prompt
(`apps/core/src/runner/mcp/tools/mcp-proxy-tools.ts:100-104`,
`apps/core/src/runner/mcp/tools/mcp-proxy-tools.ts:155-171`). The operating
prompt refers to `capability_status` as though the agent already has that view
(`apps/core/src/application/agents/prompt-profile-service.ts:195-199`), while
the baseline Gantry MCP surface has no tool with that name
(`apps/core/src/runner/gantry-mcp-tool-surface.ts:12-44`). This is the central
reason awareness often arrives only after the agent has already chosen a path.

### Prompt-cache boundary

The shared prompt already has the correct structural split. Static identity,
profile, tooling, skills, and control guidance precede dynamic workspace, time,
and runtime facts (`apps/core/src/runner/gantry-agent-system-prompt.ts:93-126`).
The Anthropic worker inserts `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` between those
parts (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/system-prompt.ts:42-71`),
as does the Anthropic inline lane
(`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts:435-457`).

The existing access fingerprint is close to the required invalidation seam. A
changed fingerprint expires the resumed provider session before execution
(`apps/core/src/runtime/group-agent-runner.ts:380-413`). However, fingerprint v1
contains selected ids and normalized runtime bindings but omits the descriptive
metadata that the proposed catalog will render
(`apps/core/src/runtime/provider-session-access-fingerprint.ts:6-29`,
`apps/core/src/runtime/provider-session-access-fingerprint.ts:79-88`). A renamed
skill or changed capability description could therefore change the static
prompt without changing the current fingerprint.

DeepAgents has a second mismatch: its provider prompt-cache key is currently a
hash of conversation and thread only
(`apps/core/src/adapters/llm/deepagents-langchain/prompt-cache.ts:7-29`). It does
not partition the cache by the access projection.

### Anthropic SDK lane

#### Worker process

- Gantry counts projected tools and MCP servers, rejects unproven non-first-party
  proxy support, and otherwise sets `ENABLE_TOOL_SEARCH=auto:10`. The loopback
  gateway is explicitly recognized as
  `gantry_gateway_tool_reference_pass_through`
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:31-95`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:129-150`).
- The worker composes the real runtime tool/MCP projection, sets the Tool Search
  environment decision, and sends the shared system prompt, SDK skills, tool
  allow/deny lists, and MCP server configs to `query`
  (`apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:268-362`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:368-402`,
  `apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:438-450`).
- The SDK-native search summary is derived from registered tool names and
  descriptions. Gantry's only explicit category hint is still the generic
  `PUBLIC_CATALOG`, not a summary of the agent's real selected capabilities.

Native Tool Search therefore helps the worker choose among already registered
tools, but it cannot compensate for weak descriptions or tell the agent about
inventory that was intentionally not projected. The shared catalog and
`mcp_search_tools` have different jobs: the former establishes intent-level
awareness; SDK Tool Search retrieves registered definitions; the latter finds
inventory that may require acquisition.

#### Inline execution

Inline Anthropic binds the core SDK MCP server and direct reviewed remote MCP
servers, and preserves core tool descriptions when it creates SDK tool
definitions (`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts:129-223`,
`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts:363-392`).
It does not run the shared `decideClaudeSdkToolSearch` decision or set
`ENABLE_TOOL_SEARCH` in its isolated environment
(`apps/core/src/adapters/llm/anthropic-claude-agent/inline-lane/index.ts:417-432`).
Because Gantry uses a loopback base URL, the research brief says the SDK would
otherwise auto-disable Tool Search. This is a lane-specific parity gap.

### DeepAgents/LangChain lane

#### Worker process

- The host adapter derives the provider prompt-cache setting, projects the
  selected DeepAgents skill files, and forwards semantic definitions in the
  runner input (`apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts:133-145`,
  `apps/core/src/adapters/llm/deepagents-langchain/execution-adapter.ts:190-200`).
- Selected skill files are projected into `/skills/`; the DeepAgents adapter
  requires `SKILL.md` frontmatter name and description at projection time
  (`apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts:22-60`,
  `apps/core/src/adapters/llm/deepagents-langchain/skill-projection.ts:140-173`).
- Gantry and permitted third-party MCP definitions are loaded as LangChain
  tools (`apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts:40-57`,
  `apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts:98-160`).
  Declarative-rule wrapping preserves each underlying name, description, and
  schema (`apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts:258-297`).
- `createDeepAgent` receives the shared prompt, the projected skills, and the
  entire connected tool list
  (`apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts:146-160`,
  `apps/core/src/adapters/llm/deepagents-langchain/runner/deep-agent-runner.ts:229-252`).

Descriptions do reach the LangChain binding. There is no Tool Search or other
tool-definition retrieval step: the complete projected list is handed to
`createDeepAgent`. This confirms the brief's expected gap. DeepAgents currently
depends on the model reading all bound descriptions plus the same generic
prompt catalog.

#### Inline execution

Inline DeepAgents also passes the complete tool list to `createDeepAgent`, with
skill middleware and the shared prompt
(`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts:151-215`).
Core and remote MCP wrappers preserve descriptions and schemas
(`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts:448-466`,
`apps/core/src/adapters/llm/deepagents-langchain/inline-lane/index.ts:514-581`).
It likewise has no retrieval layer.

### `mcp_search_tools` reachability and result semantics

For worker execution in both runtime families, `mcp_search_tools` is a baseline
Gantry MCP tool (`apps/core/src/runner/gantry-mcp-tool-surface.ts:12-44`): the
Anthropic worker always projects the Gantry MCP server with its selected tool
set (`apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts:293-319`,
`apps/core/src/adapters/llm/anthropic-claude-agent/agent-capabilities.ts:348-357`),
and the DeepAgents worker connects and filters that same Gantry facade
(`apps/core/src/adapters/llm/deepagents-langchain/runner/mcp-tools.ts:98-160`).

Inline execution is not at parity. The shared inline core registry contains
only messaging, memory, and task/delegation tools
(`apps/core/src/runtime/core-tools/registry.ts:81-91`,
`apps/core/src/runtime/core-tools/registry.ts:192-208`), so neither inline
runtime receives the Gantry MCP inventory proxy even though both can bind
already-reviewed remote MCP tools directly.

Search itself is intentionally simple and appropriate for the current scale:
it matches all query terms over server, tool name, and description, then ranks
exact/prefix/name/description/server matches
(`apps/core/src/application/mcp/mcp-tool-inventory.ts:187-223`,
`apps/core/src/application/mcp/mcp-tool-inventory.ts:318-340`). It already joins
results to selected reviewed MCP capabilities
(`apps/core/src/application/mcp/mcp-tool-proxy.ts:307-361`). The formatted
response honestly explains callable-through-proxy versus inventory-only
(`apps/core/src/runner/mcp/tools/service-formatters.ts:181-215`).

The structured contract is less clear: every base inventory result says
`callable: false` (`apps/core/src/application/mcp/mcp-tool-inventory.ts:9-17`,
`apps/core/src/application/mcp/mcp-tool-inventory.ts:231-243`) while the search
wrapper may add `coveredByReviewedCapability: true`
(`apps/core/src/application/mcp/mcp-tool-proxy.ts:96-107`). A model or future
adapter consuming structured data can observe two apparently contradictory
signals.

### Names, descriptions, and MCP server instructions

- MCP server definitions have a required machine name but optional display name
  and description; validation enforces identifier syntax, not discoverability
  (`apps/core/src/domain/mcp/mcp-servers.ts:36-58`,
  `apps/core/src/domain/mcp/mcp-servers.ts:111-135`). Runtime materialization
  currently drops display name and description
  (`apps/core/src/application/mcp/mcp-server-materialization.ts:20-32`).
- Skill catalog descriptions are optional, and installation can fall back to
  `uploaded-skill` with no description
  (`apps/core/src/domain/skills/skills.ts:34-50`,
  `apps/core/src/application/skills/skill-service.ts:306-349`). DeepAgents then
  requires name and description only when it projects the skill, creating a
  late and runtime-specific failure.
- Tool catalog descriptions are optional
  (`apps/core/src/domain/tools/tools.ts:26-45`). Semantic capability definitions
  are stronger: display name, category, `can`, and `cannot` are required
  (`apps/core/src/shared/semantic-capabilities.ts:52-81`,
  `apps/core/src/shared/semantic-capabilities.ts:199-216`). Their Tool Catalog
  projection nevertheless flattens every category to `productivity`
  (`apps/core/src/domain/tools/agent-tool-catalog-references.ts:136-155`), which
  weakens category search.
- The persisted MCP server definition and the materialized runtime shape have no
  field for MCP initialization `instructions`
  (`apps/core/src/domain/mcp/mcp-servers.ts:36-58`,
  `apps/core/src/application/mcp/mcp-server-materialization.ts:20-32`). They are
  therefore neither retained nor surfaced today.
- The existing read-only Agent Access Summary already joins sources and selected
  access, but exposes labels and coarse details rather than descriptions
  (`apps/core/src/application/agents/agent-access-summary.ts:5-35`,
  `apps/core/src/application/agents/agent-access-summary.ts:60-99`). It is useful
  precedent, not sufficient prompt data.

## Proposed design

### 1. Canonical agent prompt capability projection — P0, runtime-agnostic

Add one application-layer projection service, conceptually:

```ts
interface AgentPromptCapabilityCatalog {
  schemaVersion: 1;
  readyActions: CatalogEntry[];
  installedSkills: CatalogEntry[];
  connectedMcpSources: CatalogEntry[];
  digest: string;
}

interface CatalogEntry {
  kind: 'reviewed_capability' | 'skill' | 'mcp_source';
  stableRef: string; // internal only; never rendered by default
  revision?: string; // internal only; invalidates stale projections
  displayName: string;
  description: string; // one line, normalized and bounded
  category: string;
  accountLabel?: string;
}
```

Resolve it once per run beside the existing access projection in
`group-agent-runner`, before prompt compilation. Reuse the existing repository
bindings and semantic definitions; do not introduce a new table or a second
authority model.

Resolution rules are intentionally strict:

- `readyActions` is the intersection of active agent tool/capability bindings
  and their active definitions. Do not list every semantic definition returned
  for rule expansion.
- `installedSkills` comes only from active usable skill bindings for this agent.
- `connectedMcpSources` comes from active authorized source bindings, including
  inventory-only bindings. Use reviewed `displayName` and `description`, not
  network-fetched tool text.
- Omit disabled, missing, invalid, or wrong-app rows. Emit an existing startup
  diagnostic with counts; do not fail the run solely because descriptive text
  is missing.
- Use the same normalizers used by admin/access displays for readable names.
  Include an account label only when it disambiguates two otherwise identical
  services. Never render secrets, configuration, URLs, raw UUIDs, credential
  references, command templates, or `cannot` detail in the compact catalog.

The data flow is:

```text
active source bindings + active reviewed selections + catalog metadata
                              |
                              v
              AgentPromptCapabilityCatalog + digest
                    |                         |
                    v                         v
       CAPABILITY_GUIDANCE renderer   access/session/cache fingerprint
                    |
                    v
        shared Gantry prompt -> Anthropic SDK / DeepAgents
```

This projection should be a narrow application concept. Do not make
`PromptProfileService` query repositories and do not make provider adapters
reconstruct access from environment variables.

### 2. Render the real Capability Catalog in the existing prompt section — P0,

runtime-agnostic

Change `capabilityGuidancePrompt` to accept the canonical projection. Replace
its duplicated generic tool prose with the real catalog. Keep the existing
1,500-character section budget for the first rollout; do not enlarge the total
system prompt before evaluation demonstrates a miss caused by truncation.

The rendered shape should be concise and directive:

```text
# Capability catalog
This is a read-only snapshot for this agent; execution policy still applies.
Use a matching ready action or installed skill without waiting for the user to name it.

Ready actions
- Calendar · Team calendar — Find availability and create or update events.

Installed skills
- incident-triage — Diagnose an incident from logs, health, and recent changes.

Connected MCP sources
- Linear — Search issues, projects, comments, and workflow metadata.

Discovery
- Search connected MCP inventory with mcp_search_tools.
- Callable now -> mcp_call_tool. Acquire first -> request_access for the reviewed capability.
```

For a locked agent, omit the acquisition line and render:

```text
- Search connected MCP inventory with mcp_search_tools when it is mounted. If no provisioned action fits, say what is unavailable.
```

Budget rules must be deterministic and whole-entry safe:

1. Reserve space for the heading, authority sentence, and discovery footer.
2. Sort by category, normalized display name, then stable ref.
3. Keep every selected ready-action name. Cap its description before dropping
   an action.
4. Then render installed skills and connected sources with one-line
   descriptions capped at 160 characters.
5. If the section still overflows, omit only complete trailing entries and add
   `+N more installed skills` / `+N more connected sources`; never character-cut
   an entry into a misleading fragment.
6. Record rendered and omitted counts in a startup diagnostic so evaluation can
   decide whether 1,500 characters is too small.

Remove the static `PUBLIC_CATALOG` duplication or reduce it to a two-line
provider-neutral statement pointing at `# Capability catalog`. It must no
longer claim Web, Files, Scheduler, or Admin availability without reference to
the actual mounted projection. Keep operating/safety policy in
`OPERATING_GUIDANCE_BLOCK`; keep awareness in `CAPABILITY_GUIDANCE`.

### 3. Make the static catalog cache-safe — P0, runtime-agnostic with adapter

plumbing

The catalog belongs before `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`: it is stable for an
access configuration and should be cached with persona/SOUL/tooling, not rebuilt
as a per-message dynamic tail.

Use one invalidation value, not parallel cache concepts:

1. Canonically serialize the projection fields that are rendered plus stable
   skill-content/version and MCP source revisions that affect the projected
   runtime surface.
2. Hash that serialization into `catalog.digest`.
3. Bump the provider access fingerprint schema to v2 and include
   `capabilityCatalogDigest`. Rendered metadata changes and projected
   skill-content/version, MCP source-revision, or selection changes then
   invalidate the old session.
4. Thread that same access fingerprint through `AgentInput` to
   `resolveDeepAgentsPromptCache`; add it to the current conversation/thread
   cache-key hash.
5. Preserve the current Anthropic boundary array. The common fingerprint check
   already expires stale resumptions; the v2 digest makes it complete.
6. Apply the same fingerprint to inline and worker execution. Do not include
   current time, user message, memory retrieval, tool-search results, health
   probes, or other turn-varying data in the catalog or its digest.

This is the #236-compatible interpretation of “semi-static”: static within one
access fingerprint, rebuilt on the next run after access or reviewed metadata
changes.

### 4. Make names and descriptions searchable — P1, runtime-agnostic contract

Improve metadata at the existing authoring/review boundaries rather than
inventing a post-hoc AI description service.

- **MCP sources:** require a human display name and a single-sentence reviewed
  description for new or updated definitions. The machine `name` remains the
  stable namespace. Recommended copy names the service, resources, and primary
  actions, including likely user vocabulary.
- **Skills:** require valid `SKILL.md` name and description during install or
  proposal acceptance for both runtimes, using the stricter existing
  DeepAgents constraints as the shared validation point. Reject before a
  success receipt rather than at the next DeepAgents spawn.
- **Reviewed capabilities:** retain the required display/category/can/cannot
  fields, render `can` as the one-line discovery description, and preserve the
  real category when projecting a semantic capability to the Tool Catalog.
- **Gantry-owned and MCP tool definitions:** audit names and descriptions using
  service/resource namespacing and “explain it to a new teammate” language.
  Put formats, niche terms, and resource relationships in descriptions. Avoid
  cryptic ids in display surfaces.
- **Existing incomplete rows:** do not add a compatibility schema or persisted
  backfill. Render a deterministic, clearly generic fallback, emit a metadata
  quality diagnostic, and require good metadata on the next create/update.

Add a shared metadata lint used by Control API, CLI, approved Gantry admin/MCP
write paths, and skill proposal/install acceptance. It should reject multiline
or blank descriptions, secrets, credential values, raw config fragments,
descriptions that merely repeat the name, and values beyond the catalog limit.
It should warn, not hard fail, on missing optional search synonyms until the
behavioral corpus proves a
need for a separate keywords field.

Do not add embeddings or a keywords column in this phase. Current FTS and
Claude Tool Search both improve immediately from names and descriptions.

#### MCP server `instructions`

Capture the bounded MCP initialization `instructions` in the inventory cache
and surface it only in `mcp_list_tools` / `mcp_describe_tool` output, labeled
`untrusted_mcp_server` and passed through the existing untrusted metadata
formatter. Do not place live server instructions in the system prompt, do not
let them change authority, and do not use them as the canonical source
description. An admin may explicitly promote a useful synopsis into the
reviewed MCP server description through the normal desired-state path.

Initially exclude server instructions from ranking so an untrusted server
cannot keyword-stuff itself above reviewed metadata. Reconsider only with an
adversarial retrieval evaluation.

### 5. Give `mcp_search_tools` one honest state and every execution mode — P0,

runtime-agnostic

Keep the existing FTS implementation and the same application proxy. Replace
the contradictory booleans with one canonical search-result field:

```ts
availability: 'callable_now' | 'acquire_first';
```

Optionally return a human `capabilityDisplayName`; keep raw reviewed ids in
technical detail only. The formatter must use exactly these labels:

- `Callable now — use mcp_call_tool.`
- `Acquire first — request the reviewed <display name> capability.`

`mcp_call_tool` still rechecks current authority. Search success never grants
access.

Expose the existing `mcp_list_tools`, `mcp_search_tools`, `mcp_describe_tool`,
and `mcp_call_tool` facades through the shared inline core-tool adapter as well
as the worker Gantry MCP server. Reuse the same application service, IPC/auth
context, formatting, and audit path; do not duplicate inventory connections in
the inline adapters. If a fixed-image/locked mode cannot mount acquisition
tools, it still gets discovery and callable-now results but receives no acquire
instruction it cannot execute.

Prompt language must distinguish both search layers:

- Claude SDK Tool Search searches definitions already registered in the current
  SDK run.
- Gantry `mcp_search_tools` searches connected source inventory, including
  tools not projected because the agent has not acquired reviewed authority.
- DeepAgents has only the second explicit search mechanism; its currently bound
  tools remain normal LangChain definitions.

### 6. Close post-acquisition awareness — P0, runtime-agnostic

Keep #237's no-mid-run-rematerialization decision. On successful install,
source binding, or capability approval:

1. Commit the existing desired-state/repository change and runtime projection.
2. Emit an honest receipt describing what is usable in the current call and
   what appears on the next message.
3. On the next message, resolve the catalog again. The new catalog digest
   changes fingerprint v2, expires the stale provider session, partitions the
   DeepAgents prompt cache, and rebuilds the prompt before planning.
4. The new entry is now visible without the user saying “use X.”

Canonical receipt copy:

- MCP source: `Connected now. I can search its inventory and call already-reviewed actions through Gantry now; newly projected direct tools appear on your next message.`
- Skill: `Installed now. I can use the reviewed skill content available in this run; its native runtime projection appears on your next message.`
- Capability: `Approved. <Display name> will appear as a ready action on your next message.`

If a current-call path is not actually available in a particular execution
mode, omit that clause. Never promise a same-turn tool definition refresh.

### 7. Lane-specific optimizations — P1/P2

#### Anthropic SDK

1. **P1: inline Tool Search parity.** Reuse
   `decideClaudeSdkToolSearch` for inline Anthropic after its complete core and
   MCP projection is assembled, set `ENABLE_TOOL_SEARCH` in the isolated env,
   and emit the existing startup diagnostic. Preserve the fail-closed behavior
   for unproven non-first-party proxies.
2. **P1: summary alignment.** Use the catalog's category vocabulary in the
   static prompt; let native Tool Search continue to index registered names and
   descriptions. Do not build a second Claude-only catalog.
3. **P1: tune `auto:10` from evidence.** Capture tool count and selection score
   in the behavioral eval. Keep `auto:10` unless an A/B run shows a better
   threshold; do not tune from the research limit alone.
4. **P2: `input_examples`.** Add them only to Gantry-owned complex,
   nested, or format-sensitive SDK tool definitions whose evals show argument
   errors. Verify the installed SDK's typed tool-definition path supports the
   field before implementation. Do not stuff examples into descriptions and do
   not invent a non-standard extension for arbitrary MCP servers.

#### DeepAgents/LangChain

1. **P0:** rely on the shared catalog for intent-level awareness and on Gantry
   `mcp_search_tools` for inventory discovery. Tool descriptions already reach
   LangChain; fix their quality at the source.
2. **P2, eval-triggered only:** if real projected sets cross the observed
   accuracy threshold, add a deterministic per-turn selection middleware using
   the same names/descriptions. Always pin core safety/control tools and
   selected task-critical capabilities, then retrieve a bounded top K for the
   user task. Preserve call-time policy.
3. Do not add embeddings, a vector store, or a parallel semantic capability
   index until the FTS/catalog evaluation demonstrates a miss class that
   lexical descriptions cannot address.

#### Tool consolidation

Treat consolidation as product-specific follow-up, not part of this complaint's
minimum fix. When eval traces repeatedly show the model choosing among several
low-level primitives for one user intent, replace those primitives with one
high-level Gantry-owned action. Do not consolidate speculatively.

## Runtime-agnostic versus lane-specific split

| Proposal                 | Shared/runtime-agnostic                                                     | Anthropic SDK                                                     | DeepAgents/LangChain                                                     |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Real Capability Catalog  | One resolver, schema, renderer, budget, and digest                          | Consumes shared compiled static prompt                            | Consumes shared compiled static prompt                                   |
| Authority states         | Selected capability = ready; skill = instructions; MCP source = inventory   | Call gate remains SDK/Gantry policy                               | Call gate remains wrapper/Gantry policy                                  |
| Description/name quality | One authoring lint and reviewed metadata model                              | Native Tool Search benefits from names/descriptions               | Bound definitions and future retrieval use the same metadata             |
| MCP inventory search     | One proxy, result contract, formatter, audit path; worker + inline exposure | Complements native search for unprojected inventory               | Only explicit inventory-search mechanism                                 |
| Cache invalidation       | Catalog digest in access fingerprint v2                                     | Expire stale resume; catalog remains before dynamic boundary      | Add fingerprint to prompt-cache key; common expiry prevents stale resume |
| Post-acquisition refresh | Re-resolve on next turn; no mid-run prompt mutation                         | Native/direct definitions appear after respawn                    | Bound definitions/skills appear after graph rebuild                      |
| Native tool retrieval    | None                                                                        | Existing Tool Search; add inline parity and evidence-based tuning | None in P0                                                               |
| `input_examples`         | Shared examples may inform eval cases                                       | Project only where SDK path supports them                         | No binding change in P0                                                  |
| Large-set preselection   | Deferred until measured                                                     | Native Tool Search already handles it                             | Optional deterministic middleware only if eval threshold trips           |

## Prioritized rollout and PR ownership

### P0-A — fold into #237 acquisition work

Keep this bounded to seams #237 already owns:

1. Replace `callable:false` plus `coveredByReviewedCapability` with the canonical
   `availability` result and exact `Callable now` / `Acquire first` copy.
2. Preserve #237's FTS implementation; do not add embeddings.
3. Mount the four Gantry MCP inventory/proxy facades in both inline runtimes by
   reusing the same service and authority context. Do not claim parity in tests
   until this is done.
4. Keep #237's honest current-call versus next-message receipts and add the
   acquisition -> next-turn -> unprompted use E2E row.
5. Preserve its inventory-only MCP source projection fix, because the prompt
   catalog cannot advertise a source the next run silently drops.

This belongs in #237 because its current scope explicitly owns FTS search,
honest receipts, inventory-only projection, inline acquisition behavior, and
next-turn use (`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:42-51`,
`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:98-114`,
`docs/architecture/mcp-skill-acquisition-alignment-goal-prompt.md:128-141`).

### P0-B — own PR: shared Capability Catalog and cache safety

This is the biggest-lever PR and the minimum standalone fix for the complaint:

1. Add the canonical projection service and focused authority tests.
2. Thread it into `compileSpawnSystemPrompt` once for worker and inline runs.
3. Replace generic `CAPABILITY_GUIDANCE` and remove the false/duplicated static
   public catalog.
4. Include the catalog digest in access fingerprint v2 and the DeepAgents prompt
   cache key.
5. Add prompt snapshots, budget/truncation tests, and both-runtime behavioral
   evals.

Land after or rebase onto #237 so the catalog can give truthful
`mcp_search_tools` guidance without duplicating its search and receipt changes.

### P1 — own PR: metadata quality and Claude parity

1. Move skill metadata validation to shared install/acceptance.
2. Enforce reviewed MCP/capability descriptions on new writes and preserve real
   semantic categories.
3. Capture and safely surface untrusted MCP server instructions.
4. Enable the existing Tool Search decision in Anthropic inline execution.
5. Run the description-quality eval and update only descriptions with proven
   misses.

Keep `input_examples` in a separate, very small follow-up if the installed SDK
surface and argument-error eval justify it; it should not delay the catalog.

### P2 — only after an eval tripwire

If either DeepAgents runtime falls below 90% correct first-action selection once
more than 30 projected non-core tools are present, prototype deterministic top-K
preselection. If the measured set stays below that scale or the shared catalog
keeps accuracy above the threshold, build nothing.

## Behavioral test and evaluation strategy

### Deterministic unit and integration tests

- **Projection authority:** active selected capabilities appear in
  `readyActions`; app-wide but unselected definitions do not. Active skill and
  MCP source bindings appear in their own inventory categories. Disabled and
  cross-app rows do not.
- **Prompt rendering:** both prompt modes contain the same catalog entries;
  locked mode omits acquisition guidance. Ordering and whole-entry truncation
  are deterministic and fit 1,500 characters.
- **Cache safety:** clock/message changes preserve the catalog digest and static
  prefix; selection, description, category, skill version/content hash, or MCP
  source revision changes alter fingerprint v2. DeepAgents cache keys differ by
  fingerprint. Anthropic still places the catalog before
  `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`.
- **MCP state:** a covered result has only `callable_now`; an uncovered result
  has only `acquire_first`; the latter cannot pass `mcp_call_tool` without a
  later approved capability.
- **Projection parity:** worker and inline executions in both runtime families
  receive the same catalog digest and the four MCP inventory/proxy facades when
  policy permits them.
- **Metadata trust:** MCP server instructions are bounded, escaped, labeled
  untrusted, absent from the system prompt, and unable to change result
  availability.

### Model behavioral eval

Create a small checked-in gold corpus of task prompts that deliberately omit
tool and skill names. Each case declares setup and expected first useful action,
not exact prose. Include at least:

1. selected calendar capability -> inspect availability;
2. selected issue tracker capability -> search issues;
3. installed incident skill -> read/use the skill;
4. connected inventory-only source -> `mcp_search_tools` then acquire;
5. connected callable source -> `mcp_search_tools` then `mcp_call_tool`;
6. two similarly named services -> choose by description/account label;
7. no matching capability -> do not hallucinate availability;
8. newly approved capability on the next message -> use without reminder.

Run every case on `anthropic_sdk` and DeepAgents, covering worker and inline
where that surface differs. Evaluate tool/capability choice, authorization
state, and first-action latency. The gate is at least 90% correct first useful
action per runtime across repeated runs, 100% correct authority state, and no
regression from catalog-on versus catalog-off on the negative controls. Keep
temperature/model controls fixed and retain traces as evidence.

### Description-quality eval

Maintain query -> expected category/source/tool fixtures using user vocabulary,
synonyms, acronyms, and overlapping service names. Measure `mcp_search_tools`
recall@5 and reciprocal rank before and after description edits; target at least
90% recall@5. For Claude, run the same intents through registered-tool selection
with Tool Search enabled. A description change lands only when it fixes a named
miss without causing a negative-control regression.

Track catalog entry count, omitted count, rendered characters, registered tool
count, native Tool Search decision, search call rate, correct first action, and
wrong-authority attempts. Use existing startup/runtime events where possible;
do not add a general analytics subsystem for this feature.

### Verification gates for implementation PRs

Each implementation PR must run focused prompt/fingerprint/cache, MCP proxy,
Anthropic worker+inline, and DeepAgents worker+inline tests, then the repo's
current small check and architecture gate. The closeout must include the
behavioral corpus for both runtimes and `git diff --check`. A green unit suite
without the unprompted tool-choice eval does not prove the user problem is
solved.

## Surface Impact Matrix

| Surface                         | Classification       | Plan                                                                                                                                              |
| ------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime behavior                | Changed              | Agent receives a real catalog before planning; next-turn access changes rebuild it.                                                               |
| `settings.yaml`                 | Unchanged by design  | Existing `sources` and selected `capabilities` remain the readable desired-state inputs; no new config knob.                                      |
| Postgres/runtime projection     | Read-only/observable | Read existing definitions/bindings and existing metadata; no new authority table. Catalog and digest are derived.                                 |
| Control API                     | Changed              | Existing create/update/install paths apply shared metadata validation and return existing validation errors; no new catalog endpoint is required. |
| SDK/contracts                   | Changed              | Internal prompt projection and MCP search availability contracts change; public model/harness vocabulary does not.                                |
| CLI                             | Changed              | Existing MCP/skill authoring commands collect or validate the reviewed one-line description; no new command.                                      |
| Gantry MCP tools/admin skill    | Changed              | `mcp_search_tools` returns one availability state; approved authoring paths use the same metadata guidance.                                       |
| Channel adapters                | Unchanged by design  | Telegram, Slack, Teams, and Web rendering do not own tool awareness; receipt text still flows through existing channel-neutral output.            |
| LLM provider adapters           | Changed              | Both consume the shared catalog; Anthropic inline gets native Tool Search parity; DeepAgents adds the access fingerprint to its cache key.        |
| Docs/prompts                    | Changed              | Replace generic capability prose with the real catalog and document metadata authoring guidance.                                                  |
| Audit/events                    | Read-only/observable | Existing tool/audit authority remains; startup diagnostics add catalog counts/digest reason without storing prompt contents or secrets.           |
| Tests/verification              | Changed              | Add projection, cache, parity, acquisition, description, and unprompted-choice coverage.                                                          |
| Transient approval              | Unchanged by design  | Catalog display cannot create or extend a transient grant.                                                                                        |
| Persistent capability selection | Unchanged by design  | Existing reviewed selection remains the only durable action authority; the catalog reflects it.                                                   |

## Risks and controls

- **False authority from a pretty catalog:** derive `readyActions` from active
  selected bindings, not from all definitions; keep source and skill states
  distinct; pin with negative tests.
- **Prompt injection through MCP metadata:** use reviewed source descriptions in
  the prompt; keep live descriptions/instructions labeled untrusted and outside
  the system prompt.
- **Stale prompt cache:** make the rendered catalog digest part of the existing
  access fingerprint and DeepAgents cache key; do not rely on source ids alone.
- **Budget hides a useful capability:** retain all selected action names first,
  truncate descriptions and inventory categories deterministically, emit
  omitted counts, and enlarge only if the behavioral eval proves a miss.
- **Duplicate catalogs confuse the model:** one canonical renderer; remove or
  collapse `PUBLIC_CATALOG` and do not add provider-specific copies.
- **Over-building DeepAgents:** catalog plus current FTS first; top-K retrieval
  has a measured 30-tool/90%-accuracy tripwire.
- **Description validation blocks existing state:** fail new or updated bad
  metadata at review time, but render a diagnostic fallback for old rows rather
  than failing a live turn.

## Non-goals

- No new permission, capability, or settings authority.
- No blanket tool authority from a skill or MCP source install.
- No mid-run SDK or LangGraph tool rematerialization.
- No embeddings, vector database, or semantic tool index in P0/P1.
- No user-facing mission-control or raw provider-tool inventory.
- No wholesale tool consolidation or rename migration.
- No prompt content keyed on per-turn user text, time, memory retrieval, or
  search results.

## Discrepancies found during investigation

All paths named in the brief exist. Three expected behaviors need narrower
wording in implementation handoffs:

1. `CAPABILITY_GUIDANCE` is not dead; it is live but generic and receives none
   of the agent's resolved source/capability metadata.
2. `mcp_search_tools` is reachable from both worker runtime families, but not
   from either inline execution mode because the inline core registry does not
   include the MCP proxy facade.
3. MCP server `instructions` are not stored in the current domain or
   materialized shape, so there is no existing trusted instructions surface to
   put into the catalog. They must be captured as bounded untrusted inventory
   metadata if implemented.

## Final recommendation

Ship the shared Capability Catalog and fingerprint/cache fix first. It is the
only proposal that improves tool choice for every model, every provider, and
every tool count without adding a new retrieval system. Finish #237's honest
MCP search/acquisition seam beside it. Treat better metadata and Claude-native
optimizations as measured follow-ups, and leave DeepAgents retrieval unbuilt
until actual tool counts and eval failures justify it.
