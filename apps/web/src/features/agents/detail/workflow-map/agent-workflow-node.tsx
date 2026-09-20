import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';

import { GantryMark } from '../../../../ui/compositions/gantry-logo';
import type { WorkflowNodeData } from './workflow-map-types';

type WorkflowNode = Node<WorkflowNodeData>;

export function AgentWorkflowNode({ data }: NodeProps<WorkflowNode>) {
  const handlePosition = `${(((data.handleIndex ?? 0) + 1) * 100) / ((data.handleCount ?? 0) + 1)}%`;
  return (
    <>
      {data.side === 'output' ? (
        <Handle
          id="in"
          type="target"
          position={Position.Left}
          style={{ top: handlePosition }}
        />
      ) : null}
      <button
        aria-label={`${data.eyebrow}: ${data.title}. Open ${data.targetTab}.`}
        className="nodrag nopan grid w-[150px] min-w-0 gap-0.5 rounded-lg border border-border bg-surface px-[11px] py-[9px] text-left shadow-panel transition-colors hover:border-border-strong hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
        data-workflow-tab={data.targetTab}
        type="button"
      >
        <span className="font-mono text-micro font-medium tracking-[0.1em] text-text-muted uppercase">
          {data.eyebrow}
        </span>
        <strong className="line-clamp-2 min-w-0 break-words text-meta font-medium text-text">
          {data.title}
        </strong>
        <span className="min-w-0 truncate text-caption text-text-secondary">
          {data.detail}
        </span>
      </button>
      {data.side === 'input' ? (
        <Handle
          id="out"
          type="source"
          position={Position.Right}
          style={{ top: handlePosition }}
        />
      ) : null}
    </>
  );
}

export function AgentWorkflowEmployeeNode({ data }: NodeProps<WorkflowNode>) {
  return (
    <>
      {Array.from({ length: data.inputHandleCount ?? 0 }, (_, index) => (
        <Handle
          key={`input-${index}`}
          id={`input-${index}`}
          type="target"
          position={Position.Left}
          style={{
            top: `${((index + 1) * 100) / ((data.inputHandleCount ?? 0) + 1)}%`,
          }}
        />
      ))}
      <button
        aria-label={`${data.title}. Open Overview.`}
        className="workflow-employee-node nodrag nopan grid w-44 min-w-0 gap-2 rounded-[11px] border-2 border-primary bg-surface p-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus-ring"
        data-workflow-tab={data.targetTab}
        type="button"
      >
        <span className="flex items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-border bg-surface-strong text-text">
            <GantryMark className="size-4" />
          </span>
          <span className="min-w-0 flex-1 overflow-hidden">
            <strong className="block truncate text-entity font-semibold">
              {data.title}
            </strong>
            <span className="line-clamp-2 break-words text-caption text-text-secondary">
              {data.detail}
            </span>
          </span>
        </span>
        <span className="line-clamp-3 min-w-0 break-words text-meta leading-relaxed text-text-secondary">
          {data.description}
        </span>
      </button>
      {Array.from({ length: data.outputHandleCount ?? 0 }, (_, index) => (
        <Handle
          key={`output-${index}`}
          id={`output-${index}`}
          type="source"
          position={Position.Right}
          style={{
            top: `${((index + 1) * 100) / ((data.outputHandleCount ?? 0) + 1)}%`,
          }}
        />
      ))}
    </>
  );
}

export function WorkflowLabelNode({ data }: NodeProps<WorkflowNode>) {
  return (
    <span className="font-mono text-micro font-medium tracking-[0.12em] text-text-muted uppercase">
      {data.title}
    </span>
  );
}
