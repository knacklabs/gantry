import { describe, expect, it } from 'vitest';

import type { GuidedActionRef } from '@core/application/guided-actions/guided-action-model.js';
import {
  GuidedActionService,
  formatGuidedActionPreview,
  formatGuidedActionResult,
  type GuidedActionResult,
} from '@core/application/guided-actions/guided-action-service.js';

describe('guided action service', () => {
  it('previews authority/impact from the action descriptor', () => {
    const service = new GuidedActionService();
    const ref: GuidedActionRef = {
      type: 'restart_runtime',
      label: 'Restart the runtime to apply changes.',
    };
    expect(service.preview(ref)).toEqual({
      action: 'restart_runtime',
      label: 'Restart the runtime to apply changes.',
      effect: 'Restarts the Gantry runtime.',
      requiresApproval: true,
      writesSettings: false,
      restartsRuntime: true,
    });
  });

  it('routes to a registered executor and returns its receipt', async () => {
    const done: GuidedActionResult = {
      status: 'done',
      changed: 'Restarted the runtime.',
      savedTo: 'none',
      restartRequired: false,
      nextAction: 'none',
    };
    const service = new GuidedActionService({
      restart_runtime: () => done,
    });
    const result = await service.execute({
      type: 'restart_runtime',
      label: 'Restart the runtime.',
    });
    expect(result).toEqual(done);
  });

  it('falls back to a manual instruction when no executor is registered', async () => {
    const service = new GuidedActionService();
    const result = await service.execute({
      type: 'connect_provider',
      label: 'Connect a provider.',
    });
    expect(result).toEqual({
      status: 'manual',
      instruction: 'Connect a provider.',
    });
  });

  it('converts a thrown executor error into a cause/recover failure', async () => {
    const service = new GuidedActionService({
      resume_job: () => {
        throw new Error('job broker unreachable');
      },
    });
    const result = await service.execute({
      type: 'resume_job',
      label: 'Resume the blocked job.',
    });
    expect(result).toEqual({
      status: 'failed',
      cause: 'job broker unreachable',
      recover: 'Resume the blocked job.',
    });
  });

  it('treats the none action as a no-op done receipt', async () => {
    const service = new GuidedActionService();
    const result = await service.execute({ type: 'none', label: 'none' });
    expect(result).toMatchObject({
      status: 'done',
      savedTo: 'none',
      nextAction: 'none',
    });
  });

  it('formats the preview to the contract copy', () => {
    const service = new GuidedActionService();
    const text = formatGuidedActionPreview(
      service.preview({
        type: 'grant_access',
        label: 'Approve pending access requests.',
      }),
    );
    expect(text).toBe(
      [
        'Action: Approve pending access requests.',
        'Effect: Approves a pending access request in the durable access policy (also mirrored to settings.yaml).',
        'Requires approval: Yes',
        'Writes settings.yaml: Yes',
        'Restarts runtime: No',
      ].join('\n'),
    );
  });

  it('formats a done receipt to the contract copy', () => {
    expect(
      formatGuidedActionResult({
        status: 'done',
        changed: 'Bound Default Agent to main_dm.',
        savedTo: 'settings.yaml',
        restartRequired: true,
        nextAction: 'Restart the runtime.',
      }),
    ).toBe(
      [
        'Done.',
        '',
        'Changed: Bound Default Agent to main_dm.',
        'Saved to: settings.yaml',
        'Restart required: Yes',
        'Next action: Restart the runtime.',
      ].join('\n'),
    );
  });

  it('formats a failure receipt to the cause/recover copy', () => {
    expect(
      formatGuidedActionResult({
        status: 'failed',
        cause: 'postgres unreachable',
        recover: 'Start postgres and retry.',
      }),
    ).toBe(
      [
        'Could not complete action.',
        '',
        'cause: postgres unreachable',
        'recover: Start postgres and retry.',
      ].join('\n'),
    );
  });

  it('formats a manual result with the exact next step', () => {
    expect(
      formatGuidedActionResult({
        status: 'manual',
        instruction: 'Run gantry doctor.',
      }),
    ).toBe(
      ['Manual step required.', '', 'Command: Run gantry doctor.'].join('\n'),
    );
  });

  it('renders a manual instruction as a Command, never doubling the verb', () => {
    const text = formatGuidedActionResult({
      status: 'manual',
      instruction: 'Run `gantry doctor` to fix.',
    });
    expect(text.startsWith('Manual step required.')).toBe(true);
    expect(text).toContain('Command: Run `gantry doctor`');
    expect(text).not.toContain('Run: Run');
  });
});
