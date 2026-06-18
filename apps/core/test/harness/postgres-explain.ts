export type ExplainPlanNode = Record<string, unknown> & {
  Plans?: ExplainPlanNode[];
};

export interface PlanNodeEvidence {
  nodeType: string;
  actualRows?: number;
  actualLoops?: number;
}

export interface ScanNodeEvidence extends PlanNodeEvidence {
  relationName?: string;
  indexName?: string;
  rowsRemovedByFilter?: number;
  rowsRemovedByIndexRecheck?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
  buffers: Record<string, number>;
}

export function normalizeExplainPayload(payload: unknown): Record<
  string,
  unknown
> & {
  Plan: ExplainPlanNode;
} {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'object') {
    throw new Error('Unexpected EXPLAIN JSON payload');
  }
  const root = parsed[0] as Record<string, unknown>;
  if (!root.Plan || typeof root.Plan !== 'object') {
    throw new Error('EXPLAIN payload is missing a Plan');
  }
  return root as Record<string, unknown> & { Plan: ExplainPlanNode };
}

const EXPLAIN_LITERAL_FIELDS = new Set([
  'Filter',
  'Hash Cond',
  'Index Cond',
  'Join Filter',
  'Merge Cond',
  'One-Time Filter',
  'Recheck Cond',
]);

export function redactExplainPlan(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactExplainPlan(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactExplainPlan(entryValue, entryKey),
      ]),
    );
  }
  if (typeof value === 'string' && key && EXPLAIN_LITERAL_FIELDS.has(key)) {
    return value.replace(/'(?:''|[^'])*'/g, "'<redacted>'");
  }
  return value;
}

export function collectPlanNodes(node: ExplainPlanNode): PlanNodeEvidence[] {
  const output: PlanNodeEvidence[] = [];
  walkPlan(node, (current) => {
    output.push({
      nodeType: String(current['Node Type'] ?? 'unknown'),
      actualRows: planNumber(current, 'Actual Rows'),
      actualLoops: planNumber(current, 'Actual Loops'),
    });
  });
  return output;
}

export function collectPlanNodeTypes(node: ExplainPlanNode): string[] {
  return [
    ...new Set(
      collectPlanNodes(node)
        .map((item) => item.nodeType)
        .filter(Boolean),
    ),
  ].sort();
}

export function collectScanNodes(node: ExplainPlanNode): ScanNodeEvidence[] {
  const output: ScanNodeEvidence[] = [];
  walkPlan(node, (current) => {
    const nodeType = String(current['Node Type'] ?? 'unknown');
    if (!nodeType.includes('Scan')) return;
    output.push({
      nodeType,
      relationName:
        typeof current['Relation Name'] === 'string'
          ? current['Relation Name']
          : undefined,
      indexName:
        typeof current['Index Name'] === 'string'
          ? current['Index Name']
          : undefined,
      actualRows: planNumber(current, 'Actual Rows'),
      actualLoops: planNumber(current, 'Actual Loops'),
      rowsRemovedByFilter: planNumber(current, 'Rows Removed by Filter'),
      rowsRemovedByIndexRecheck: planNumber(
        current,
        'Rows Removed by Index Recheck',
      ),
      sharedHitBlocks: planNumber(current, 'Shared Hit Blocks'),
      sharedReadBlocks: planNumber(current, 'Shared Read Blocks'),
      buffers: collectBufferFields(current),
    });
  });
  return output;
}

export function collectObservedIndexes(node: ExplainPlanNode): string[] {
  const indexes = new Set<string>();
  walkPlan(node, (current) => {
    if (typeof current['Index Name'] === 'string') {
      indexes.add(current['Index Name']);
    }
    const arbiterIndexes = current['Conflict Arbiter Indexes'];
    if (Array.isArray(arbiterIndexes)) {
      for (const indexName of arbiterIndexes) {
        if (typeof indexName === 'string') indexes.add(indexName);
      }
    }
  });
  return [...indexes].sort();
}

export function walkPlan(
  node: ExplainPlanNode,
  visitor: (node: ExplainPlanNode) => void,
): void {
  visitor(node);
  for (const child of node.Plans ?? []) {
    walkPlan(child, visitor);
  }
}

export function planNumber(
  node: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

export function collectBufferFields(
  node: Record<string, unknown>,
): Record<string, number> {
  const buffers: Record<string, number> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.includes('Block') && typeof value === 'number') {
      buffers[key] = value;
    }
  }
  return buffers;
}

export function sumBuffers(nodes: ScanNodeEvidence[]): Record<string, number> {
  return nodes.reduce<Record<string, number>>((totals, node) => {
    for (const [key, value] of Object.entries(node.buffers)) {
      totals[key] = (totals[key] ?? 0) + value;
    }
    return totals;
  }, {});
}

export function redactSqlWhitespace(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}
