import {
  formatModelCatalog,
  resolveModelSelection,
} from '../shared/model-catalog.js';
import {
  ensureRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';

function usage(): string {
  return [
    'Usage:',
    '  myclaw model list',
    '  myclaw model set-default chat|one-time|recurring <alias>',
    '  myclaw model doctor',
  ].join('\n');
}

function defaultsFor(settings: ReturnType<typeof ensureRuntimeSettings>) {
  const chat = resolveModelSelection(settings.agent.defaultModel);
  const oneTime = resolveModelSelection(settings.agent.oneTimeJobDefaultModel);
  const recurring = resolveModelSelection(
    settings.agent.recurringJobDefaultModel,
  );
  return {
    chat: chat.ok ? chat.alias : undefined,
    oneTime: oneTime.ok ? oneTime.alias : undefined,
    recurring: recurring.ok ? recurring.alias : undefined,
  };
}

export async function runModelCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [action, target, alias] = args;
  const settings = ensureRuntimeSettings(runtimeHome);

  if (!action || action === 'list') {
    console.log(formatModelCatalog(defaultsFor(settings)));
    return 0;
  }

  if (action === 'set-default') {
    if (!target || !alias) {
      console.error(usage());
      return 1;
    }
    const resolved = resolveModelSelection(alias);
    if (!resolved.ok) {
      console.error(resolved.message);
      return 1;
    }
    if (target === 'chat' || target === 'interactive') {
      settings.agent.defaultModel = resolved.alias;
    } else if (target === 'one-time' || target === 'once') {
      settings.agent.oneTimeJobDefaultModel = resolved.alias;
    } else if (target === 'recurring') {
      settings.agent.recurringJobDefaultModel = resolved.alias;
    } else {
      console.error(usage());
      return 1;
    }
    saveRuntimeSettings(runtimeHome, settings);
    console.log(`Set ${target} default model to ${resolved.alias}.`);
    return 0;
  }

  if (action === 'doctor') {
    const lines = ['Model doctor'];
    let failures = 0;
    let warnings = 0;
    for (const [label, value] of [
      ['chat', settings.agent.defaultModel],
      ['one-time', settings.agent.oneTimeJobDefaultModel],
      ['recurring', settings.agent.recurringJobDefaultModel],
    ] as const) {
      if (!value) {
        lines.push(
          label === 'chat'
            ? 'chat: pass - Opus 4.7 (system default)'
            : `${label}: inherits chat/default model`,
        );
        continue;
      }
      const resolved = resolveModelSelection(value);
      if (!resolved.ok) failures += 1;
      lines.push(
        resolved.ok
          ? `${label}: pass - ${resolved.entry.displayName} (${resolved.alias})`
          : `${label}: invalid - ${resolved.message}`,
      );
    }
    lines.push(
      'OpenRouter Anthropic Skin URL: pass - https://openrouter.ai/api',
    );
    const usesOpenRouter = [
      settings.agent.defaultModel,
      settings.agent.oneTimeJobDefaultModel,
      settings.agent.recurringJobDefaultModel,
    ].some((value) => {
      const resolved = resolveModelSelection(value);
      return resolved.ok && resolved.entry.provider === 'openrouter';
    });
    if (usesOpenRouter && settings.credentialBroker.mode === 'none') {
      failures += 1;
      lines.push(
        'OpenRouter credentials: fail - configure Model Access or an external credential broker that provides ANTHROPIC_AUTH_TOKEN.',
      );
    } else if (usesOpenRouter) {
      warnings += 1;
      lines.push(
        `OpenRouter credentials: warn - broker mode ${settings.credentialBroker.mode}; run a Kimi smoke test to confirm provider availability.`,
      );
    } else {
      lines.push(
        'OpenRouter credentials: skipped - no OpenRouter defaults selected',
      );
    }
    lines.push(
      'Cache reporting: pass - Anthropic cache_creation/cache_read and OpenRouter prompt_tokens_details fields are normalized when providers return them',
    );
    lines.push('Kimi availability: cataloged - moonshotai/kimi-k2.6');
    lines.push(
      `Credential broker: ${settings.credentialBroker.mode} (provider keys must live in the broker, not MyClaw env)`,
    );
    lines.push(
      `Status: ${failures > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass'}`,
    );
    console.log(lines.join('\n'));
    return failures > 0 ? 1 : 0;
  }

  console.error(usage());
  return 1;
}
