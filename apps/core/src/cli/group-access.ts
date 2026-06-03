import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';

import { controlApiRequest } from './control-api.js';

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function summaryEntries(value: unknown): { label: string; detail: string }[] {
  return asArray(value).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    return [
      {
        label: String(entry.label ?? ''),
        detail: String(entry.detail ?? ''),
      },
    ];
  });
}

function humanizeId(id: string): string {
  const stripped = id.replace(/^capability:/, '').trim();
  if (!stripped) return id;
  return stripped.replace(/[._:/-]+/g, ' ');
}

function fallbackSummary(access: unknown): Record<string, unknown> {
  const record = isRecord(access) ? access : {};
  const sources = isRecord(record.sources) ? record.sources : {};
  const connected: { label: string; detail: string }[] = [];
  for (const skill of asArray(sources.skills)) {
    if (!isRecord(skill)) continue;
    const id = String(skill.id ?? '');
    const name = String(skill.name ?? id);
    if (name) connected.push({ label: name, detail: 'skill' });
  }
  for (const server of asArray(sources.mcpServers)) {
    if (!isRecord(server)) continue;
    const id = String(server.id ?? '');
    const tools = asArray(server.tools)
      .map((tool) => String(tool ?? '').trim())
      .filter(Boolean);
    if (id) {
      connected.push({
        label: id,
        detail: tools.length > 0 ? tools.join(', ') : 'all reviewed tools',
      });
    }
  }
  for (const tool of asArray(sources.tools)) {
    if (!isRecord(tool)) continue;
    const id = String(tool.id ?? '');
    if (id) connected.push({ label: id, detail: String(tool.kind ?? 'tool') });
  }

  const allowed = asArray(record.selections).flatMap((selection) => {
    if (!isRecord(selection)) return [];
    const id = String(selection.id ?? '');
    return id ? [{ label: humanizeId(id), detail: 'future access' }] : [];
  });
  return {
    connected,
    allowed,
    needsAttention: [],
    suggestedCleanup: [],
  };
}

/**
 * Render the one agent-wide view of access outcomes. Authority is agent-scoped
 * and used in every conversation (DM and group) the agent is added to, so this
 * view is keyed by the agent, not by any conversation. Outcome-first: it leans
 * on the read-only `summary` projection rather than raw ids and rules.
 */
function formatAgentAccess(_agentId: string, access: unknown): string {
  const summary =
    isRecord(access) && isRecord(access.summary)
      ? access.summary
      : fallbackSummary(access);
  const lines = [
    'Agent Access',
    'Used in every conversation this agent is added to.',
  ];

  const section = (
    heading: string,
    entries: { label: string; detail: string }[],
    render: (entry: { label: string; detail: string }) => string,
  ) => {
    lines.push('', `${heading}:`);
    if (entries.length === 0) {
      lines.push('  (none)');
      return;
    }
    for (const entry of entries) lines.push(render(entry));
  };

  section(
    'Connected',
    summaryEntries(summary.connected),
    (entry) => `  - ${entry.label} (${entry.detail})`,
  );
  section(
    'Allowed',
    summaryEntries(summary.allowed),
    (entry) => `  - ${entry.label} (${entry.detail})`,
  );
  section(
    'Needs attention',
    summaryEntries(summary.needsAttention),
    (entry) => `  - ${entry.label}. Next: ${entry.detail}`,
  );
  section(
    'Suggested cleanup',
    summaryEntries(summary.suggestedCleanup),
    (entry) => `  - ${entry.label}. Reason: ${entry.detail}`,
  );

  lines.push(
    '',
    'Details: use --json or audit/events for exact ids and rule details.',
  );

  return lines.join('\n');
}

function agentIdFromSelector(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('agent:') ? trimmed : `agent:${trimmed}`;
}

export async function runAccess(
  runtimeHome: string,
  rest: string[],
): Promise<number> {
  const [action, selector, ...flags] = rest;
  if (!action || !selector || (action !== 'show' && action !== 'apply')) {
    p.log.error(
      'Usage: gantry agent access show <agent> [--json] | gantry agent access apply <agent> --file <path|->',
    );
    return 1;
  }
  const agentId = encodeURIComponent(agentIdFromSelector(selector));
  try {
    if (action === 'show') {
      const access = await controlApiRequest(runtimeHome, {
        method: 'GET',
        path: `/v1/agents/${agentId}/access`,
      });
      if (flags.includes('--json')) {
        console.log(JSON.stringify(access, null, 2));
        return 0;
      }
      p.note(
        formatAgentAccess(agentIdFromSelector(selector), access),
        'Agent skills & permissions',
      );
      return 0;
    }
    const fileIndex = flags.indexOf('--file');
    const filePath = fileIndex >= 0 ? flags[fileIndex + 1] : undefined;
    if (!filePath) {
      p.log.error('access apply requires --file <path|-> (use - for stdin).');
      return 1;
    }
    const raw =
      filePath === '-'
        ? fs.readFileSync(0, 'utf-8')
        : fs.readFileSync(path.resolve(filePath), 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      p.log.error(
        'Access document must be valid JSON with sources and selections.',
      );
      return 1;
    }
    if (!parsed || typeof parsed !== 'object') {
      p.log.error('Access document must be a JSON object.');
      return 1;
    }
    // The access PUT only accepts the writable subset; pick {sources, selections}
    // so `access show` output can be edited and re-applied directly (read-only
    // fields like agentId/toolAccess/updatedAt are stripped).
    const doc = parsed as { sources?: unknown; selections?: unknown };
    const body = {
      sources: doc.sources ?? { skills: [], mcpServers: [], tools: [] },
      ...(doc.selections !== undefined ? { selections: doc.selections } : {}),
    };
    const result = await controlApiRequest(runtimeHome, {
      method: 'PUT',
      path: `/v1/agents/${agentId}/access`,
      body,
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    p.log.error(`Agent access command failed: ${errorMessage(err)}`);
    return 1;
  }
}
