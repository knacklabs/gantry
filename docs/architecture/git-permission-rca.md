<!-- Promoted verbatim from the session scratchpad (git-permission-rca.md) on 2026-07-22; RCA referenced by permission-engine-redesign-goal-prompt.md. -->

## Root-cause report

### A. What the live logs actually prove

The July 22 Telegram run `agent-run:e5360944-...` generated five `RunCommand` permission requests. Four required human `allow_once`; one was allowed by `auto_classifier` ([gantry.log:34568](/Users/ravikiranvemula/gantry/logs/gantry.log:34568), [gantry.log:34575](/Users/ravikiranvemula/gantry/logs/gantry.log:34575), [gantry.log:34589](/Users/ravikiranvemula/gantry/logs/gantry.log:34589), [gantry.log:34593](/Users/ravikiranvemula/gantry/logs/gantry.log:34593)). All five approved calls were resumed.

However, the requested “exact Git command + Git stderr” is not recoverable from the named logs:

- A complete search found no `git clone`, `git pull`, or `git commit` text in the recent per-agent logs, `gantry.log`, or `gantry.error.log`.
- Host telemetry drops command text because it extracts commands only when `request.toolName === 'Bash'`; the host has already canonicalized these requests to `RunCommand`, so neither `commandPreview` nor `commandHash` is emitted ([ipc-permission-telemetry.ts:59](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/ipc-permission-telemetry.ts:59)).
- There was no July 22 `sandbox.blocked`, `sdk_sandbox_blocked`, or `sdk_network_gate_*` event in either host log.
- The latest completed per-agent log is a scheduled run, not this interactive Git run, and confirms the live runtime is `sandbox=direct enforcing=false` ([agent log:38](/Users/ravikiranvemula/gantry/agents/main_agent/logs/agent-2026-07-22T02-35-58-549Z.log:38)).

Therefore the exact confirmed live failure is: **Git-shaped `RunCommand` calls repeatedly fell through to permission prompting. A separate current sandbox denial is not recorded.** Any stronger claim about the Git URL, destination, network protocol, filesystem denial, or Git stderr would be unsupported.

### B. Why Git prompts

The rule engine does not contain a “safe Git” classification. It extracts only `command`/`cmd`, parses the shell into leaves, and requires every leaf to match a durable scoped `RunCommand(...)` rule ([tool-rule-matcher.ts:408](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-rule-matcher.ts:408), [tool-rule-matcher.ts:459](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-rule-matcher.ts:459)).

Matching is positional and case-sensitive. A trailing `*` covers remaining arguments, but earlier arguments must match exactly ([tool-rule-matcher.ts:692](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-rule-matcher.ts:692), [tool-rule-matcher.ts:740](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-rule-matcher.ts:740)).

The live desired state has only:

`RunCommand(git -C /Users/ravikiranvemula/workdir/symphony-forge *)`

([settings.yaml:242](/Users/ravikiranvemula/gantry/settings.yaml:242)).

Consequences:

- `git clone ...` cannot match that rule.
- Plain `git pull`, `git commit`, or `cd <repo> && git pull` cannot match it.
- Only an exact `git -C /Users/ravikiranvemula/workdir/symphony-forge ...` shape matches.
- Because the actual argv was not logged, I cannot confirm which mismatch occurred.

After a rule miss, interactive execution falls through to permission approval ([tool-permission-gate.ts:515](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:515), [tool-permission-gate.ts:535](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:535)).

The auto-permission subsystem has a deterministic silent-read allowlist, but it contains commands such as `ls`, `cat`, `grep`, `stat`, `head`, and `tail—not Git` ([auto-permission-read-only-gate.ts:123](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/auto-permission-read-only-gate.ts:123)). Tests deliberately keep even `git status`, `git log`, `git diff`, and `git show` outside that proven-safe set ([auto-permission-read-only-gate.test.ts:102](/Users/ravikiranvemula/Workdir/myclaw/apps/core/test/unit/shared/auto-permission-read-only-gate.test.ts:102)).

