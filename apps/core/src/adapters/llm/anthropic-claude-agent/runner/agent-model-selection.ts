import {
  resolveModelSelectionForWorkload,
  type ModelCatalogEntry,
} from '../../../../shared/model-catalog.js';

export interface AgentModelValidationResult {
  message?: string;
}

function nativeAgentModelAlias(
  entry: ModelCatalogEntry,
): 'opus' | 'sonnet' | 'haiku' | undefined {
  const runnerModel = entry.runnerModel.toLowerCase();
  if (runnerModel.includes('opus')) return 'opus';
  if (runnerModel.includes('sonnet')) return 'sonnet';
  if (runnerModel.includes('haiku')) return 'haiku';
  return undefined;
}

export function requestedModelFromAgentInput(
  input: unknown,
): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const value = (input as { model?: unknown }).model;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function unsupportedAgentConfigurationField(
  input: unknown,
): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const field of [
    'tools',
    'mcpServers',
    'skills',
    'disallowedTools',
    'mode',
  ]) {
    if (field in record) return field;
  }
  return undefined;
}

export function validateAgentModelRequest(
  requestedModel: string | undefined,
  currentModel: ModelCatalogEntry | undefined,
): AgentModelValidationResult {
  if (!requestedModel || requestedModel === 'inherit') return {};
  const resolved = resolveModelSelectionForWorkload(requestedModel, 'chat');
  if (!resolved.ok) return { message: resolved.message };
  if (!currentModel) {
    return {
      message: `Agent model "${requestedModel}" cannot be validated because the parent run model is not in the Gantry catalog. Use /model to select a supported alias first.`,
    };
  }
  if (resolved.entry.responseFamily !== currentModel.responseFamily) {
    return {
      message: `Agent model "${resolved.alias}" uses ${resolved.entry.responseFamily}, but the parent run is using ${currentModel.responseFamily}. Cross-response-family subagents are not supported in one SDK process; switch the parent session with /model ${resolved.alias} or create a separate Gantry job/session with that model.`,
    };
  }
  const nativeModel = nativeAgentModelAlias(resolved.entry);
  if (!nativeModel || requestedModel !== nativeModel) {
    return {
      message: `Agent model "${requestedModel}" cannot be used as a native Agent model override. This SDK accepts only opus, sonnet, or haiku for per-invocation Agent model overrides; omit model to inherit or use a configured subagent definition for custom model IDs, tools, MCP servers, or skills.`,
    };
  }
  return {};
}

export function validateAgentToolInput(
  input: unknown,
  currentModel: ModelCatalogEntry | undefined,
): string | null {
  const unsupportedField = unsupportedAgentConfigurationField(input);
  if (unsupportedField) {
    if (unsupportedField === 'mode') {
      return 'Agent field "mode" is not supported in native Agent tool input. Subagents inherit the parent run permission model; permission mode overrides can expand authority and must use configured subagent definitions instead.';
    }
    return `Agent field "${unsupportedField}" is not supported in native Agent tool input. Define tools, MCP servers, skills, and disallowed tools in a configured subagent definition, then invoke it with subagent_type.`;
  }
  return (
    validateAgentModelRequest(requestedModelFromAgentInput(input), currentModel)
      .message ?? null
  );
}
