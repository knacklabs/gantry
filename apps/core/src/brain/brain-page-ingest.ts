import { createHash } from 'node:crypto';

import {
  BRAIN_EDGE_TYPES,
  BRAIN_ENTITY_KINDS,
  type BrainEdgeType,
  type BrainEntityKind,
  type BrainPageSourceKind,
} from './brain-types.js';

export interface ParsedBrainMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
  title: string;
}

export interface BrainEntityRef {
  kind: BrainEntityKind;
  name: string;
}

export interface BrainEdgeRef {
  type: BrainEdgeType;
  from: BrainEntityRef;
  to: BrainEntityRef;
}

export interface BrainPageExtraction {
  entities: BrainEntityRef[];
  edges: BrainEdgeRef[];
}

const SOURCE_KINDS = new Set(['import', 'agent', 'user']);

export function normalizeBrainSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export function normalizeEntityName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function brainEmbeddingText(input: {
  title: string;
  markdown: string;
}): string {
  return `${input.title.trim()}\n${input.markdown.trim()}`;
}

export function brainContentHash(input: {
  title: string;
  markdown: string;
}): string {
  return createHash('sha256').update(brainEmbeddingText(input)).digest('hex');
}

export function parseBrainMarkdown(markdown: string): ParsedBrainMarkdown {
  const text = markdown.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) {
    const body = text.trim();
    return { frontmatter: {}, body, title: titleFromBody(body) };
  }
  const end = text.indexOf('\n---', 4);
  if (end < 0) {
    const body = text.trim();
    return { frontmatter: {}, body, title: titleFromBody(body) };
  }
  const rawFrontmatter = text.slice(4, end).trim();
  const bodyStart = text.indexOf('\n', end + 1);
  const body = bodyStart < 0 ? '' : text.slice(bodyStart + 1).trim();
  const frontmatter = parseFrontmatter(rawFrontmatter);
  const title =
    stringValue(frontmatter.title) ||
    stringValue(frontmatter.name) ||
    titleFromBody(body);
  return { frontmatter, body, title };
}

export function sourceKindFromFrontmatter(
  value: unknown,
  fallback: BrainPageSourceKind,
): BrainPageSourceKind {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return SOURCE_KINDS.has(normalized)
    ? (normalized as BrainPageSourceKind)
    : fallback;
}

export function extractBrainPageRefs(
  parsed: ParsedBrainMarkdown,
): BrainPageExtraction {
  const entities: BrainEntityRef[] = [];
  const edges: BrainEdgeRef[] = [];
  const people = dedupeEntityRefs(
    refsFromField(parsed.frontmatter.people, 'person'),
  );
  const companies = dedupeEntityRefs(
    refsFromField(parsed.frontmatter.companies, 'company'),
  );
  const projects = dedupeEntityRefs(
    refsFromField(parsed.frontmatter.projects, 'project'),
  );
  entities.push(...people, ...companies, ...projects);

  const mentions = dedupeEntityRefs([
    ...refsFromField(parsed.frontmatter.mentions, 'topic'),
    ...wikiLinkRefs(parsed.body),
  ]);
  entities.push(...mentions);
  for (const source of [...people, ...companies, ...projects]) {
    for (const target of mentions) {
      edges.push({ type: 'mentions', from: source, to: target });
    }
  }

  edges.push(...relationEdges(parsed.frontmatter.works_at, people, companies));
  edges.push(...assignmentEdges(parsed.frontmatter.assignee, projects, people));
  edges.push(...fromToEdges(parsed.frontmatter));
  return {
    entities: dedupeEntityRefs(entities),
    edges: dedupeEdgeRefs(edges),
  };
}

function parseFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey = '';
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (currentKey && trimmed.startsWith('- ')) {
      const existing = Array.isArray(out[currentKey])
        ? (out[currentKey] as unknown[])
        : [];
      existing.push(parseScalar(trimmed.slice(2)));
      out[currentKey] = existing;
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    currentKey = match[1]!;
    out[currentKey] = parseScalar(match[2] ?? '');
  }
  return out;
}

function parseScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => unquote(entry.trim()))
      .filter(Boolean);
  }
  return unquote(trimmed);
}

