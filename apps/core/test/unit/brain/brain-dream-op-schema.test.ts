import { describe, expect, it } from 'vitest';

import { parseDestructiveOp } from '@core/brain/brain-dream-op-schema.js';

describe('parseDestructiveOp', () => {
  it('accepts each v1 op with its required id fields', () => {
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: 'P1' }),
    ).toEqual({
      ok: true,
      op: { action: 'delete_page', version: 1, pageId: 'P1' },
    });

    expect(
      parseDestructiveOp({ action: 'delete_entity', entity_id: 'E1' }),
    ).toEqual({
      ok: true,
      op: { action: 'delete_entity', version: 1, entityId: 'E1' },
    });

    expect(
      parseDestructiveOp({ action: 'delete_edge', edge_id: 'G1' }),
    ).toEqual({
      ok: true,
      op: { action: 'delete_edge', version: 1, edgeId: 'G1' },
    });

    expect(
      parseDestructiveOp({
        action: 'rewrite_page',
        page_id: 'P1',
        markdown: 'new body',
      }),
    ).toEqual({
      ok: true,
      op: {
        action: 'rewrite_page',
        version: 1,
        pageId: 'P1',
        title: null,
        markdown: 'new body',
      },
    });

    expect(
      parseDestructiveOp({
        action: 'merge_entities',
        source_entity_id: 'E1',
        target_entity_id: 'E2',
      }),
    ).toEqual({
      ok: true,
      op: {
        action: 'merge_entities',
        version: 1,
        sourceEntityId: 'E1',
        targetEntityId: 'E2',
      },
    });
  });

  it('accepts a camelCase id fallback and an explicit version 1', () => {
    expect(
      parseDestructiveOp({ action: 'delete_page', pageId: 'P1', version: 1 }),
    ).toEqual({
      ok: true,
      op: { action: 'delete_page', version: 1, pageId: 'P1' },
    });
    expect(
      parseDestructiveOp({
        action: 'delete_page',
        page_id: 'P1',
        version: '1',
      }),
    ).toMatchObject({ ok: true });
  });

  it('rejects unknown fields (fail closed)', () => {
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: 'P1', foo: 1 }),
    ).toEqual({ ok: false, reason: 'unknown field for delete_page: foo' });
  });

  it('rejects a missing or blank target id', () => {
    expect(parseDestructiveOp({ action: 'delete_page' })).toEqual({
      ok: false,
      reason: 'delete_page requires page_id',
    });
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: '   ' }),
    ).toEqual({ ok: false, reason: 'delete_page requires page_id' });
  });

  it('rejects a wrong-typed target id (never inferred)', () => {
    expect(
      parseDestructiveOp({ action: 'delete_entity', entity_id: 123 }),
    ).toEqual({ ok: false, reason: 'entity_id must be a string' });
  });

  it('rejects an unsupported version', () => {
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: 'P1', version: 2 }),
    ).toEqual({
      ok: false,
      reason: 'unsupported destructive op version: 2',
    });
  });

  it('rejects an unsupported op (incl. the deferred retire_page)', () => {
    expect(
      parseDestructiveOp({ action: 'retire_page', page_id: 'P1' }),
    ).toEqual({ ok: false, reason: 'unsupported destructive op: retire_page' });
    expect(parseDestructiveOp({ action: 'upsert_entity' })).toEqual({
      ok: false,
      reason: 'unsupported destructive op: upsert_entity',
    });
  });

  it('rejects merge_entities with identical source and target', () => {
    expect(
      parseDestructiveOp({
        action: 'merge_entities',
        source_entity_id: 'E1',
        target_entity_id: 'E1',
      }),
    ).toEqual({
      ok: false,
      reason: 'merge_entities source and target must differ',
    });
  });

  it('rejects non-object input', () => {
    expect(parseDestructiveOp(null)).toMatchObject({ ok: false });
    expect(parseDestructiveOp([{ action: 'delete_page' }])).toMatchObject({
      ok: false,
    });
  });

  it('preserves rewrite markdown byte-for-byte (verbatim, no trim)', () => {
    const markdown = '  ```ts\n  code();\n  ```\n\n';
    const result = parseDestructiveOp({
      action: 'rewrite_page',
      page_id: 'P1',
      markdown,
    });
    expect(result).toEqual({
      ok: true,
      op: {
        action: 'rewrite_page',
        version: 1,
        pageId: 'P1',
        title: null,
        markdown,
      },
    });
    // Exact bytes round-trip; leading spaces + trailing newline intact.
    if (result.ok && result.op.action === 'rewrite_page') {
      expect(result.op.markdown).toBe(markdown);
    }
  });

  it('rejects a wrong-typed (non-string) title', () => {
    expect(
      parseDestructiveOp({
        action: 'rewrite_page',
        page_id: 'P1',
        markdown: 'body',
        title: 42,
      }),
    ).toEqual({ ok: false, reason: 'rewrite_page title must be a string' });
  });

  it('rejects conflicting snake/camel id aliases but accepts equal ones', () => {
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: 'A', pageId: 'B' }),
    ).toEqual({ ok: false, reason: 'conflicting page_id/pageId values' });
    expect(
      parseDestructiveOp({ action: 'delete_page', page_id: 'A', pageId: 'A' }),
    ).toEqual({
      ok: true,
      op: { action: 'delete_page', version: 1, pageId: 'A' },
    });
  });

  it('rejects a wrong-typed id alias', () => {
    expect(parseDestructiveOp({ action: 'delete_page', pageId: 99 })).toEqual({
      ok: false,
      reason: 'pageId must be a string',
    });
    expect(
      parseDestructiveOp({
        action: 'merge_entities',
        source_entity_id: { nested: true },
        target_entity_id: 'E2',
      }),
    ).toEqual({ ok: false, reason: 'source_entity_id must be a string' });
  });
});
