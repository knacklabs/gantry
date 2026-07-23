import {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
  isInlineWorkerOnlyToolRule,
  type AgentRuntime,
} from '../../shared/agent-runtime.js';
import {
  AUTO_AGENT_HARNESS,
  DEEPAGENTS_ENGINE,
  type AgentHarness,
} from '../../shared/agent-engine.js';
import {
  deriveAgentEngineForProvider,
  resolveExecutionRoute,
} from '../../shared/model-execution-route.js';
import {
  resolveModelSelectionForWorkloadWithFamilies,
  type FamilyOrderOverrides,
} from '../../shared/model-families.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  type ModelWorkload,
} from '../../shared/model-catalog.js';
import { settingsCapabilityIdToToolRule } from './configured-capability-normalization.js';
import type {
  AgentEffort,
  RuntimeAgentThinking,
  RuntimeConfiguredAgent,
} from './runtime-settings-types.js';

const AGENT_EFFORT_VALUES = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export {
  formatInlineAgentWorkerOnlyConfigError,
  inlineWorkerOnlyToolRuleLabels,
};

export function parseAgentRuntimeValue(
  raw: unknown,
  pathPrefix: string,
): AgentRuntime {
  if (raw === undefined) return 'worker';
  if (raw === 'worker' || raw === 'inline') return raw;
  throw new Error(`${pathPrefix} must be worker or inline`);
}

