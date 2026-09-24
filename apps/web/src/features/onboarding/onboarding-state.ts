export type OnboardingStep = 1 | 2 | 3 | 4;

export type OnboardingDraft = {
  allowlist: string[];
  approver: string;
  channel: 'slack' | 'teams' | 'discord' | 'telegram';
  conversationId: string;
  model: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  name: string;
  provider: 'anthropic' | 'openai' | 'openrouter' | 'bedrock' | 'vertex';
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
  allowlist: [],
  approver: 'You',
  channel: 'slack',
  conversationId: '',
  model: 'sonnet',
  name: 'Atlas',
  provider: 'anthropic',
  responsibilities:
    'Answer questions in the channels it is invited to.\nSummarise long threads when someone asks.\nDraft replies for a person to approve before they go out.',
  title: 'General assistant',
  workspace: '#team-operations',
};

export const defaultModelAliases: Record<OnboardingDraft['provider'], string> =
  {
    anthropic: 'sonnet',
    bedrock: 'bedrock-oss',
    openai: 'gpt',
    openrouter: 'kimi',
    vertex: 'vertex',
  };
