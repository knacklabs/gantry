# Architecture rules

Gantry's stable concepts are provider-neutral: agents, conversations, sessions,
capabilities, tools, jobs, memory, artifacts, credentials, and runtime events.
Provider/channel/model details enter through adapters and are projected into
those concepts.

Domain code cannot depend on Postgres, pg-boss, Slack, Telegram, Discord, model
SDKs, CLI presentation, environment variables, or process wiring. Application
services coordinate ports and transactions but do not construct adapters.
Composition roots choose implementations and process roles.

Persistence repositories own query semantics; schema modules own physical
shape. CLI, Control API, SDK, channel adapters, and MCP tools are distinct
delivery boundaries over application operations—not alternate domain models.
Credentials remain brokered and are projected only into their approved lane.

Read [Architecture overview](../architecture/overview.md), [runtime flows](../architecture/runtime-flows.md),
and active decisions before changing a boundary.

**Mechanical:** `npm run check:architecture` validates the declared layer map,
import direction, selected file budgets, and frozen historical inputs.

**Review:** Changes to authority, trust, durability, process roles, or public
boundaries require architecture documentation and usually an ADR.

**Recommendation:** Introduce a port only when more than one implementation,
test seam, or trust boundary justifies it. Avoid “shared” modules that erase
ownership.