function unquote(value: string): string {
  return value.replace(/^['"]|['"]$/g, '').trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function valuesFromField(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value === 'string') {
    if (!value.trim()) return [];
    return value.includes(',')
      ? value.split(',').map((entry) => entry.trim())
      : [value.trim()];
  }
  return [];
}

function refsFromField(
  value: unknown,
  kind: BrainEntityKind,
): BrainEntityRef[] {
  return valuesFromField(value).map((name) => ({ kind, name }));
}

function wikiLinkRefs(body: string): BrainEntityRef[] {
  const refs: BrainEntityRef[] = [];
  const pattern = /\[\[([^\]]+)\]\]/g;
  for (const match of body.matchAll(pattern)) {
    const raw = (match[1] || '').split('|')[0]!.trim();
    if (raw) refs.push({ kind: 'topic', name: raw });
  }
  return refs;
}

function relationEdges(
  value: unknown,
  people: BrainEntityRef[],
  companies: BrainEntityRef[],
): BrainEdgeRef[] {
  const edges: BrainEdgeRef[] = [];
  for (const entry of valuesFromField(value)) {
    const pair = splitPair(entry);
    if (pair) {
      edges.push({
        type: 'works_at',
        from: { kind: 'person', name: pair[0] },
        to: { kind: 'company', name: pair[1] },
      });
      continue;
    }
    for (const person of people) {
      edges.push({
        type: 'works_at',
        from: person,
        to: { kind: 'company', name: entry },
      });
    }
  }
  if (edges.length === 0 && people.length === 1 && companies.length === 1) {
    edges.push({ type: 'works_at', from: people[0]!, to: companies[0]! });
  }
  return edges;
}

function assignmentEdges(
  value: unknown,
  projects: BrainEntityRef[],
  people: BrainEntityRef[],
): BrainEdgeRef[] {
  const edges: BrainEdgeRef[] = [];
  for (const entry of valuesFromField(value)) {
    const pair = splitPair(entry);
    if (pair) {
      edges.push({
        type: 'assigned_to',
        from: { kind: 'project', name: pair[0] },
        to: { kind: 'person', name: pair[1] },
      });
      continue;
    }
    for (const project of projects) {
      edges.push({
        type: 'assigned_to',
        from: project,
        to: { kind: 'person', name: entry },
      });
    }
  }
  if (edges.length === 0 && projects.length === 1 && people.length === 1) {
    edges.push({ type: 'assigned_to', from: projects[0]!, to: people[0]! });
  }
  return edges;
}

function fromToEdges(frontmatter: Record<string, unknown>): BrainEdgeRef[] {
  const typeRaw = stringValue(frontmatter.relation) || 'relates_to';
  const type = BRAIN_EDGE_TYPES.includes(typeRaw as BrainEdgeType)
    ? (typeRaw as BrainEdgeType)
    : 'relates_to';
  const from = valuesFromField(frontmatter.from);
  const to = valuesFromField(frontmatter.to);
  const edges: BrainEdgeRef[] = [];
  for (const left of from) {
    for (const right of to) {
      edges.push({
        type,
        from: inferRef(left),
        to: inferRef(right),
      });
    }
  }
  return edges;
}

function inferRef(name: string): BrainEntityRef {
  return { kind: 'topic', name };
}

function splitPair(value: string): [string, string] | null {
  const pair = /\s*(.*?)\s*(?:->|=>|:)\s*(.*?)\s*$/.exec(value);
  if (!pair?.[1] || !pair[2]) return null;
  return [pair[1].trim(), pair[2].trim()];
}

function dedupeEntityRefs(refs: BrainEntityRef[]): BrainEntityRef[] {
  const out = new Map<string, BrainEntityRef>();
  for (const ref of refs) {
    if (!BRAIN_ENTITY_KINDS.includes(ref.kind)) continue;
    const normalized = normalizeEntityName(ref.name);
    if (!normalized) continue;
    out.set(`${ref.kind}:${normalized}`, { kind: ref.kind, name: ref.name });
  }
  return [...out.values()];
}

function dedupeEdgeRefs(refs: BrainEdgeRef[]): BrainEdgeRef[] {
  const out = new Map<string, BrainEdgeRef>();
  for (const ref of refs) {
    const from = normalizeEntityName(ref.from.name);
    const to = normalizeEntityName(ref.to.name);
    if (!from || !to || from === to) continue;
    out.set(`${ref.type}:${ref.from.kind}:${from}:${ref.to.kind}:${to}`, ref);
  }
  return [...out.values()];
}

function titleFromBody(body: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading?.[1]) return heading[1].trim();
  return 'Untitled';
}
