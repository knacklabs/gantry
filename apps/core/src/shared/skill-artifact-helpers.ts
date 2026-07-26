import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';

export type SkillAssetBytes = {
  path: string;
  content: Uint8Array;
};

type SkillBundle = {
  assets: Array<SkillAssetBytes & { contentType?: string }>;
};

export function normalizeSkillBundle(bundle: SkillBundle): SkillBundle {
  const assets = bundle.assets
    .map((asset) => ({
      path: normalizeSkillArtifactPath(asset.path),
      contentType: asset.contentType,
      content: new Uint8Array(asset.content),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (!assets.some((asset) => asset.path === 'SKILL.md')) {
    throw new Error('Skill artifact must contain SKILL.md');
  }
  return { assets };
}

export function hashSkillBundle(bundle: SkillBundle): string {
  const hash = createHash('sha256');
  for (const asset of normalizeSkillBundle(bundle).assets) {
    hash.update(asset.path);
    hash.update('\0');
    hash.update(asset.content);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

export function normalizeSkillAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    path.posix.isAbsolute(normalized) ||
    normalized.includes('\0') ||
    parts.some(
      (part) =>
        part === '..' || part === '.' || part === '' || part.startsWith('.'),
    )
  ) {
    throw new Error(`Invalid skill asset path: ${value}`);
  }
  return parts.join('/');
}

export function readSkillMdAssetText(assets: SkillAssetBytes[]): string {
  const skillMd = assets.find(
    (asset) => normalizeSkillAssetPath(asset.path) === 'SKILL.md',
  );
  if (!skillMd) {
    throw new Error('Skill asset bundle must include SKILL.md.');
  }
  return Buffer.from(skillMd.content).toString('utf-8');
}

export function writeSkillAssets(
  assets: SkillAssetBytes[],
  targetDir: string,
): void {
  const root = path.resolve(targetDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const asset of assets) {
    const relative = normalizeSkillAssetPath(asset.path);
    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, Buffer.from(asset.content), { mode: 0o600 });
  }
}

export function readSkillFrontmatterName(content: string): string | undefined {
  return cleanSkillMetadataText(parseSkillFrontmatter(content).name);
}

export function parseSkillFrontmatter(content: string): Record<string, string> {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return {};
  }
  const normalized = content.replace(/\r\n/g, '\n');
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return {};
  const lines = normalized.slice(4, end).split('\n');
  const metadata: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2];
    if (rawValue === '|') {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^\s{2}/, ''));
      }
      metadata[key] = block.join('\n').trim();
      continue;
    }
    metadata[key] = rawValue.replace(/^['"]|['"]$/g, '').trim();
  }
  return metadata;
}

export function cleanSkillMetadataText(
  value: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeSkillArtifactPath(value: string): string {
  try {
    return normalizeSkillAssetPath(value);
  } catch {
    throw new Error(`Invalid skill artifact path: ${value}`);
  }
}
