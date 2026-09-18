export type OnboardingStep = 1 | 2 | 3 | 4;

export type OnboardingDraft = {
  approver: string;
  channel: 'slack' | 'teams' | 'discord' | 'telegram';
  model: string;
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
  approver: 'You',
  channel: 'slack',
  model: 'Sonnet 4.6',
  name: 'Atlas',
  provider: 'anthropic',
  responsibilities:
    'Answer questions in the channels it is invited to.\nSummarise long threads when someone asks.\nDraft replies for a person to approve before they go out.',
  title: 'General assistant',
  workspace: '#team-operations',
};

// Display names are a curated preview of the provider-owned catalog entries.
// Credentials remain browser-local; this is not a runtime model selection.
export const modelOptions: Record<OnboardingDraft['provider'], string[]> = {
  anthropic: ['Fable 5.1', 'Opus 5', 'Sonnet 4.6', 'Haiku 4.5'],
  bedrock: [
    'Bedrock GPT-OSS 120B',
    'Bedrock Kimi K2.5',
    'Bedrock Qwen3 Coder 480B',
  ],
  openai: [
    'GPT-5.5',
    'GPT-5.4',
    'GPT-5.4 mini',
    'GPT-5.6 Terra',
    'GPT-5.6 Luna',
    'GPT-5.6 Sol',
  ],
  openrouter: ['Kimi K2.6', 'GLM 5.2'],
  vertex: ['Vertex Gemini 3.5 Flash'],
};
