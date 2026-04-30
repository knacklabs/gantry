import type {
  AgentConfigVersion,
  LlmProfile,
} from '../../../domain/agent/agent.js';

const CLAUDE_RUNTIME_ALLOWED_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'best',
  'opusplan',
  'sonnet[1m]',
  'opus[1m]',
] as const;

const DEFAULT_CLAUDE_RUNTIME_MODEL = 'opus';

export interface ClaudeSettingsRenderInput {
  cliEntryPoint: string;
  model?: string;
  agentConfigVersion?: AgentConfigVersion;
  llmProfile?: LlmProfile;
  permissionPolicyRefs?: string[];
  memoryPolicyRef?: string;
  providerOptions?: Record<string, unknown>;
}

export interface ClaudeSettings {
  env: Record<string, string>;
  availableModels: readonly string[];
  model: string;
  autoMemoryEnabled: boolean;
  hooks: Record<string, unknown[]>;
}

function assertNoRawSecrets(value: unknown, pathParts: string[] = []): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoRawSecrets(item, [...pathParts, String(index)]),
    );
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/api[_-]?key|oauth|token|secret|password/i.test(key)) {
      throw new Error(
        `Claude settings cannot include raw secret field ${[
          ...pathParts,
          key,
        ].join('.')}`,
      );
    }
    assertNoRawSecrets(nested, [...pathParts, key]);
  }
}

export function renderClaudeSettings(
  input: ClaudeSettingsRenderInput,
): ClaudeSettings {
  assertNoRawSecrets(input.providerOptions);
  const model =
    input.model || input.llmProfile?.modelAlias || DEFAULT_CLAUDE_RUNTIME_MODEL;

  return {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '0',
    },
    availableModels: CLAUDE_RUNTIME_ALLOWED_MODELS,
    model: String(model),
    autoMemoryEnabled: false,
    hooks: {},
  };
}

export function stringifyClaudeSettings(settings: ClaudeSettings): string {
  assertNoRawSecrets(settings);
  return `${JSON.stringify(settings, null, 2)}\n`;
}
