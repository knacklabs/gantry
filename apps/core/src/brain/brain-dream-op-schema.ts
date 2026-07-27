// Typed, versioned schemas for the v1 DESTRUCTIVE brain-dream operations.
// SCHEMA-FIRST, FAIL CLOSED: unknown fields, missing/blank target ids, wrong
// types, or an unsupported op/version are all rejected. Target ids are NEVER
// inferred from the action name — a delete_page with no page_id is a failure.
//
// retire_page is intentionally NOT parsed here: it is deferred in v1 (the
// intake journals it without creating a review). Only these five are v1 ops.

export const BRAIN_DESTRUCTIVE_V1_ACTIONS = [
  'rewrite_page',
  'delete_page',
  'delete_entity',
  'delete_edge',
  'merge_entities',
] as const;

export type BrainDestructiveV1Action =
  (typeof BRAIN_DESTRUCTIVE_V1_ACTIONS)[number];

// The one supported schema version. A `version` discriminator makes future
// shape changes explicit: an op tagged with anything else fails closed.
export const BRAIN_DESTRUCTIVE_OP_VERSION = 1 as const;

export type ParsedDestructiveOp =
  | {
      action: 'rewrite_page';
      version: 1;
      pageId: string;
      title: string | null;
      markdown: string;
    }
  | { action: 'delete_page'; version: 1; pageId: string }
  | { action: 'delete_entity'; version: 1; entityId: string }
  | { action: 'delete_edge'; version: 1; edgeId: string }
  | {
      action: 'merge_entities';
      version: 1;
      sourceEntityId: string;
      targetEntityId: string;
    };

export type ParseDestructiveOpResult =
  | { ok: true; op: ParsedDestructiveOp }
  | { ok: false; reason: string };

// snake_case is the documented wire shape; camelCase is accepted as a fallback
// the way the additive normalizer already tolerates evidence_page_id.
const ALLOWED_KEYS: Record<BrainDestructiveV1Action, ReadonlySet<string>> = {
  rewrite_page: new Set([
    'action',
    'version',
    'page_id',
    'pageId',
    'title',
    'markdown',
  ]),
  delete_page: new Set(['action', 'version', 'page_id', 'pageId']),
  delete_entity: new Set(['action', 'version', 'entity_id', 'entityId']),
  delete_edge: new Set(['action', 'version', 'edge_id', 'edgeId']),
  merge_entities: new Set([
    'action',
    'version',
    'source_entity_id',
    'sourceEntityId',
    'target_entity_id',
    'targetEntityId',
  ]),
};

