import fs from 'fs';
import path from 'path';
import { log } from './logging.js';
import {
  IPC_INPUT_CLOSE_SENTINEL,
  IPC_INPUT_DIR,
  IPC_INTERACTION_BOUNDARY_DIR,
} from './runtime-env.js';

export function prepareInteractiveIpcInputDir(): void {
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }
}

export function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

export function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
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
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function drainInteractionBoundaries(): number {
  try {
    fs.mkdirSync(IPC_INTERACTION_BOUNDARY_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INTERACTION_BOUNDARY_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    for (const file of files) {
      try {
        fs.unlinkSync(path.join(IPC_INTERACTION_BOUNDARY_DIR, file));
      } catch (err) {
        log(
          `Failed to consume interaction boundary ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return files.length;
  } catch (err) {
    log(
      `Interaction boundary drain error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}
