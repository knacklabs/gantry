import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type {
  SkillArtifactBundle,
  SkillArtifactStore,
} from '../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import {
  materializedSkillDirectoryNameFor,
  type AgentSkillBinding,
  type SkillCatalogItem,
} from '../domain/skills/skills.js';
import { readSkillFrontmatterName } from '../shared/skill-artifact-helpers.js';
export { withSkillMaterializationLock } from '../shared/skill-install-lock.js';
import { formatDeclaredGantrySecretLines } from '../shared/user-visible-messages.js';

export type InstalledSkillAsset = {
  path: string;
  contentType?: string;
  content: Uint8Array;
};

export type ApprovedCommandSkillInstallResult = {
  skills: SkillCatalogItem[];
  failed: Array<{ name: string; reason: string }>;
  skippedBeyondLimit: boolean;
  installed: Array<{ skill: SkillCatalogItem; assets: InstalledSkillAsset[] }>;
};

export const MAX_SKILLS_PER_INSTALL_COMMAND = 25;
export const MAX_SKILL_DISCOVERY_DIRECTORIES = 500;
const MAX_SKILL_PACKAGE_FILES = 50;
const MAX_SKILL_TRAVERSAL_ENTRIES = 1_000;

export type InstalledSkillSnapshot = {
  skill: SkillCatalogItem;
  agentId: AgentId;
  bundle: SkillArtifactBundle;
  binding?: AgentSkillBinding;
};

export function skillInstallCommandReceipt(
  result: ApprovedCommandSkillInstallResult,
): string {
  const lines: string[] = [];
  if (result.skills.length === 0 && result.failed.length === 0) {
    // Preserve the old "Installed: none" receipt in agent voice - the message
    // must never be empty.
    lines.push("I didn't find any skills to install from that request.");
  }
  if (result.skills.length > 0) {
    lines.push(
      `I installed ${result.skills.map((skill) => skill.name).join(', ')}.`,
    );
  }
  if (result.failed.length > 0) {
    const names = result.failed.map(({ name }) => name).join(', ');
    lines.push(
      `I couldn't install ${names}. I left ${result.failed.length === 1 ? 'it' : 'them'} unchanged and can try again after the setup issue is fixed.`,
    );
  }
  if (result.skills.length > 1) {
    lines.push(
      'The installed skill content is shared with me in this conversation now, up to a size budget; every installed skill is registered and loads automatically from your next message.',
    );
  }
  if (result.skippedBeyondLimit) {
    lines.push(
      `I stopped after ${MAX_SKILLS_PER_INSTALL_COMMAND} skills because one request cannot install more than that.`,
    );
  }
  lines.push(
    ...formatDeclaredGantrySecretLines(
      [
        ...new Set(
          result.skills.flatMap((skill) => skill.requiredEnvVars ?? []),
        ),
      ],
      'The installed skill set',
    ),
  );
  return lines.join('\n');
}

export function safeInstallerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
  ]) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) env[key] = value;
  }
  // The staging sandbox is headless (stdin ignored): agent-aware installers
  // like the `skills` CLI fall back to interactive prompts and exit 0
  // without writing anything unless an agent environment is signalled.
  // AI_AGENT is the vendor-neutral marker the detect-agent family respects.
  env.AI_AGENT = '1';
  return env;
}

export function boundedSkillInstallFailureReason(err: unknown): string {
  const reason =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Skill installation failed.';
  return reason.replaceAll(/\s+/g, ' ').trim().slice(0, 240) || 'Unknown error';
}

export function discoverInstalledSkillRoots(stagingDir: string): {
  roots: string[];
  skippedBeyondLimit: boolean;
} {
  const rootSkillMarkdown = path.join(stagingDir, 'SKILL.md');
  if (
    fs.existsSync(rootSkillMarkdown) &&
    fs.statSync(rootSkillMarkdown).isFile()
  ) {
    return { roots: [stagingDir], skippedBeyondLimit: false };
  }
  const roots: string[] = [];
  const skippedBeyondLimit = findNestedSkillRoots(stagingDir, roots);
  if (roots.length === 0) {
    throw new Error('Installer command did not produce a SKILL.md file.');
  }
  return { roots, skippedBeyondLimit };
}

