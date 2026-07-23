export const ITOPS_SKILL_NAME = 'itops';

export const ITOPS_NATIVE_TOOL_NAMES = [
  'itops_auto_process_offboarding',
  'itops_auto_process_offboarding_from_slack_message',
  'itops_auto_process_onboarding_from_slack_message',
  'itops_cancel_onboarding_intake',
  'itops_continue_onboarding_setup',
  'itops_create_access_request',
  'itops_create_employee',
  'itops_create_offboarding_intake',
  'itops_create_onboarding_intake_from_slack_message',
  'itops_decide_access_request',
  'itops_decide_offboarding_intake',
  'itops_decide_onboarding_intake',
  'itops_execute_access_task',
  'itops_finalize_offboarding',
  'itops_finalize_onboarding',
  'itops_finalize_onboarding_by_employee',
  'itops_get_access_detail_report',
  'itops_get_config_health',
  'itops_get_connector_health',
  'itops_get_email_message',
  'itops_get_employee',
  'itops_get_employee_access',
  'itops_get_offboarding_intake',
  'itops_get_offboarding_status',
  'itops_get_onboarding_intake',
  'itops_get_onboarding_status',
  'itops_get_onboarding_status_by_employee',
  'itops_get_recent_failed_access_tasks',
  'itops_get_task_status_by_employee',
  'itops_list_access_request_tasks',
  'itops_list_employee_emails',
  'itops_list_employees',
  'itops_list_onboarding_work_queue',
  'itops_list_pending_onboarding_setups',
  'itops_request_google_workspace_email',
  'itops_resolve_employee',
  'itops_search_access_grants',
  'itops_search_employees',
  'itops_supersede_onboarding_intake',
] as const;

export function hasSelectedItOpsSkill(displays: readonly string[]): boolean {
  return displays.some((display) => {
    const trimmed = display.trim();
    const match = /^(.+?)\s+\(skill:[^)]+\)$/u.exec(trimmed);
    return (match?.[1] ?? trimmed) === ITOPS_SKILL_NAME;
  });
}
