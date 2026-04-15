import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  deriveRuntimeSettingsFromEnv,
  parseRuntimeSettingsText,
  validateRuntimeSettings,
} from './runtime-settings.js';
import { upsertEnvFile } from './env-file.js';
import { envFilePath, settingsFilePath } from './runtime-home.js';

function createRuntimeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-settings-test-'));
  fs.mkdirSync(path.join(home, 'store'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  return home;
}

describe('runtime-settings', () => {
  it('parses sender allowlist entries from yaml', () => {
    const settings = parseRuntimeSettingsText(`
version: 2
channels:
  telegram:
    enabled: true
  slack:
    enabled: false
features:
  memory: true
  embeddings: false
  dreaming: false
message_policy:
  sender_allowlist:
    default:
      allow: ["alice", "bob"]
      mode: trigger
    chats:
      "tg:123":
        allow: "*"
        mode: drop
    log_denied: true
`);

    expect(settings.messagePolicy.senderAllowlist.default.allow).toEqual([
      'alice',
      'bob',
    ]);
    expect(settings.messagePolicy.senderAllowlist.chats['tg:123']).toEqual({
      allow: '*',
      mode: 'drop',
    });
  });

  it('rejects invalid sender allowlist entry shapes', () => {
    expect(() =>
      parseRuntimeSettingsText(`
version: 2
channels:
  telegram:
    enabled: true
  slack:
    enabled: false
features:
  memory: true
  embeddings: false
  dreaming: false
message_policy:
  sender_allowlist:
    default:
      allow: true
      mode: trigger
    chats:
    log_denied: true
`),
    ).toThrow('must include allow and mode');
  });

  it('derives defaults from env values', () => {
    const runtimeHome = createRuntimeHome();
    upsertEnvFile(envFilePath(runtimeHome), {
      TELEGRAM_BOT_TOKEN: 'tg-token',
      SLACK_BOT_TOKEN: 'slack-bot',
      SLACK_APP_TOKEN: 'slack-app',
      MEMORY_PROVIDER: 'sqlite',
      MEMORY_EMBED_PROVIDER: 'openai',
      MEMORY_DREAMING_ENABLED: 'true',
    });

    const settings = deriveRuntimeSettingsFromEnv(runtimeHome);
    expect(settings.channels.telegram.enabled).toBe(true);
    expect(settings.channels.slack.enabled).toBe(true);
    expect(settings.features.memory).toBe(true);
    expect(settings.features.embeddings).toBe(true);
    expect(settings.features.dreaming).toBe(true);
  });

  it('surfaces actionable error when settings.yaml is malformed', () => {
    const runtimeHome = createRuntimeHome();
    fs.writeFileSync(settingsFilePath(runtimeHome), 'channels\n', 'utf-8');

    const result = validateRuntimeSettings(runtimeHome);
    expect(result.ok).toBe(false);
    expect(result.failure?.summary).toContain('settings file is invalid');
    expect(result.failure?.details.join('\n')).toContain(
      settingsFilePath(runtimeHome),
    );
  });
});
