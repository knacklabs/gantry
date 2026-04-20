import fs from 'fs';
import os from 'os';
import path from 'path';

const runtimeHome = path.join(os.tmpdir(), 'myclaw-vitest-runtime');
const settingsPath = path.join(runtimeHome, 'settings.yaml');

const settingsYaml = [
  'channels:',
  '  telegram:',
  '    enabled: false',
  '    sender_allowlist:',
  '      default:',
  '        allow: "*"',
  '        mode: trigger',
  '      agents: {}',
  '      log_denied: true',
  '  slack:',
  '    enabled: false',
  '    sender_allowlist:',
  '      default:',
  '        allow: "*"',
  '        mode: trigger',
  '      agents: {}',
  '      log_denied: true',
  'memory:',
  '  enabled: true',
  '  root: memory',
  '  embeddings:',
  '    enabled: false',
  '    provider: disabled',
  '    model: text-embedding-3-large',
  '  dreaming:',
  '    enabled: false',
  '  llm:',
  '    models:',
  '      extractor: claude-haiku-4-5-20251001',
  '      dreaming: claude-sonnet-4-6',
  '      consolidation: claude-sonnet-4-6',
  '      session_summary: claude-haiku-4-5-20251001',
  '',
].join('\n');

fs.mkdirSync(runtimeHome, { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'store'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'data'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'agents'), { recursive: true });
fs.mkdirSync(path.join(runtimeHome, 'memory'), { recursive: true });
fs.writeFileSync(settingsPath, settingsYaml, 'utf-8');

process.env.AGENT_ROOT = runtimeHome;
