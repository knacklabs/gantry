import type { PermissionDecision } from '../../domain/permissions/permissions.js';

export interface HumanApprovalPort {
  request(input: Record<string, unknown>): Promise<PermissionDecision>;
}

export class RequestHumanApprovalUseCase {
  constructor(private readonly approvals: HumanApprovalPort) {}

  async execute(input: { request: Record<string, unknown> }) {
    return { decision: await this.approvals.request(input.request) };
  }
}
