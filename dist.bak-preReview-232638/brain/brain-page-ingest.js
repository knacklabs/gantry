import { createHash } from 'node:crypto';
import { BRAIN_EDGE_TYPES, BRAIN_ENTITY_KINDS, BRAIN_PAGE_SOURCE_KINDS, } from './brain-types.js';
// Frontmatter is untrusted content: it may only claim external source kinds.
// Internal kinds ('channel', 'dream') are set exclusively by their pipelines.
const SOURCE_KINDS = new Set(BRAIN_PAGE_SOURCE_KINDS.filter((kind) => kind !== 'channel' && kind !== 'dream'));
export function normalizeBrainSlug(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/\.md$/i, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120);
}
export function normalizeEntityName(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
export function brainEmbeddingText(input) {
    return `${input.title.trim()}\n${input.markdown.trim()}`;
}
export function brainContentHash(input) {
    return createHash('sha256').update(brainEmbeddingText(input)).digest('hex');
}
export function parseBrainMarkdown(markdown) {
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
    const title = stringValue(frontmatter.title) ||
        stringValue(frontmatter.name) ||
        titleFromBody(body);
    return { frontmatter, body, title };
}
export function sourceKindFromFrontmatter(value, fallback) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return SOURCE_KINDS.has(normalized)
        ? normalized
        : fallback;
}
export function extractBrainPageRefs(parsed) {
    const entities = [];
    const edges = [];
    const people = dedupeEntityRefs(refsFromField(parsed.frontmatter.people, 'person'));
    const companies = dedupeEntityRefs(refsFromField(parsed.frontmatter.companies, 'company'));
    const projects = dedupeEntityRefs(refsFromField(parsed.frontmatter.projects, 'project'));
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
function parseFrontmatter(raw) {
    const out = {};
    let currentKey = '';
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        if (currentKey && trimmed.startsWith('- ')) {
            const existing = Array.isArray(out[currentKey])
                ? out[currentKey]
                : [];
            existing.push(parseScalar(trimmed.slice(2)));
            out[currentKey] = existing;
            continue;
        }
        const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
        if (!match)
            continue;
        currentKey = match[1];
        out[currentKey] = parseScalar(match[2] ?? '');
    }
    return out;
}
function parseScalar(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return '';
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        return trimmed
            .slice(1, -1)
            .split(',')
            .map((entry) => unquote(entry.trim()))
            .filter(Boolean);
    }
    return unquote(trimmed);
}
function unquote(value) {
    return value.replace(/^['"]|['"]$/g, '').trim();
}
function stringValue(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function valuesFromField(value) {
    if (Array.isArray(value)) {
        return value.filter((entry) => typeof entry === 'string');
    }
    if (typeof value === 'string') {
        if (!value.trim())
            return [];
        return value.includes(',')
            ? value.split(',').map((entry) => entry.trim())
            : [value.trim()];
    }
    return [];
}
function refsFromField(value, kind) {
    return valuesFromField(value).map((name) => ({ kind, name }));
}
function wikiLinkRefs(body) {
    const refs = [];
    const pattern = /\[\[([^\]]+)\]\]/g;
    for (const match of body.matchAll(pattern)) {
        const raw = (match[1] || '').split('|')[0].trim();
        if (raw)
            refs.push({ kind: 'topic', name: raw });
    }
    return refs;
}
function relationEdges(value, people, companies) {
    const edges = [];
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
        edges.push({ type: 'works_at', from: people[0], to: companies[0] });
    }
    return edges;
}
function assignmentEdges(value, projects, people) {
    const edges = [];
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
        edges.push({ type: 'assigned_to', from: projects[0], to: people[0] });
    }
    return edges;
}
function fromToEdges(frontmatter) {
    const typeRaw = stringValue(frontmatter.relation) || 'relates_to';
    const type = BRAIN_EDGE_TYPES.includes(typeRaw)
        ? typeRaw
        : 'relates_to';
    const from = valuesFromField(frontmatter.from);
    const to = valuesFromField(frontmatter.to);
    const edges = [];
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
function inferRef(name) {
    return { kind: 'topic', name };
}
function splitPair(value) {
    const pair = /\s*(.*?)\s*(?:->|=>|:)\s*(.*?)\s*$/.exec(value);
    if (!pair?.[1] || !pair[2])
        return null;
    return [pair[1].trim(), pair[2].trim()];
}
function dedupeEntityRefs(refs) {
    const out = new Map();
    for (const ref of refs) {
        if (!BRAIN_ENTITY_KINDS.includes(ref.kind))
            continue;
        const normalized = normalizeEntityName(ref.name);
        if (!normalized)
            continue;
        out.set(`${ref.kind}:${normalized}`, { kind: ref.kind, name: ref.name });
    }
    return [...out.values()];
}
function dedupeEdgeRefs(refs) {
    const out = new Map();
    for (const ref of refs) {
        const from = normalizeEntityName(ref.from.name);
        const to = normalizeEntityName(ref.to.name);
        if (!from || !to || from === to)
            continue;
        out.set(`${ref.type}:${ref.from.kind}:${from}:${ref.to.kind}:${to}`, ref);
    }
    return [...out.values()];
}
function titleFromBody(body) {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading?.[1])
        return heading[1].trim();
    return 'Untitled';
}