export function collectInstalledSkillAssets(
  root: string,
): InstalledSkillAsset[] {
  const assets: InstalledSkillAsset[] = [];
  const stack: Array<{ path: string; directory: boolean }> = [
    { path: root, directory: true },
  ];
  let totalBytes = 0;
  let visitedDirectories = 0;
  let visitedEntries = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.directory) {
      if (++visitedDirectories > MAX_SKILL_DISCOVERY_DIRECTORIES) {
        throw new Error('Installed skill package exceeds the traversal limit.');
      }
      const entries = readBoundedDirectoryEntries(
        item.path,
        MAX_SKILL_TRAVERSAL_ENTRIES - visitedEntries,
        'Installed skill package exceeds the traversal limit.',
      );
      visitedEntries += entries.length;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (!entry.isDirectory() && !entry.isFile()) continue;
        stack.push({
          path: path.join(item.path, entry.name),
          directory: entry.isDirectory(),
        });
      }
      continue;
    }
    if (assets.length === MAX_SKILL_PACKAGE_FILES) {
      throw new Error(
        `Installed skill package exceeds the ${MAX_SKILL_PACKAGE_FILES}-file limit.`,
      );
    }
    const stat = fs.statSync(item.path);
    totalBytes += stat.size;
    if (totalBytes > 1_000_000) {
      throw new Error('Installed skill package is larger than 1 MB.');
    }
    assets.push({
      path: path.relative(root, item.path).split(path.sep).join('/'),
      content: fs.readFileSync(item.path),
    });
  }
  assets.sort((left, right) => compareText(left.path, right.path));
  if (!assets.some((asset) => asset.path === 'SKILL.md')) {
    throw new Error('Installed skill package must include SKILL.md.');
  }
  return assets;
}

export function skillNameForReceipt(
  assets: InstalledSkillAsset[],
  fallback: string,
): string {
  const skillMarkdown = assets.find((asset) => asset.path === 'SKILL.md');
  return skillMarkdown
    ? (readSkillFrontmatterName(
        Buffer.from(skillMarkdown.content).toString('utf-8'),
      ) ?? fallback)
    : fallback;
}

export async function snapshotInstalledSkill(input: {
  appId: AppId;
  agentId: AgentId;
  name: string;
  skills: SkillCatalogRepository;
  artifacts: SkillArtifactStore;
}): Promise<InstalledSkillSnapshot | undefined> {
  const key = materializedSkillDirectoryNameFor(input.name).toLowerCase();
  const skill = (
    await input.skills.listSkills({
      appId: input.appId,
      statuses: ['installed'],
    })
  ).find(
    (candidate) =>
      materializedSkillDirectoryNameFor(candidate.name).toLowerCase() === key,
  );
  if (!skill?.storage) return undefined;
  const binding = (
    await input.skills.listAgentSkillBindings({
      appId: input.appId,
      agentId: input.agentId,
    })
  ).find((candidate) => candidate.skillId === skill.id);
  return {
    skill,
    agentId: input.agentId,
    bundle: await input.artifacts.getSkillArtifact(skill.storage.storageRef),
    binding,
  };
}

export function reportUnattemptedSkillRoots(
  result: ApprovedCommandSkillInstallResult,
  roots: string[],
  currentRoot: string,
): void {
  for (const remaining of roots.slice(roots.indexOf(currentRoot) + 1)) {
    result.failed.push({
      name: path.basename(remaining),
      reason: 'Not attempted: a prior failure stopped this install.',
    });
  }
}

// Cleanup path for a FRESH install (no prior skill to restore): unbind the
// partially installed skill; if the binding survives a failed unbind, keep
// the skill as installed rather than stranding a live binding without
// catalog state. Runs inside the attempt's keyed lock, so the binding it
// unbinds can only be this attempt's own write.
export async function rollbackFreshInstallBinding(input: {
  reason: string;
  syncAttempted: boolean;
  rollbackBinding: () => Promise<void>;
  isBindingActive: () => Promise<boolean>;
  sync: () => Promise<void>;
}): Promise<{
  reason: string;
  stopAfterFailure: boolean;
  keepAsInstalled: boolean;
}> {
  let reason = input.reason;
  let syncAttempted = input.syncAttempted;
  let stopAfterFailure = false;
  try {
    await input.rollbackBinding();
  } catch (rollbackError) {
    const cleanupFailure = boundedSkillInstallFailureReason(
      `${reason} Cleanup failed: ${boundedSkillInstallFailureReason(rollbackError)}`,
    );
    if (await input.isBindingActive()) {
      try {
        await input.sync();
        return { reason, stopAfterFailure: false, keepAsInstalled: true };
      } catch (reconciliationError) {
        reason = boundedSkillInstallFailureReason(
          `${cleanupFailure} Reconciliation failed while the binding remains active: ${boundedSkillInstallFailureReason(reconciliationError)}`,
        );
        stopAfterFailure = true;
        syncAttempted = false;
      }
    } else {
      reason = cleanupFailure;
    }
  }
  if (syncAttempted) {
    try {
      await input.sync();
    } catch (reconciliationError) {
      reason = boundedSkillInstallFailureReason(
        `${reason} Reconciliation failed: ${boundedSkillInstallFailureReason(reconciliationError)}`,
      );
      stopAfterFailure = true;
    }
  }
  return { reason, stopAfterFailure, keepAsInstalled: false };
}

