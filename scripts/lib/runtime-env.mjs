// Read a single key from <GANTRY_HOME>/.env (default ~/gantry/.env), so the harness
// gets DB creds the same way Gantry core/connector do — no need to pass them on the
// command line. process.env wins if already set.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function gantryEnv(name) {
  if (process.env[name]) return process.env[name];
  const home = process.env.GANTRY_HOME || path.join(os.homedir(), 'gantry');
  try {
    const text = fs.readFileSync(path.join(home, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[1] === name) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
  } catch {
    /* no runtime env file — fall through */
  }
  return undefined;
}

export function schemaEnv(name, fallback) {
  const value = gantryEnv(name) || fallback;
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) {
    throw new Error(`${name} must be a simple SQL identifier, got ${JSON.stringify(value)}`);
  }
  return value;
}
