export type BridgeAuditEvent = {
  action: string;
  success: boolean;
  employeeId?: string;
  emailMessageId?: string;
  accessRequestId?: string;
  accessTaskId?: string;
  onboardingIntakeId?: string;
  error?: string;
};

export class AuditService {
  record(event: BridgeAuditEvent): void {
    process.stderr.write(
      `${JSON.stringify({
        service: 'gantry',
        auditType: 'itops_native_tool_call',
        ...event,
        timestamp: new Date().toISOString(),
      })}\n`,
    );
  }
}
