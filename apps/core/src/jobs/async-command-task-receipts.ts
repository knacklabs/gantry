import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';

export function cancelledReceipt(
  task: AsyncTaskRecord,
  childCancelledCount = 0,
) {
  if (task.kind === 'mcp_tool_call') {
    return {
      completed: 'cancelled',
      used: mcpToolName(task),
      changed: 'unknown',
      delegated: 'no' as const,
      needsAttention:
        'remote MCP work may have already run; late results will be ignored',
    };
  }
  return task.kind === 'delegated_agent'
    ? {
        completed: 'cancelled',
        used: 'Gantry agent run',
        changed: 'none',
        delegated: 'yes' as const,
        subtasks: `0 completed, 0 failed, ${Math.max(1, childCancelledCount)} cancelled`,
        needsAttention: 'none',
      }
    : {
        completed: 'cancelled',
        used: 'RunCommand',
        changed: 'none',
        delegated: 'no' as const,
        needsAttention: 'none',
      };
}

export function failedReceipt(task: AsyncTaskRecord, completed: string) {
  if (task.kind === 'mcp_tool_call') {
    return {
      completed,
      used: mcpToolName(task),
      changed: 'unknown',
      delegated: 'no' as const,
      needsAttention:
        'check the remote MCP system before retrying; work may have already run',
    };
  }
  return task.kind === 'delegated_agent'
    ? {
        completed,
        used: 'Gantry agent run',
        changed: 'unknown',
        delegated: 'yes' as const,
        subtasks: '0 completed, 1 failed, 0 cancelled',
        needsAttention: 'start this task again if it is still needed',
      }
    : {
        completed,
        used: 'RunCommand',
        changed: 'unknown',
        delegated: 'no' as const,
        needsAttention: 'start this task again if it is still needed',
      };
}

function mcpToolName(task: AsyncTaskRecord): string {
  const snapshot = task.authoritySnapshotJson;
  const tool = snapshot.mcpToolRule;
  return typeof tool === 'string' && tool ? tool : 'mcp_call_tool';
}
