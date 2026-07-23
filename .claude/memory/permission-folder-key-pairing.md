---
name: permission-folder-key-pairing
description: Permission-approval workspace-folder option key is an obfuscated string shared across two files that must stay in sync
metadata: 
  node_type: memory
  type: project
  originSessionId: 57383155-6d08-4f79-8fed-5f95dd3ffd7d
---

The workspace-folder value passed into the permission-approval flow uses a deliberately-obfuscated option key (built like `` `workspace${'Folder'}` `` = `workspaceFolder`). It is set on the SEND side in `apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts` (`WORKSPACE_FOLDER_KEY`) and read on the READ side in `.../runner/permission-callback.ts` (`AGENT_FOLDER_OPTION_KEY`).

**Why:** The two constants are defined independently (no shared export) but MUST resolve to the identical string. If they diverge, the read yields `undefined` → `resolveWorkspaceIpcDir(undefined)` → `path.join(undefined, ...)` throws "path argument must be of type string", silently failing all permission-approval spawn flows. The obfuscation hides this from a plain grep, so a rename can change one side and not the other.

**How to apply:** When renaming or touching either constant, update BOTH files in lockstep and verify the produced string matches. The unit test `permission-callback.test.ts` calls the callback directly with its own key, so it can mask a mismatch — the integration/spawn tests (`agent-runner-ipc.test.ts`, `permission-approval-ipc.integration.test.ts`) are what catch it.

Related: [[agent-access-simplification]]
