import { describe, expect, it } from 'vitest';

import {
  BRAIN_DESTRUCTIVE_V1_ACTIONS,
  parseDestructiveOp,
} from '@core/brain/brain-dream-op-schema.js';
import {
  BRAIN_OPERATION_PROMPT_LINES,
  buildGraphPayload,
} from '@core/brain/brain-dream-proposer.js';
import type { BrainGraph } from '@core/brain/brain-types.js';

// The JSON object shapes documented in the prompt, keyed by their action.
function documentedShapes(): Map<string, Record<string, unknown>> {
  return new Map(
    BRAIN_OPERATION_PROMPT_LINES.filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((op) => typeof op.action === 'string')
      .map((op) => [op.action as string, op]),
  );
}

// The required snake_case field names each destructive shape MUST document
// (mirrors brain-dream-op-schema.ts; title is optional so it is not required).
const REQUIRED_FIELDS: Record<string, string[]> = {
  delete_page: ['page_id'],
  rewrite_page: ['page_id', 'markdown'],
  delete_entity: ['entity_id'],
  delete_edge: ['edge_id'],
  merge_entities: ['source_entity_id', 'target_entity_id'],
};

describe('brain dream proposer destructive graph ops', () => {
  it('documents all five v1 destructive shapes with the exact schema field names', () => {
    const shapes = documentedShapes();
    for (const action of BRAIN_DESTRUCTIVE_V1_ACTIONS) {
      const shape = shapes.get(action);
      expect(shape, `prompt must document ${action}`).toBeDefined();
      for (const field of REQUIRED_FIELDS[action]) {
        expect(
          Object.keys(shape as Record<string, unknown>),
          `${action} must document ${field}`,
        ).toContain(field);
      }
    }
  });

  it('every documented destructive shape parses under the schema (prompt<->schema alignment)', () => {
    for (const [action, shape] of documentedShapes()) {
      if (!(BRAIN_DESTRUCTIVE_V1_ACTIONS as readonly string[]).includes(action))
        continue;
      const result = parseDestructiveOp(shape);
      expect(result.ok, `${action}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('surfaces entity and edge ids (with labels) in the model payload', () => {
    const payload = buildGraphPayload(graph);
    expect(payload.entities).toEqual([
      { id: 'ent-alice', kind: 'person', name: 'Alice' },
      { id: 'ent-acme', kind: 'company', name: 'Acme' },
    ]);
    expect(payload.edges).toEqual([
      { id: 'edge-1', type: 'works_at', from: 'Alice', to: 'Acme' },
    ]);
  });

  it('round-trips model-emitted graph-op JSON through parseDestructiveOp', () => {
    const emitted = [
      { action: 'delete_entity', entity_id: 'ent-acme' },
      { action: 'delete_edge', edge_id: 'edge-1' },
      {
        action: 'merge_entities',
        source_entity_id: 'ent-alice',
        target_entity_id: 'ent-acme',
      },
    ];
    for (const op of emitted) {
      const result = parseDestructiveOp(op);
      expect(result.ok, `${op.action}: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

const graph: BrainGraph = {
  entities: [
    {
      id: 'ent-alice',
      appId: 'default',
      kind: 'person',
      name: 'Alice',
      normalizedName: 'alice',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
    {
      id: 'ent-acme',
      appId: 'default',
      kind: 'company',
      name: 'Acme',
      normalizedName: 'acme',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
  ],
  edges: [
    {
      id: 'edge-1',
      appId: 'default',
      type: 'works_at',
      fromEntityId: 'ent-alice',
      toEntityId: 'ent-acme',
      evidencePageId: 'page-1',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    },
  ],
};