export function parseDestructiveOp(raw: unknown): ParseDestructiveOpResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'operation must be an object' };
  }
  const row = raw as Record<string, unknown>;
  const action = typeof row.action === 'string' ? row.action.trim() : '';
  if (!isV1Action(action)) {
    return {
      ok: false,
      reason: `unsupported destructive op: ${action || '(none)'}`,
    };
  }

  const versionCheck = checkVersion(row.version);
  if (!versionCheck.ok) return versionCheck;

  const unknown = Object.keys(row).find(
    (key) => !ALLOWED_KEYS[action].has(key),
  );
  if (unknown) {
    return { ok: false, reason: `unknown field for ${action}: ${unknown}` };
  }

  switch (action) {
    case 'rewrite_page': {
      const pageId = readId(row, 'page_id', 'pageId');
      if (!pageId.ok) return pageId;
      if (!pageId.value) return missing('rewrite_page', 'page_id');
      // Verbatim body: leading indentation (code blocks) and trailing newlines
      // are semantically meaningful, so store the ORIGINAL string; only a
      // trimmed COPY is used for the non-blank check.
      if (typeof row.markdown !== 'string' || !row.markdown.trim()) {
        return missing('rewrite_page', 'markdown');
      }
      // Optional title: if present it MUST be a string (no coercing 42 → null).
      if (row.title !== undefined && typeof row.title !== 'string') {
        return { ok: false, reason: 'rewrite_page title must be a string' };
      }
      const title = typeof row.title === 'string' ? row.title.trim() : '';
      return {
        ok: true,
        op: {
          action,
          version: 1,
          pageId: pageId.value,
          title: title || null,
          markdown: row.markdown,
        },
      };
    }
    case 'delete_page': {
      const pageId = readId(row, 'page_id', 'pageId');
      if (!pageId.ok) return pageId;
      if (!pageId.value) return missing('delete_page', 'page_id');
      return { ok: true, op: { action, version: 1, pageId: pageId.value } };
    }
    case 'delete_entity': {
      const entityId = readId(row, 'entity_id', 'entityId');
      if (!entityId.ok) return entityId;
      if (!entityId.value) return missing('delete_entity', 'entity_id');
      return { ok: true, op: { action, version: 1, entityId: entityId.value } };
    }
    case 'delete_edge': {
      const edgeId = readId(row, 'edge_id', 'edgeId');
      if (!edgeId.ok) return edgeId;
      if (!edgeId.value) return missing('delete_edge', 'edge_id');
      return { ok: true, op: { action, version: 1, edgeId: edgeId.value } };
    }
    case 'merge_entities': {
      const sourceEntityId = readId(row, 'source_entity_id', 'sourceEntityId');
      if (!sourceEntityId.ok) return sourceEntityId;
      if (!sourceEntityId.value) {
        return missing('merge_entities', 'source_entity_id');
      }
      const targetEntityId = readId(row, 'target_entity_id', 'targetEntityId');
      if (!targetEntityId.ok) return targetEntityId;
      if (!targetEntityId.value) {
        return missing('merge_entities', 'target_entity_id');
      }
      if (sourceEntityId.value === targetEntityId.value) {
        return {
          ok: false,
          reason: 'merge_entities source and target must differ',
        };
      }
      return {
        ok: true,
        op: {
          action,
          version: 1,
          sourceEntityId: sourceEntityId.value,
          targetEntityId: targetEntityId.value,
        },
      };
    }
  }
}

// The immutable canonical op stored on the review — deterministic camelCase,
// version-stamped, no extra fields.
export function canonicalDestructiveOp(
  op: ParsedDestructiveOp,
): Record<string, unknown> {
  return { ...op };
}

function isV1Action(value: string): value is BrainDestructiveV1Action {
  return (BRAIN_DESTRUCTIVE_V1_ACTIONS as readonly string[]).includes(value);
}

function checkVersion(
  value: unknown,
): { ok: true } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true };
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (numeric !== BRAIN_DESTRUCTIVE_OP_VERSION) {
    return {
      ok: false,
      reason: `unsupported destructive op version: ${String(value)}`,
    };
  }
  return { ok: true };
}

// Resolve an id from its snake_case (primary) or camelCase (fallback) alias.
// Fail closed: a present alias that is not a string is a typed reject, and two
// present aliases that DISAGREE are a typed reject (never silently pick one).
// `value` is the trimmed id, or '' when neither alias is present (→ caller's
// missing()).
function readId(
  row: Record<string, unknown>,
  snake: string,
  camel: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const snakeVal = readAliasString(row, snake);
  if (!snakeVal.ok) return snakeVal;
  const camelVal = readAliasString(row, camel);
  if (!camelVal.ok) return camelVal;
  if (snakeVal.value !== null && camelVal.value !== null) {
    if (snakeVal.value !== camelVal.value) {
      return {
        ok: false,
        reason: `conflicting ${snake}/${camel} values`,
      };
    }
    return { ok: true, value: snakeVal.value };
  }
  return { ok: true, value: snakeVal.value ?? camelVal.value ?? '' };
}

// A present key must be a string; absent → null. No coercion.
function readAliasString(
  row: Record<string, unknown>,
  key: string,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (!(key in row) || row[key] === undefined) return { ok: true, value: null };
  if (typeof row[key] !== 'string') {
    return { ok: false, reason: `${key} must be a string` };
  }
  return { ok: true, value: (row[key] as string).trim() };
}

function missing(
  action: BrainDestructiveV1Action,
  field: string,
): ParseDestructiveOpResult {
  return { ok: false, reason: `${action} requires ${field}` };
}
