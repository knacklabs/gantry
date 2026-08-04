# Tool provider affinity

Gantry classifies its 75 built-in MCP tools by whether provider identity changes availability or presentation. The canonical inventory is `ALL_GANTRY_MCP_TOOL_NAMES` in `apps/core/src/shared/admin-mcp-tools.ts`; the availability rule is `CHANNEL_TOOL_PROVIDER_AFFINITY` in `apps/core/src/runner/mcp/tool-provider-affinity.ts`.

## Classification

| Class             | Count | Tools                                                                                                                                                                    | Evidence                                                                                                                                                                                                                                                             |
| ----------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider-specific |     3 | `canvas_read`, `canvas_create`, `canvas_update`                                                                                                                          | The affinity map mounts these only for `sl:` conversations. Slack canvas handles are minted and checked by `apps/core/src/channels/slack/canvas.ts`.                                                                                                                 |
| Provider-variant  |    10 | `attachment_open`, `send_message`, `ask_user_question`, `render_status`, `render_facts`, `render_list`, `render_table`, `render_form`, `render_media`, `render_progress` | The tool contracts are neutral, while channel adapters vary delivery limits, interactive controls, rich rendering, fallback behavior, and inbound attachment retrieval. Per-provider prompt guidance is registered in `apps/core/src/channels/register-builtins.ts`. |
| Provider-neutral  |    62 | All tools listed below                                                                                                                                                   | These tools operate through Gantry application/runtime contracts. No entry exists in the provider affinity map and their channel provider changes neither mounting nor tool semantics.                                                                               |

The provider-neutral set is:

- Work tracking and memory: `todo_update`, `memory_search`, `memory_save`, `brain_search`, `brain_query`, `brain_write`, `continuity_summary`, `procedure_save`, `memory_patch`, `memory_demote`, `procedure_patch`, `memory_dream`, `memory_consolidate`, `memory_review_pending`, `memory_review_decision`.
- Capability and profile management: `request_skill_install`, `request_skill_proposal`, `pattern_candidate_decision`, `proactive_surfacing_consent`, `request_skill_dependency_install`, `request_mcp_server`, `request_access`, `agent_profile_read`, `request_agent_profile_update`, `settings_desired_state`, `request_settings_update`, `guided_action_preview`, `admin_permission_list`, `admin_permission_revoke`, `service_restart`, `register_agent`.
- Files, MCP, and asynchronous work: `file`, `mcp_list_tools`, `mcp_search_tools`, `mcp_describe_tool`, `mcp_call_tool`, `async_run_command`, `async_mcp_call`, `task_cancel`, `task_get`, `task_list`, `delegate_task`, `task_message`.
- Browser: `browser_status`, `browser_open`, `browser_inspect`, `browser_act`, `browser_close`.
- Scheduler: `scheduler_list_models`, `scheduler_upsert_job`, `scheduler_get_job`, `scheduler_list_jobs`, `scheduler_list_notification_targets`, `scheduler_update_job`, `scheduler_delete_job`, `scheduler_pause_job`, `scheduler_resume_job`, `scheduler_run_now`, `scheduler_list_runs`, `scheduler_list_events`, `scheduler_wait_for_events`, `scheduler_get_dead_letter`.

This classification is about provider affinity, not permission. A neutral tool can still require a selected capability, a deterministic rail, or human approval.

## Provider variants

`send_message` stays one tool even though providers split text differently and expose different rich/file fallbacks. `ask_user_question` keeps one schema and maps its bounded questions and options to provider-native controls. The seven `render_*` tools carry neutral descriptors, then adapters render Block Kit, Telegram HTML and inline keyboards, a Discord embed, a Teams Adaptive Card, or an app session event; failed native rendering falls back to text. `attachment_open` remains conversation-scoped and neutral, but provider locators differ; notably, ephemeral Discord attachments cannot be fetched historically.

Provider-specific tools are different: they are not useful on another provider. Canvas tools are therefore removed from both projection and runner mounting unless the conversation JID matches the Slack affinity entry. Canvas edits follow `canvas_read` to obtain a conversation-scoped handle, then `canvas_update` with that handle.

## New-provider checklist

1. Register the provider, JID prefix, formatting descriptor, and a compact `toolGuidance` block in `apps/core/src/channels/register-builtins.ts`.
2. Import delivery limits from bare constant modules. Keep delivery adapters and provider SDK modules out of the registry's static import graph.
3. Describe `send_message` splitting/file behavior, the native `render_*` surface and text fallback, and the `ask_user_question` control shape. Add `attachment_open` notes only for real provider differences.
4. Add provider-specific tools to `CHANNEL_TOOL_PROVIDER_AFFINITY`; leave neutral and provider-variant tools out of the map.
5. Test the compiled prompt against imported constants, assert it excludes every other provider's guidance, and assert non-owning providers do not mount affinity tools.
6. Run typecheck and the architecture boundary check, including a static-import review of `register-builtins.ts`.
