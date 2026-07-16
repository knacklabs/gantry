import type { WorkflowStepPreview } from './workflows-preview';

export const MAX_WORKFLOW_STEPS = 100;

export function validateWorkflowSteps(steps: WorkflowStepPreview[]) {
  const errors: string[] = [];
  if (!steps.length) errors.push('Workflow: add at least one step.');
  if (steps.length > MAX_WORKFLOW_STEPS)
    errors.push(`Workflow: use at most ${MAX_WORKFLOW_STEPS} steps.`);
  steps.forEach((step, index) => {
    const label = `Step ${index + 1} (${step.name || 'unnamed'})`;
    if (!step.name.trim()) errors.push(`${label}: name is required.`);
    if (!step.description.trim())
      errors.push(`${label}: description is required.`);
    if (step.type === 'agent' && !step.capability?.trim())
      errors.push(`${label}: required capability is missing.`);
    if (step.type === 'external' && !step.externalSystem?.trim())
      errors.push(`${label}: external system is missing.`);
    if (step.type === 'notification' && !step.notificationRoute?.trim())
      errors.push(`${label}: notification route is missing.`);
  });
  return errors;
}
