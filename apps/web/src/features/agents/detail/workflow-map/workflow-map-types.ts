import type { AgentWorkflowRelationship } from '../../agents-queries';

export type AgentDetailTab =
  | 'overview'
  | 'conversations'
  | 'instructions'
  | 'jobs'
  | 'access'
  | 'audit'
  | 'approvals'
  | 'usage'
  | 'settings';

export type WorkflowNodeKind =
  | AgentWorkflowRelationship['kind']
  | 'employee'
  | 'label'
  | 'placeholder';

export type WorkflowNodeData = {
  kind: WorkflowNodeKind;
  eyebrow?: string;
  title: string;
  detail?: string;
  description?: string;
  targetTab?: AgentDetailTab;
  side?: 'input' | 'output';
  handleIndex?: number;
  handleCount?: number;
  inputHandleCount?: number;
  outputHandleCount?: number;
};
