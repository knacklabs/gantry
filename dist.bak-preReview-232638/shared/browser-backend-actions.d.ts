export declare const BROWSER_BACKEND_ACTIONS: readonly ["status", "open", "close", "navigate", "back", "tabs", "snapshot", "screenshot", "console_messages", "network_requests", "click", "type", "press_key", "hover", "drag", "drop", "select_option", "fill_form", "wait_for", "evaluate", "file_upload", "file_attach", "handle_dialog", "resize"];
export type BrowserBackendAction = (typeof BROWSER_BACKEND_ACTIONS)[number];
export declare const PUBLIC_BROWSER_GATEWAY_TOOL_NAMES: Set<string>;
export declare function browserBackendActionSatisfiesGatewayActivity(input: {
    publicToolName?: string;
    action: BrowserBackendAction;
}): boolean;
