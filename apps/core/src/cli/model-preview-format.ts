import type { ModelPreviewResponse } from './model-preview-types.js';

// Human-readable `gantry model why` output. Covers chat/job/memory scopes and
// the `--agent <id>` harness/route preview (agent harness, credential profile,
// diagnostic executionProviderId, and the locked incompatibility copy).
export function formatPreviewWhy(preview: ModelPreviewResponse): string {
  const selection = preview.selection;
  const modelLabel = selection?.model?.displayName
    ? `${selection.effectiveAlias ?? '(none)'} (${selection.model.displayName})`
    : (selection?.effectiveAlias ?? '(none)');
  const target = preview.jobId
    ? `job ${preview.jobId}`
    : preview.agentId
      ? `agent ${preview.agentId}`
      : preview.scope
        ? `${preview.target ?? 'model'} ${preview.scope}`
        : (preview.target ?? 'model');
  const lines = [
    `Why ${target} uses this model`,
    `model: ${modelLabel}`,
    `source: ${selection?.source ?? 'unknown'}`,
    `mode: ${selection?.inherited ? 'inherited' : 'explicit'}`,
  ];
  if (preview.agentHarness) {
    lines.push(`agent harness: ${preview.agentHarness}`);
  }
  if (selection?.model?.responseFamily)
    lines.push(`response family: ${selection.model.responseFamily}`);
  if (selection?.model?.modelRoute?.label)
    lines.push(`route: ${selection.model.modelRoute.label}`);
  if (selection?.model?.modelRoute?.metadata?.providerModelId) {
    lines.push(
      `provider model id: ${selection.model.modelRoute.metadata.providerModelId}`,
    );
  }
  if (selection?.model?.cacheSupport?.statusLabel) {
    lines.push(`cache: ${selection.model.cacheSupport.statusLabel}`);
  }
  if (preview.credentialProfile) {
    lines.push(`credential profile: ${preview.credentialProfile}`);
  }
  if (preview.executionProviderId) {
    lines.push(`execution provider id: ${preview.executionProviderId}`);
  }
  if (preview.incompatible) {
    lines.push(`incompatible: ${preview.incompatible}`);
  }
  if (preview.why?.length) {
    lines.push(...preview.why.map((reason) => `reason: ${reason}`));
  }
  return lines.join('\n');
}

// Returns the `--agent <id>` value (trimmed), or undefined when the flag is
// absent. An empty value (flag with no argument) returns '' so the caller can
// reject it with usage instead of treating the flag as absent.
export function parseAgentFlag(args: string[]): string | undefined {
  const inline = args.find((arg) => arg.startsWith('--agent='));
  if (inline) return inline.slice('--agent='.length).trim();
  const index = args.indexOf('--agent');
  if (index < 0) return undefined;
  return (args[index + 1] ?? '').trim();
}
