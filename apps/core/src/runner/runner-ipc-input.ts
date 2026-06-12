import fs from 'fs';
import path from 'path';

// Provider-neutral follow-up input contract for live (interactive) runner turns.
// The host writes follow-up messages as JSON files
// ({type:"message", text:"..."}.json) into GANTRY_IPC_INPUT_DIR and signals the
// end of a session with a `_close` sentinel file. This is the neutral mirror of
// the existing provider-runner IPC-input contract so a new execution-adapter
// runner supports continuation/stop without importing any provider-specific
// runner module.

function ipcInputDir(): string {
  const dir = process.env.GANTRY_IPC_INPUT_DIR?.trim();
  if (!dir) {
    throw new Error(
      'Missing required environment variable: GANTRY_IPC_INPUT_DIR',
    );
  }
  return dir;
}

function closeSentinelPath(): string {
  return path.join(ipcInputDir(), '_close');
}

export function prepareInteractiveIpcInputDir(): void {
  fs.mkdirSync(ipcInputDir(), { recursive: true });
  try {
    fs.unlinkSync(closeSentinelPath());
  } catch {
    /* ignore */
  }
}

export function shouldClose(): boolean {
  if (fs.existsSync(closeSentinelPath())) {
    try {
      fs.unlinkSync(closeSentinelPath());
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

export function drainIpcInput(log?: (message: string) => void): string[] {
  try {
    const dir = ipcInputDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(String(data.text));
        }
      } catch (err) {
        log?.(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log?.(
      `IPC drain error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
