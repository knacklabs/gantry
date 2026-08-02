import { isInputFlowControl } from './setup-flow-control.js';
export function normalizeSlackPermissionApproverIds(value) {
    return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .join(',');
}
export function validateSlackPermissionApproverIdsInput(value) {
    const trimmed = String(value ?? '').trim();
    if (isInputFlowControl(trimmed))
        return undefined;
    if (!trimmed) {
        return 'At least one Slack approver user ID is required. In Slack, open your profile menu and copy the member ID.';
    }
    const ids = normalizeSlackPermissionApproverIds(trimmed).split(',');
    const invalid = ids.find((id) => !/^[UW][A-Z0-9]{2,}$/.test(id));
    return invalid
        ? `Invalid Slack user ID: ${invalid}. Use IDs like U0123456789.`
        : undefined;
}
