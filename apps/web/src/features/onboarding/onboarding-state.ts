export type OnboardingStep = 1 | 2 | 3 | 4;

export type OnboardingDraft = {
  approver: string;
  channel: 'slack' | 'teams' | 'discord' | 'telegram';
  model: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'openrouter' | 'bedrock';
  responsibilities: string;
  title: string;
  workspace: string;
};

export const onboardingSteps = [
  [
    'Create Employee',
    'Give it a model to think with. All of it can change later.',
  ],
  ['Connect Workspace', 'Install Gantry where your team already talks.'],
  [
    'Assign Work',
    'Choose the channel it works in and who signs off on anything risky.',
  ],
  ['Say Hello', 'Mention it once to confirm messages reach it and it replies.'],
] as const;

export const initialOnboardingDraft: OnboardingDraft = {
  approver: 'You',
  channel: 'slack',
  model: 'Claude Sonnet',
  name: 'Atlas',
  provider: 'anthropic',
  responsibilities:
    'Answer questions in the channels it is invited to.\nSummarise long threads when someone asks.\nDraft replies for a person to approve before they go out.',
  title: 'General assistant',
  workspace: '#team-operations',
};

export const modelOptions: Record<OnboardingDraft['provider'], string[]> = {
  anthropic: ['Claude Sonnet', 'Claude Haiku'],
  bedrock: ['Claude Sonnet on Bedrock', 'Nova Pro'],
  openai: ['GPT-5.6', 'GPT-5.6 Luna'],
  openrouter: ['Kimi K2.5', 'GPT-5.6'],
};