export function parseAgentMaxTurnsValue(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

export function parseAgentPositiveIntegerValue(
  raw: unknown,
  pathPrefix: string,
): number | undefined {
  return parseAgentMaxTurnsValue(raw, pathPrefix);
}

export function parseAgentEffortValue(
  raw: unknown,
  pathPrefix: string,
): AgentEffort | undefined {
  if (raw === undefined) return undefined;
  if (!AGENT_EFFORT_VALUES.includes(raw as AgentEffort)) {
    throw new Error(
      `${pathPrefix} must be one of ${AGENT_EFFORT_VALUES.join(', ')}`,
    );
  }
  return raw as AgentEffort;
}

export function parseAgentThinkingValue(
  raw: unknown,
  pathPrefix: string,
): RuntimeAgentThinking | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'off' || raw === 'on') return { mode: raw };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be off, on, or a mapping`);
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'mode' && key !== 'budget_tokens') {
      throw new Error(
        `${pathPrefix}.${key} is not supported. Configure mode and optional budget_tokens.`,
      );
    }
  }
  if (map.mode !== 'off' && map.mode !== 'on') {
    throw new Error(`${pathPrefix}.mode must be off or on`);
  }
  if (map.mode === 'off' && map.budget_tokens !== undefined) {
    throw new Error(
      `${pathPrefix}.budget_tokens requires ${pathPrefix}.mode on`,
    );
  }
  const budgetTokens = parseAgentPositiveIntegerValue(
    map.budget_tokens,
    `${pathPrefix}.budget_tokens`,
  );
  return budgetTokens === undefined
    ? { mode: map.mode }
    : { mode: 'on', budgetTokens };
}

export function configuredAgentControlConstraintErrors(input: {
  subject: string;
  agent: RuntimeConfiguredAgent;
  defaultModel?: string;
  defaultOneTimeJobDefaultModel?: string;
  defaultRecurringJobDefaultModel?: string;
  defaultAgentHarness?: AgentHarness;
  modelFamilyOrder?: FamilyOrderOverrides;
}): string[] {
  const { agent } = input;
  const controls = [
    ['effort', agent.effort],
    ['thinking', agent.thinking],
    ['max_output_tokens', agent.maxOutputTokens],
  ] as const;
  if (controls.every(([, value]) => value === undefined)) return [];
  const selections: { model: string; workload: ModelWorkload }[] = [
    {
      model:
        agent.model?.trim() ||
        input.defaultModel?.trim() ||
        DEFAULT_SETUP_MODEL_ALIAS,
      workload: 'chat',
    },
  ];
  const oneTimeJobModel =
    agent.oneTimeJobDefaultModel?.trim() ||
    input.defaultOneTimeJobDefaultModel?.trim();
  if (oneTimeJobModel) {
    selections.push({
      model: oneTimeJobModel,
      workload: 'one_time_job',
    });
  }
  const recurringJobModel =
    agent.recurringJobDefaultModel?.trim() ||
    input.defaultRecurringJobDefaultModel?.trim();
  if (recurringJobModel) {
    selections.push({
      model: recurringJobModel,
      workload: 'recurring_job',
    });
  }
  return [
    ...new Set(
      selections.flatMap(({ model, workload }) =>
        configuredAgentControlErrorsForModel({
          ...input,
          model,
          workload,
          controls,
        }),
      ),
    ),
  ];
}

function configuredAgentControlErrorsForModel(input: {
  subject: string;
  agent: RuntimeConfiguredAgent;
  defaultAgentHarness?: AgentHarness;
  modelFamilyOrder?: FamilyOrderOverrides;
  model: string;
  workload: ModelWorkload;
  controls: readonly (readonly [string, unknown])[];
}): string[] {
  const { agent, controls, model, workload } = input;
  const resolved = resolveModelSelectionForWorkloadWithFamilies(
    model,
    workload,
    input.modelFamilyOrder,
  );
  if (!resolved.ok) return [];
  const route = resolveExecutionRoute({
    entry: resolved.entry,
    agentHarness:
      agent.agentHarness ?? input.defaultAgentHarness ?? AUTO_AGENT_HARNESS,
  });
  if (!route.ok) {
    return controls
      .filter(([, value]) => value !== undefined)
      .map(
        ([field]) =>
          `${input.subject}.${field} cannot be applied to model ${model}: ${route.message}`,
      );
  }
  const errors: string[] = [];
  if (agent.effort !== undefined) {
    const supportsEffort =
      route.value.engine === DEEPAGENTS_ENGINE
        ? resolved.entry.supportsReasoningEffort === true
        : resolved.entry.supportsEffort === true;
    if (!supportsEffort) {
      errors.push(
        `${input.subject}.effort is not supported by model ${model}.`,
      );
    } else if (
      resolved.entry.supportedEffortLevels.length > 0 &&
      !resolved.entry.supportedEffortLevels.includes(agent.effort)
    ) {
      errors.push(
        `${input.subject}.effort ${agent.effort} is not supported by model ${model}; supported levels are ${resolved.entry.supportedEffortLevels.join(', ')}.`,
      );
    }
  }
  const supportsConfiguredThinking =
    resolved.entry.supportsThinking === true &&
    (route.value.engine !== DEEPAGENTS_ENGINE ||
      resolved.entry.supportsReasoningEffort === true);
  if (agent.thinking !== undefined && !supportsConfiguredThinking) {
    errors.push(
      `${input.subject}.thinking is not supported by model ${model}.`,
    );
  } else if (
    agent.thinking?.mode === 'on' &&
    agent.thinking.budgetTokens !== undefined &&
    resolved.entry.supportsThinkingBudget !== true
  ) {
    errors.push(
      `${input.subject}.thinking.budget_tokens is not supported by model ${model}.`,
    );
  } else if (
    agent.thinking?.mode === 'on' &&
    agent.thinking.budgetTokens === undefined &&
    route.value.engine !== DEEPAGENTS_ENGINE &&
    resolved.entry.supportsAdaptiveThinking !== true
  ) {
    errors.push(
      `${input.subject}.thinking is not supported in adaptive mode by model ${model}.`,
    );
  }
  if (
    agent.maxOutputTokens !== undefined &&
    route.value.engine !== DEEPAGENTS_ENGINE
  ) {
    errors.push(
      `${input.subject}.max_output_tokens is not supported by model ${model} on agent harness ${route.value.engine}; use ${input.subject}.effort as the output-quality lever.`,
    );
  }
  return errors;
}

export function resolveConfiguredAgentRuntime(
  agent: Pick<RuntimeConfiguredAgent, 'runtime'> | undefined,
): AgentRuntime {
  return agent?.runtime ?? 'worker';
}

export function inlineWorkerOnlyConfiguredCapabilityLabels(input: {
  agent: RuntimeConfiguredAgent;
  stdioMcpServerIds?: ReadonlySet<string>;
}): string[] {
  if (resolveConfiguredAgentRuntime(input.agent) !== 'inline') return [];
  const labels = new Set<string>();
  for (const source of input.agent.sources.tools) {
    if (source.status === 'disabled') continue;
    if (source.kind === 'local_cli') labels.add(source.id);
  }
  for (const source of input.agent.sources.mcpServers) {
    if (source.status === 'disabled') continue;
    if (input.stdioMcpServerIds?.has(source.id)) labels.add(source.id);
  }
  for (const capability of input.agent.capabilities) {
    const rule = settingsCapabilityIdToToolRule(capability.id);
    if (isInlineWorkerOnlyToolRule(rule)) labels.add(capability.id);
  }
  return [...labels].sort();
}

export function inlineConfiguredSkillEngineConstraintError(input: {
  subject: string;
  agent: RuntimeConfiguredAgent;
  defaultModel?: string;
  defaultOneTimeJobDefaultModel?: string;
  defaultRecurringJobDefaultModel?: string;
  modelFamilyOrder?: FamilyOrderOverrides;
}): string | null {
  const skillIds = input.agent.sources.skills
    .filter((source) => source.status !== 'disabled')
    .map((source) => source.id);
  if (
    resolveConfiguredAgentRuntime(input.agent) !== 'inline' ||
    skillIds.length === 0
  ) {
    return null;
  }
  const formattedSkillIds = [...new Set(skillIds)].sort().join(', ');
  const selections = [
    {
      model:
        input.agent.model?.trim() ||
        input.defaultModel?.trim() ||
        DEFAULT_SETUP_MODEL_ALIAS,
      workload: 'chat' as const,
    },
    {
      model:
        input.agent.oneTimeJobDefaultModel?.trim() ||
        input.defaultOneTimeJobDefaultModel?.trim(),
      workload: 'one_time_job' as const,
    },
    {
      model:
        input.agent.recurringJobDefaultModel?.trim() ||
        input.defaultRecurringJobDefaultModel?.trim(),
      workload: 'recurring_job' as const,
    },
  ];
  for (const selection of selections) {
    if (!selection.model) continue;
    const resolved = resolveModelSelectionForWorkloadWithFamilies(
      selection.model,
      selection.workload,
      input.modelFamilyOrder,
    );
    if (!resolved.ok) continue;
    const agentEngine = deriveAgentEngineForProvider(
      resolved.entry.modelRoute.id,
    );
    if (agentEngine !== DEEPAGENTS_ENGINE) {
      return `${input.subject}.runtime inline supports attached skills only with engine ${DEEPAGENTS_ENGINE}; model ${selection.model} resolved engine ${agentEngine} is incompatible with attached skills: ${formattedSkillIds}`;
    }
  }
  return null;
}