In `auto` mode—the live setting ([settings.yaml:130](/Users/ravikiranvemula/gantry/settings.yaml:130))—an unproven action is sent to an allow-leaning LLM classifier. It may allow or ask; failures also ask ([permission-classifier.ts:295](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/permission-classifier.ts:295), [permission-classifier.ts:323](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/permission-classifier.ts:323), [permission-classifier.ts:597](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/permission-classifier.ts:597)). That explains the observed nondeterminism: one call auto-allowed, four prompted. The individual classifier reasons were not logged.

Git clone/pull/commit are also not inherently read-only:

- Clone writes a new tree and uses network.
- Pull writes the working tree and may execute repository hooks/merge drivers.
- Commit writes objects/refs and may execute hooks.
- The target repository under `/Users/.../Workdir` is outside the agent’s canonical workspace `/Users/.../gantry/agents/main_agent` ([workspace-folder.ts:21](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/platform/workspace-folder.ts:21), [agent log:39](/Users/ravikiranvemula/gantry/agents/main_agent/logs/agent-2026-07-22T02-35-58-549Z.log:39)).

One blind spot: `ToolExecutionClassifier` labels unrecognized Git Bash commands merely `execute`, because its mutation patterns omit Git ([tool-execution-policy-service.ts:502](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-execution-policy-service.ts:502), [tool-execution-bash-policy.ts:7](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-execution-bash-policy.ts:7)). That classification does not grant access, but it underspecifies Git’s actual effects.

#### The `select:WebSearch,WebFetch` case

This is **not a demonstrated leaf-parser bug**. The log explicitly records an SDK `Bash` request whose command was `select:WebSearch,WebFetch`, followed by the parsed Bash-leaf denial ([agent log:128](/Users/ravikiranvemula/gantry/agents/main_agent/logs/agent-2026-07-20T08-44-04-217Z.log:128), [agent log:150](/Users/ravikiranvemula/gantry/agents/main_agent/logs/agent-2026-07-20T08-44-04-217Z.log:150)). The parser correctly turns the supplied Bash command into `argv.join(' ')` ([bash-command-parser.ts:477](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/bash-command-parser.ts:477)).

`ToolSearch` is independently registered as a safe native SDK tool ([native-sdk-tools.ts:1](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/native-sdk-tools.ts:1)). The confirmed defect is upstream: ToolSearch-looking syntax arrived as a Bash invocation. The logs do not establish whether the model or SDK produced that malformed call.

### C. Sandbox root cause

“Direct” does not mean “all Bash runs unsandboxed.”

It means the **outer runner process** is spawned directly; the provider is global and non-enforcing ([runner-sandbox-provider.ts:62](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/sandbox/runner-sandbox-provider.ts:62)). In direct mode, the Anthropic SDK filesystem/network sandbox is still enabled. It is disabled only when the entire runner uses `sandbox_runtime` ([query-loop.ts:279](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/query-loop.ts:279), [filesystem-sandbox.ts:68](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.ts:68)).

For current deployed code:

- SDK network access is allowed when the host is not denylisted and resolves publicly; otherwise it is denied ([sdk-sandbox-network-gate.ts:19](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/sdk-sandbox-network-gate.ts:19), [sdk-sandbox-network-gate.ts:36](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/sdk-sandbox-network-gate.ts:36)).
- There is no current approval-token requirement. The deployed `dist` also contains this denylist/public-DNS implementation.
- Bash receives the run-scoped proxy environment after permission approval ([bash-trust-env.ts:32](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/bash-trust-env.ts:32)).
- Direct-mode filesystem policy denies only projected protected paths; it does not impose the outer sandbox’s workspace-only write list ([filesystem-sandbox.ts:75](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/filesystem-sandbox.ts:75)). The protected list covers Gantry/Claude settings, skills, MCP files, and credential paths—not arbitrary repositories by default ([claude-config-materializer.ts:107](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/claude-config-materializer.ts:107)).

The historical `sdk_network_gate_token_minted` event is misleading. It was emitted with event type `sandbox.blocked`, but its own reason says a token was successfully minted ([agent log:149](/Users/ravikiranvemula/gantry/agents/main_agent/logs/agent-2026-07-17T10-35-49-684Z.log:149)). No `sdk_network_gate_denied` was found. That token-coupled implementation was removed by commit `88c288d20` on July 18; the live dist was rebuilt July 21.

