import * as p from '@clack/prompts';

export interface SetupReadyDraft {
  workspaceKey: string;
  agentName: string;
  conversationLabel: string;
  selectedModel: string;
}

export type ReadyStepAction = { type: 'next' } | { type: 'start_now' };

export async function runReadyStep(
  draft: SetupReadyDraft,
): Promise<ReadyStepAction> {
  p.note(
    [
      'Gantry is ready.',
      '',
      `Workspace: ${draft.workspaceKey}`,
      `Agent: ${draft.agentName}`,
      `Conversation: ${draft.conversationLabel}`,
      `Model: ${draft.selectedModel}`,
      '',
      'Next: Start chatting or run gantry status.',
      'Optional setup: memory, background service, extra providers.',
    ].join('\n'),
    'Ready',
  );

  const value = await p.select({
    message: 'Setup complete. What should Gantry do now?',
    options: [
      {
        value: 'next',
        label: 'Finish setup and exit (Recommended)',
        hint: 'Return to the terminal. Start later with `gantry start`.',
      },
      {
        value: 'start_now',
        label: 'Start Gantry now',
        hint: 'Run `gantry start` immediately.',
      },
    ],
  });

  if (p.isCancel(value)) return { type: 'next' };
  if (value === 'start_now') return { type: 'start_now' };
  return { type: 'next' };
}