// Compensation for a failed REPLACEMENT install. It runs inside the same
// keyed lock as the failed attempt, so any divergence from the snapshot is
// this attempt's own partial write (install stages, bind collisions, sync
// reconciliation) — never an in-process concurrent writer. Restore the
// snapshot whenever the persisted state differs from it; cross-process
// coordination remains the documented follow-up (durable versioned CAS).
export async function rollbackInstalledSkillReplacement(input: {
  reason: string;
  snapshot: InstalledSkillSnapshot;
  attemptedAssets: InstalledSkillAsset[];
  skills: SkillCatalogRepository;
  artifacts: SkillArtifactStore;
  syncAfterRestore: () => Promise<void>;
}): Promise<{ reason: string; stopAfterFailure: boolean }> {
  try {
    const currentSkill = await input.skills.getSkill(input.snapshot.skill.id);
    const currentBinding = (
      await input.skills.listAgentSkillBindings({
        appId: input.snapshot.skill.appId,
        agentId: input.snapshot.agentId,
      })
    ).find((candidate) => candidate.skillId === input.snapshot.skill.id);
    // An unreadable artifact (in-place replace interrupted mid-write) counts
    // as diverged so the snapshot bytes are rewritten.
    const currentFingerprint = currentSkill?.storage
      ? await input.artifacts
          .getSkillArtifact(currentSkill.storage.storageRef)
          .then(skillArtifactBundleFingerprint)
          .catch(() => undefined)
      : undefined;
    const unchanged =
      isDeepStrictEqual(currentSkill, input.snapshot.skill) &&
      isDeepStrictEqual(currentBinding, input.snapshot.binding) &&
      currentFingerprint ===
        skillArtifactBundleFingerprint(input.snapshot.bundle);
    if (unchanged) {
      return { reason: input.reason, stopAfterFailure: false };
    }
    const stored = await input.artifacts.putSkillArtifact({
      appId: input.snapshot.skill.appId,
      skillId: input.snapshot.skill.id,
      skillName: input.snapshot.skill.name,
      bundle: input.snapshot.bundle,
    });
    try {
      await input.skills.saveSkill({
        ...input.snapshot.skill,
        storage: stored,
      });
    } catch (saveError) {
      // The artifact now holds the snapshot bytes while the catalog may
      // still name the attempted replacement's hash — rewrite the attempted
      // bundle so catalog and storage stay consistent, then report.
      if (
        !isDeepStrictEqual(currentSkill, input.snapshot.skill) &&
        input.attemptedAssets.length > 0
      ) {
        try {
          await input.artifacts.putSkillArtifact({
            appId: input.snapshot.skill.appId,
            skillId: input.snapshot.skill.id,
            skillName: input.snapshot.skill.name,
            bundle: { assets: input.attemptedAssets },
          });
        } catch {
          // fall through to the restore-failure report
        }
      }
      throw saveError;
    }
    if (input.snapshot.binding) {
      await input.skills.saveAgentSkillBinding(input.snapshot.binding);
    } else if (currentBinding) {
      await input.skills.disableAgentSkillBinding({
        appId: input.snapshot.skill.appId,
        agentId: input.snapshot.agentId,
        skillId: input.snapshot.skill.id,
        updatedAt: new Date().toISOString(),
      });
    }
    await input.syncAfterRestore();
    return { reason: input.reason, stopAfterFailure: false };
  } catch (restoreError) {
    return {
      reason: boundedSkillInstallFailureReason(
        `${input.reason} Restore failed: ${boundedSkillInstallFailureReason(restoreError)}`,
      ),
      stopAfterFailure: true,
    };
  }
}

