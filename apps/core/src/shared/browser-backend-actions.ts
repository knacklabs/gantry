export const BROWSER_BACKEND_ACTIONS = [
  'status',
  'open',
  'close',
  'navigate',
  'back',
  'tabs',
  'snapshot',
  'screenshot',
  'console_messages',
  'network_requests',
  'click',
  'type',
  'press_key',
  'hover',
  'drag',
  'drop',
  'select_option',
  'fill_form',
  'wait_for',
  'evaluate',
  'file_upload',
  'file_attach',
  'download',
  'handle_dialog',
  'resize',
] as const;

export type BrowserBackendAction = (typeof BROWSER_BACKEND_ACTIONS)[number];

export const PUBLIC_BROWSER_GATEWAY_TOOL_NAMES = new Set([
  'browser_status',
  'browser_open',
  'browser_inspect',
  'browser_act',
  'browser_close',
]);

const BROWSER_INSPECT_BACKEND_ACTIONS = new Set<BrowserBackendAction>([
  'snapshot',
  'tabs',
  'screenshot',
  'console_messages',
  'network_requests',
]);

const BROWSER_ACT_BACKEND_ACTIONS = new Set<BrowserBackendAction>([
  'navigate',
  'back',
  'tabs',
  'click',
  'type',
  'wait_for',
  'screenshot',
  'evaluate',
  'press_key',
  'hover',
  'drag',
  'drop',
  'select_option',
  'fill_form',
  'file_upload',
  'file_attach',
  'download',
  'handle_dialog',
  'resize',
]);

export function browserBackendActionSatisfiesGatewayActivity(input: {
  publicToolName?: string;
  action: BrowserBackendAction;
}): boolean {
  if (input.publicToolName === 'browser_open') {
    return input.action === 'navigate';
  }
  if (input.publicToolName === 'browser_inspect') {
    return BROWSER_INSPECT_BACKEND_ACTIONS.has(input.action);
  }
  if (input.publicToolName === 'browser_act') {
    return BROWSER_ACT_BACKEND_ACTIONS.has(input.action);
  }
  return false;
}
