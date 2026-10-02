Read-only audit complete; no files changed. These findings are verified in source; I did not run setup, doctor, or mutation commands. Paths below are relative to `apps/core/src/`.

1. **Bootstrap captures settings before restoring authoritative settings — over-complicated / UX**

   **Today:** When local YAML and the saved revision differ, startup constructs the queue from YAML, then restores the revision. The queue retains its original policy, so admission can enforce different limits from the restored settings.

   **Locations:** Construction precedes restoration in [app/index.ts:104](../../../../apps/core/src/app/index.ts#L104), with restoration at [151](../../../../apps/core/src/app/index.ts#L151) and [177](../../../../apps/core/src/app/index.ts#L177). The queue captures settings in [runtime-app.ts:152](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L152); its policy is fixed in [group-queue.ts:54](../../../../apps/core/src/runtime/group-queue.ts#L54). Admission consumes that policy in [runtime-services.ts:297](../../../../apps/core/src/app/bootstrap/runtime-services.ts#L297). `loadState()` reloads routes, not the queue: [runtime-app.ts:336](../../../../apps/core/src/app/bootstrap/runtime-app.ts#L336).

   **Survive:** Revision authority and one queue built from the final settings snapshot. **Merge/delete:** Remove the earlier settings-dependent construction phase. **Size:** Medium story. **Risk:** Preserve storage bootstrap and fleet readiness while changing startup order.

2. **Settings recovery requires the broken settings to parse — UX / duplicate**

   **Today:** Invalid current YAML prevents `settings validate` from reaching its friendly error handling, and blocks importing a valid replacement or listing saved revisions.

   **Locations:** The dispatcher parses first in [cli/index.ts:487](../../../../apps/core/src/cli/index.ts#L487). The settings handler parses again before dispatching import/history in [settings.ts:115](../../../../apps/core/src/cli/settings.ts#L115); workstation import parses the current file again at [209](../../../../apps/core/src/cli/settings.ts#L209). Validation’s intended diagnostic is at [95](../../../../apps/core/src/cli/settings.ts#L95).

   **Survive:** Validation of the incoming document and revision conflict protection. **Merge/delete:** Delete blanket parsing before command dispatch; load current settings only where needed, using saved revision authority for recovery. **Size:** Small fix. **Risk:** Retain stale-write checks when importing replacements.

3. **Setup probes model credentials twice — duplicate / UX**

   **Today:** A successful verification performs the same credential inspection and live provider checks again before finishing, adding another database/network round and another opportunity to fail.

   **Locations:** Setup calls doctor at [setup-flow-final-steps.ts:204](../../../../apps/core/src/cli/setup-flow-final-steps.ts#L204), which checks credentials at [doctor.ts:661](../../../../apps/core/src/cli/doctor.ts#L661). Setup then calls `verifyModelAccess` at [266](../../../../apps/core/src/cli/setup-flow-final-steps.ts#L266), whose wrapper calls the same inspector at [setup-credentials.ts:54](../../../../apps/core/src/cli/setup-credentials.ts#L54).

   **Survive:** Doctor’s credential result, including skip choices and recovery guidance. **Delete:** The second verification call and its wrapper, which has only this production caller. **Size:** Small fix. **Risk:** Preserve the existing return-to-credentials behavior and final success wording.

4. **Four copies of conversation registration have drifted — duplicate**

   **Today:** Developers maintain ownership selection, naming, settings persistence, route persistence and profile creation four times. Reconnecting Telegram resets `added_at`; Slack, Discord and Teams preserve it.

   **Every copy:** [telegram.ts:315](../../../../apps/core/src/cli/telegram.ts#L315), [slack.ts:385](../../../../apps/core/src/cli/slack.ts#L385), [discord.ts:54](../../../../apps/core/src/cli/discord.ts#L54), [teams.ts:54](../../../../apps/core/src/cli/teams.ts#L54). Telegram already delegates the settings portion to [group-helpers.ts:348](../../../../apps/core/src/cli/group-helpers.ts#L348); the other three repeat that portion inline.

   **Survive:** One shared registration operation using the existing binding helper, with provider-specific discovery and verification retained. **Merge/delete:** The four registrar bodies and repeated binding writes. Preserve existing registration timestamps. **Size:** Medium story. **Risk:** Keep existing conversation ownership, secret references, approvers and provider-specific trigger defaults intact.

5. **CLI and control API implement model-default changes separately — parallel**

   **Today:** Chat defaults, job inheritance, resets and credential-aware memory-provider selection have separate CLI and API policies. Developers must keep both synchronized.

   **Every copy:** CLI mutation branches in [model.ts:342](../../../../apps/core/src/cli/model.ts#L342), including job changes at [429](../../../../apps/core/src/cli/model.ts#L429) and reset assignments at [556](../../../../apps/core/src/cli/model.ts#L556); API-backed mutations in [model-defaults.ts:180](../../../../apps/core/src/config/settings/model-defaults.ts#L180) and [243](../../../../apps/core/src/config/settings/model-defaults.ts#L243), wired at [routes/models.ts:673](../../../../apps/core/src/control/server/routes/models.ts#L673). Memory-reset selection is duplicated in [model-list-format.ts:114](../../../../apps/core/src/cli/model-list-format.ts#L114) and [model-defaults.ts:216](../../../../apps/core/src/config/settings/model-defaults.ts#L216).

   **Survive:** One model-default mutation policy shared by both adapters, plus their distinct presentation/authentication. **Merge/delete:** CLI field assignments and duplicate memory-reset selection. **Size:** Medium story. **Risk:** Preserve CLI operation with the service stopped; sharing policy need not force HTTP calls.

6. **Retired sender mode is still translated into current behavior — dead/legacy**

   **Today:** Configuration using `mode: drop` is accepted and rewritten to `trigger`, although the current type and validator support only `trigger`. A process-wide warning flag supports this compatibility path.

   **Locations:** Translator and warning state in [sender-allowlist.ts:20](../../../../apps/core/src/config/settings/sender-allowlist.ts#L20) and [61](../../../../apps/core/src/config/settings/sender-allowlist.ts#L61); both applications at [80](../../../../apps/core/src/config/settings/sender-allowlist.ts#L80) and [98](../../../../apps/core/src/config/settings/sender-allowlist.ts#L98). Conversation parsing reaches it through [runtime-settings-parser.ts:133](../../../../apps/core/src/config/settings/runtime-settings-parser.ts#L133).

   **Survive:** Current sender-policy validation. **Delete:** The translator, warning flag and supporting logger import. **Size:** Small fix. **Risk:** Retired configurations will be refused rather than silently changed.

Planned overlaps noticed:

- covered by PERMFLOW-1..4: setup-pause and separate job-permission wiring remain connected in [runtime-services.ts:388](../../../../apps/core/src/app/bootstrap/runtime-services.ts#L388) and [584](../../../../apps/core/src/app/bootstrap/runtime-services.ts#L584).
- covered by UX-1: both provider and conversation commands expose approver management: [provider.ts:154](../../../../apps/core/src/cli/provider.ts#L154), [244](../../../../apps/core/src/cli/provider.ts#L244).
- covered by the progress-card Stop deletion: its callback validation remains in [channel-message-action-router.ts:19](../../../../apps/core/src/app/bootstrap/channel-message-action-router.ts#L19).

Ranked by value, user impact first and deletion opportunity second:

1. Bootstrap settings consistency.
2. Unblock settings recovery.
3. Remove repeated credential probes.
4. Merge provider registrars.
5. Share model-default mutation policy.
6. Delete retired sender-mode translation.