// Same-session context carries ALL installed skills; the runner-side formatter
// inlines them in order under SAME_SESSION_SKILL_CONTEXT_MAX_BYTES and states
// which skills are usable this turn vs registered for the next message.
export function installedSkillContext(
  installed: Array<{ skill: SkillCatalogItem; assets: InstalledSkillAsset[] }>,
) {
  const [first, ...rest] = installed;
  const skillEntry = (input: {
    skill: SkillCatalogItem;
    assets: InstalledSkillAsset[];
  }) => ({
    skill: {
      id: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      requiredEnvVars: input.skill.requiredEnvVars ?? [],
    },
    files: input.assets.map((asset) => ({
      path: asset.path,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
      content: Buffer.from(asset.content).toString('utf-8'),
    })),
  });
  return {
    type: 'installed_skill_context',
    activation: 'current_and_future_sessions',
    ...skillEntry(first),
    requiredEnvVars: [
      ...new Set(
        installed.flatMap((entry) => entry.skill.requiredEnvVars ?? []),
      ),
    ],
    ...(rest.length > 0 ? { additionalSkills: rest.map(skillEntry) } : {}),
  };
}

function findNestedSkillRoots(start: string, roots: string[]): boolean {
  const stack = [start];
  const seenFingerprints = new Map<string, Set<string>>();
  let visited = 0;
  let visitedEntries = 0;
  while (stack.length > 0) {
    if (++visited > MAX_SKILL_DISCOVERY_DIRECTORIES) {
      throw new Error('Installer output exceeds the skill discovery limit.');
    }
    const dir = stack.pop()!;
    const skillMarkdown = path.join(dir, 'SKILL.md');
    if (fs.existsSync(skillMarkdown) && fs.statSync(skillMarkdown).isFile()) {
      const name =
        readSkillFrontmatterName(readSkillMarkdownPrefix(dir)) ??
        path.basename(dir);
      const key = materializedSkillDirectoryNameFor(name).toLowerCase();
      const fingerprint = safeSkillPackageFingerprint(dir);
      const previousFingerprints = seenFingerprints.get(key);
      if (previousFingerprints) {
        if (fingerprint && previousFingerprints.has(fingerprint)) continue;
        if (fingerprint) previousFingerprints.add(fingerprint);
      } else {
        seenFingerprints.set(
          key,
          new Set(fingerprint === undefined ? [] : [fingerprint]),
        );
      }
      if (roots.length === MAX_SKILLS_PER_INSTALL_COMMAND) return true;
      roots.push(dir);
      continue;
    }
    const entries = readBoundedDirectoryEntries(
      dir,
      MAX_SKILL_TRAVERSAL_ENTRIES - visitedEntries,
      'Installer output exceeds the skill discovery limit.',
    );
    visitedEntries += entries.length;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
    }
  }
  return false;
}

function readSkillMarkdownPrefix(root: string): string {
  const filePath = path.join(root, 'SKILL.md');
  const length = Math.min(fs.statSync(filePath).size, 64 * 1024);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString('utf-8');
}

function safeSkillPackageFingerprint(root: string): string | undefined {
  try {
    const hash = createHash('sha256');
    for (const asset of collectInstalledSkillAssets(root)) {
      hash.update(asset.path).update('\0').update(asset.content).update('\0');
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function skillArtifactBundleFingerprint(bundle: SkillArtifactBundle): string {
  const hash = createHash('sha256');
  // contentType is deliberately excluded: stores infer it on read while
  // freshly collected assets leave it undefined, so hashing it makes every
  // real-store comparison differ and rollback always skip as "concurrent".
  for (const asset of [...bundle.assets].sort((left, right) =>
    compareText(left.path, right.path),
  )) {
    hash.update(asset.path).update('\0').update(asset.content).update('\0');
  }
  return hash.digest('hex');
}

const IGNORED_ENTRIES = new Set(['.git', 'node_modules', '.DS_Store']);

function readBoundedDirectoryEntries(
  dir: string,
  remaining: number,
  limitError: string,
): fs.Dirent[] {
  const output: fs.Dirent[] = [];
  const handle = fs.opendirSync(dir);
  try {
    let entry: fs.Dirent | null;
    while ((entry = handle.readSync()) !== null) {
      if (IGNORED_ENTRIES.has(entry.name)) continue;
      if (output.length === remaining) throw new Error(limitError);
      output.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return output.sort((left, right) => compareText(left.name, right.name));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
