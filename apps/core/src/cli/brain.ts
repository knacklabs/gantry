import fs from 'node:fs';
import path from 'node:path';

import * as p from '@clack/prompts';

import type { BrainService } from '../brain/brain-service.js';
import { normalizeBrainSlug } from '../brain/brain-page-ingest.js';
import { openBrainFromHome } from '../brain/brain-runtime.js';

function usage(): string {
  return [
    'Usage:',
    '  gantry brain import <dir>',
    '  gantry brain status [--json]',
  ].join('\n');
}

export async function runBrainCommand(
  runtimeHome: string,
  args: string[],
): Promise<number> {
  const [command, value, ...rest] = args;
  if (command === 'import' && value) {
    return withBrain(runtimeHome, async (brain, appId, close) => {
      try {
        const summary = await importDirectory(brain, appId, value);
        p.log.success(
          `Brain import complete: ${summary.created} created, ${summary.updated} updated, ${summary.files} files scanned.`,
        );
        return 0;
      } finally {
        await close();
      }
    });
  }
  if (!command || command === 'status') {
    const jsonMode = args.includes('--json') || rest.includes('--json');
    return withBrain(runtimeHome, async (brain, appId, close, opened) => {
      try {
        const status = await brain.status(appId);
        const fullStatus = {
          ...status,
          harvestEnabledConversations: opened.harvestEnabledConversations,
        };
        if (jsonMode) {
          process.stdout.write(`${JSON.stringify(fullStatus, null, 2)}\n`);
        } else {
          p.note(
            [
              `Pages: ${status.pages}`,
              `Channel pages: ${status.channelPages}`,
              `Dream pages: ${status.dreamPages}`,
              `Entities: ${status.entities}`,
              `Edges: ${status.edges}`,
              `Dream decisions: ${status.dreamDecisions}`,
              `Last dream cursor: ${status.lastDreamCursor ?? 'never'}`,
              `Harvest-enabled conversations: ${opened.harvestEnabledConversations}`,
              `Ready embeddings: ${status.readyEmbeddings}`,
              `Pending embeddings: ${status.pendingEmbeddings}`,
            ].join('\n'),
            'Company Brain',
          );
        }
        return 0;
      } finally {
        await close();
      }
    });
  }
  p.log.error(usage());
  return 1;
}

async function withBrain(
  runtimeHome: string,
  work: (
    brain: BrainService,
    appId: string,
    close: () => Promise<void>,
    opened: Awaited<ReturnType<typeof openBrainFromHome>>,
  ) => Promise<number>,
): Promise<number> {
  const opened = await openBrainFromHome(runtimeHome);
  return work(opened.brain, opened.appId, opened.close, opened);
}

async function importDirectory(
  brain: BrainService,
  appId: string,
  dir: string,
): Promise<{ files: number; created: number; updated: number }> {
  const root = path.resolve(dir);
  const files = walkMarkdownFiles(root);
  let created = 0;
  let updated = 0;
  for (const file of files) {
    const markdown = fs.readFileSync(file, 'utf8');
    const slug = normalizeBrainSlug(path.relative(root, file));
    const result = await brain.write({
      appId,
      slug,
      markdown,
      sourceKind: 'import',
      sourceRef: path.relative(root, file),
      authorId: 'cli',
    });
    if (result.created) created += 1;
    else updated += 1;
  }
  return { files: files.length, created, updated };
}

function walkMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(fullPath);
  }
  return out.sort();
}