Thus the supplied “sandbox blocked” signature is best explained as a historical observability mislabel unless another unlogged Git error exists.

### D. Are the symptoms coupled?

**Current implementation: no, not through a network token.**

There is ordinary sequencing: an unapproved Bash command does not execute, so it cannot reach Git networking. Once approved, the SDK evaluates network access independently through denylist/public-DNS checks; current tests explicitly assert direct-mode network approval works without tokens or host review ([agent-runner-ipc.test.ts:2840](/Users/ravikiranvemula/Workdir/myclaw/apps/core/test/unit/runner/agent-runner-ipc.test.ts:2840)).

**Historical implementation: yes**, a matching approval token was required—but `token_minted` itself represented success, not a network block.

### E. Direct mode

Execution mode is a global `runtime.sandbox.provider`, accepting only `direct` or `sandbox_runtime` ([runtime-settings-parser.ts:713](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/config/settings/runtime-settings-parser.ts:713)); the default is `direct` ([runtime-settings-defaults.ts:56](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/config/settings/runtime-settings-defaults.ts:56)). It is not per tool or per agent, and changes require a restart because startup rejects a live/settings mismatch ([agent-spawn-helpers.ts:192](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/agent-spawn-helpers.ts:192)).

The main agent is already direct. Routing Git—or all trusted `RunCommand`s—through “direct” therefore cannot fix the prompts, and bypassing the SDK sandbox would weaken protected-path and egress enforcement without addressing the authority mismatch.

### F. Ranked fixes

1. **Define explicit reviewed Git authority.** Model Git clone/update as scoped capability, not globally “safe Git.” Constrain repository roots, remote hosts/protocols, permitted subcommands and dangerous flags/hooks; project canonical `git -C <repo> ...` rules. Relevant implementation seams: [semantic-capabilities.ts:292](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/semantic-capabilities.ts:292), [agent-tool-runtime-rules.ts:184](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/application/agents/agent-tool-runtime-rules.ts:184), [tool-rule-matcher.ts:692](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/tool-rule-matcher.ts:692). For one trusted repository, the existing scoped-rule mechanism is sufficient; clone needs its own reviewed rule.

2. **If initial no-prompt Git UX is a product requirement, add a deterministic Git action gate.** Integrate it in [permission-classifier.ts:295](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/permission-classifier.ts:295), with parser tests for workspace containment, URL/host, hooks, config overrides, compound commands, clone, fetch/pull, and commit. Do not put clone/pull/commit into the read-only allowlist. Only genuinely read-only `status/log/diff/show` belong in [auto-permission-read-only-gate.ts:94](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/shared/auto-permission-read-only-gate.ts:94).

3. **Fix permission observability.** Update [ipc-permission-telemetry.ts:59](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/runtime/ipc-permission-telemetry.ts:59) to extract redacted command telemetry for both `Bash` and `RunCommand`, and preserve classifier ask reasons. This would make future incidents answerable from logs.

4. **Instrument the ToolSearch/Bash anomaly.** Add a focused regression around [tool-permission-gate.ts:118](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-permission-gate.ts:118) and [tool-search-decision.ts:88](/Users/ravikiranvemula/Workdir/myclaw/apps/core/src/adapters/llm/anthropic-claude-agent/runner/tool-search-decision.ts:88). Do not silently reinterpret arbitrary `select:` shell text as ToolSearch.

5. **Do not change the current sandbox gate without a reproduced denial.** If improved telemetry later identifies a denylisted/unresolvable host or protected clone target, fix that specific policy in `sdk-sandbox-network-gate.ts` or `filesystem-sandbox.ts`. The present logs do not justify such a change.

Plain-English verdict: the main agent is already in direct mode, but “direct” only removes the outer runner sandbox; Bash still uses the SDK safety boundary. The confirmed problem is authorization: Git commands do not match the narrowly scoped rule, Git is intentionally absent from the silent-read allowlist, and the fallback classifier sometimes asks. The apparent sandbox event was an older, mislabeled successful token-mint event—not proof that Git was blocked. The real fix is reviewed, canonical Git capability/rule coverage plus better logging, not routing commands around the sandbox. No files were changed; `git diff` remained empty.

