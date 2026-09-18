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
  ['Create Employee', 'Name, responsibilities, and model'],
  ['Connect Workspace', 'Choose where your team already works'],
  ['Assign Work', 'Pick a channel and approver'],
  ['Say Hello', 'Review the preview setup'],
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
