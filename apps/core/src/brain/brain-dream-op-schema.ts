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
      const markdown = readString(row.markdown);
      if (!pageId) return missing('rewrite_page', 'page_id');
      if (!markdown) return missing('rewrite_page', 'markdown');
      const title = readString(row.title);
      return {
        ok: true,
        op: {
          action,
          version: 1,
          pageId,
          title: title || null,
          markdown,
        },
      };
    }
    case 'delete_page': {
      const pageId = readId(row, 'page_id', 'pageId');
      if (!pageId) return missing('delete_page', 'page_id');
      return { ok: true, op: { action, version: 1, pageId } };
    }
    case 'delete_entity': {
      const entityId = readId(row, 'entity_id', 'entityId');
      if (!entityId) return missing('delete_entity', 'entity_id');
      return { ok: true, op: { action, version: 1, entityId } };
    }
    case 'delete_edge': {
      const edgeId = readId(row, 'edge_id', 'edgeId');
      if (!edgeId) return missing('delete_edge', 'edge_id');
      return { ok: true, op: { action, version: 1, edgeId } };
    }
    case 'merge_entities': {
      const sourceEntityId = readId(row, 'source_entity_id', 'sourceEntityId');
      const targetEntityId = readId(row, 'target_entity_id', 'targetEntityId');
      if (!sourceEntityId) return missing('merge_entities', 'source_entity_id');
      if (!targetEntityId) return missing('merge_entities', 'target_entity_id');
      if (sourceEntityId === targetEntityId) {
        return {
          ok: false,
          reason: 'merge_entities source and target must differ',
        };
      }
      return {
        ok: true,
        op: { action, version: 1, sourceEntityId, targetEntityId },
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

function readId(
  row: Record<string, unknown>,
  snake: string,
  camel: string,
): string {
  return readString(row[snake]) || readString(row[camel]);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function missing(
  action: BrainDestructiveV1Action,
  field: string,
): ParseDestructiveOpResult {
  return { ok: false, reason: `${action} requires ${field}` };
}
