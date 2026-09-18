import { expect, it } from 'vitest';

import { layoutWorkflow } from './workflow-map-layout';
import type { WorkflowCard } from './workflow-map-model';

const card = (id: string, side: 'input' | 'output'): WorkflowCard => ({
  id,
  kind: 'placeholder',
  eyebrow: 'Test',
  title: id,
  targetTab: 'overview',
  side,
});

it('uses the reference geometry for three cards on each side', () => {
  const result = layoutWorkflow({
    inputs: [card('i1', 'input'), card('i2', 'input'), card('i3', 'input')],
    outputs: [card('o1', 'output'), card('o2', 'output'), card('o3', 'output')],
    employee: card('employee', 'input'),
  });
  expect(result.height).toBe(352);
  expect(result.nodes.find((node) => node.id === 'i1')?.position).toEqual({
    x: 16,
    y: 50,
  });
  expect(result.nodes.find((node) => node.id === 'employee')?.position).toEqual(
    { x: 222, y: 114 },
  );
  expect(result.nodes.find((node) => node.id === 'o1')?.position).toEqual({
    x: 454,
    y: 48,
  });
});

it('extends the graph and centers the employee for larger sets', () => {
  const result = layoutWorkflow({
    inputs: Array.from({ length: 5 }, (_, index) => card(`i${index}`, 'input')),
    outputs: [card('o1', 'output')],
    employee: card('employee', 'input'),
  });
  expect(result.height).toBe(552);
  expect(result.nodes.find((node) => node.id === 'employee')?.position.y).toBe(
    214,
  );
  expect(
    new Set(
      result.edges
        .filter((edge) => edge.target === 'employee')
        .map((edge) => edge.targetHandle),
    ).size,
  ).toBe(5);
});
