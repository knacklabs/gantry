import type { Edge, Node } from '@xyflow/react';

import type { WorkflowCard } from './workflow-map-model';
import type { WorkflowNodeData } from './workflow-map-types';

export const WORKFLOW_WIDTH = 620;
const BASE_HEIGHT = 352;
const RHYTHM = 100;

export function layoutWorkflow(input: {
  inputs: WorkflowCard[];
  outputs: WorkflowCard[];
  employee: WorkflowCard;
}): { nodes: Node<WorkflowNodeData>[]; edges: Edge[]; height: number } {
  const maxCount = Math.max(3, input.inputs.length, input.outputs.length);
  const height = BASE_HEIGHT + (maxCount - 3) * RHYTHM;
  const extra = height - BASE_HEIGHT;
  const employeeId = input.employee.id;
  const withHandles = (card: WorkflowCard, index: number, count: number) => ({
    ...card,
    handleIndex: index,
    handleCount: count,
  });
  const nodes: Node<WorkflowNodeData>[] = [
    {
      id: 'label:inputs',
      type: 'workflowLabel',
      position: { x: 16, y: 24 },
      data: { kind: 'label', title: 'Comes in from' },
      draggable: false,
      selectable: false,
    },
    {
      id: 'label:outputs',
      type: 'workflowLabel',
      position: { x: 454, y: 24 },
      data: { kind: 'label', title: 'Can reach' },
      draggable: false,
      selectable: false,
    },
    ...input.inputs.map((card, index) => ({
      id: card.id,
      type: 'workflowNode',
      position: { x: 16, y: 50 + index * RHYTHM },
      data: withHandles(card, index, input.inputs.length),
      draggable: false,
    })),
    {
      id: employeeId,
      type: 'workflowEmployee',
      position: { x: 222, y: 114 + extra / 2 },
      data: {
        ...input.employee,
        inputHandleCount: input.inputs.length,
        outputHandleCount: input.outputs.length,
      },
      draggable: false,
    },
    ...input.outputs.map((card, index) => ({
      id: card.id,
      type: 'workflowNode',
      position: { x: 454, y: 48 + index * RHYTHM },
      data: withHandles(card, index, input.outputs.length),
      draggable: false,
    })),
  ];
  const edges: Edge[] = [
    ...input.inputs.map((card, index) => ({
      id: `edge:${card.id}:${employeeId}`,
      source: card.id,
      target: employeeId,
      sourceHandle: 'out',
      targetHandle: `input-${index}`,
    })),
    ...input.outputs.map((card, index) => ({
      id: `edge:${employeeId}:${card.id}`,
      source: employeeId,
      target: card.id,
      sourceHandle: `output-${index}`,
      targetHandle: 'in',
    })),
  ];
  return { nodes, edges, height };
}
