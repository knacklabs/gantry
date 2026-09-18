import type {
  AgentDirectoryItem,
  AgentWorkflowMap,
} from '../../agents-queries';
import type { AgentDetailTab, WorkflowNodeData } from './workflow-map-types';

export type WorkflowCard = WorkflowNodeData & { id: string };

export function workflowCards(
  agent: AgentDirectoryItem,
  map: AgentWorkflowMap,
): { inputs: WorkflowCard[]; outputs: WorkflowCard[]; employee: WorkflowCard } {
  const inputs = map.relationships.flatMap((relationship): WorkflowCard[] => {
    if (relationship.kind === 'conversation')
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          eyebrow: 'Channel',
          title: relationship.title,
          detail: `${relationship.providerLabel} · ${relationship.status}`,
          targetTab: 'conversations',
          side: 'input',
        },
      ];
    if (relationship.kind === 'job')
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          eyebrow: 'Schedule',
          title: relationship.name,
          detail: relationship.schedule,
          targetTab: 'jobs',
          side: 'input',
        },
      ];
    return [];
  });
  const outputs = map.relationships.flatMap((relationship): WorkflowCard[] => {
    if (relationship.kind === 'model')
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          eyebrow: 'Model',
          title: relationship.displayName,
          detail: relationship.provider,
          targetTab: 'access',
          side: 'output',
        },
      ];
    if (relationship.kind === 'skill' || relationship.kind === 'mcp_server')
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          eyebrow: relationship.kind === 'skill' ? 'Skill' : 'MCP server',
          title: relationship.name,
          detail: relationship.sourceStatus,
          targetTab: 'access',
          side: 'output',
        },
      ];
    if (relationship.kind === 'approver')
      return [
        {
          id: relationship.id,
          kind: relationship.kind,
          eyebrow: 'Approval',
          title: relationship.displayName,
          detail: relationship.conversation,
          targetTab: 'approvals',
          side: 'output',
        },
      ];
    return [];
  });

  if (!inputs.some((node) => node.kind === 'conversation'))
    inputs.unshift(
      placeholder(
        'channel',
        'Channel',
        'No channel connected',
        'Connect from Conversations',
        'conversations',
        'input',
      ),
    );
  if (!inputs.some((node) => node.kind === 'job'))
    inputs.push(
      placeholder(
        'schedule',
        'Schedule',
        'No schedule yet',
        'Add one from Jobs',
        'jobs',
        'input',
      ),
    );
  if (!outputs.some((node) => node.kind === 'model'))
    outputs.unshift(
      placeholder(
        'model',
        'Model',
        'Deployment default',
        'Configure from Access',
        'access',
        'output',
      ),
    );
  if (
    !outputs.some((node) => node.kind === 'skill' || node.kind === 'mcp_server')
  )
    outputs.push(
      placeholder(
        'sources',
        'Sources',
        'No sources attached',
        'Attach from Access',
        'access',
        'output',
      ),
    );
  if (!outputs.some((node) => node.kind === 'approver'))
    outputs.push(
      placeholder(
        'approver',
        'Approval',
        'No approver assigned',
        'Assign per conversation',
        'approvals',
        'output',
      ),
    );

  return {
    inputs,
    outputs,
    employee: {
      id: `employee:${agent.id}`,
      kind: 'employee',
      title: agent.name,
      detail: agent.roleName ?? 'AI employee',
      description:
        'Receives work, applies its configured access, and returns results.',
      targetTab: 'overview',
    },
  };
}

function placeholder(
  id: string,
  eyebrow: string,
  title: string,
  detail: string,
  targetTab: AgentDetailTab,
  side: 'input' | 'output',
): WorkflowCard {
  return {
    id: `placeholder:${id}`,
    kind: 'placeholder',
    eyebrow,
    title,
    detail,
    targetTab,
    side,
  };
}
