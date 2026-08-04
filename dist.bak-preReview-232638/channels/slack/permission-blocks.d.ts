import { type PermissionPromptFullView, type PermissionPromptParts } from '../permission-interaction.js';
type SlackBlock = Record<string, unknown>;
/**
 * Content blocks for a permission prompt: a header (title), a section (the
 * tool-input body, which renders ``` fenced code natively in mrkdwn), a muted
 * context block (metadata + reply window), and a divider. The caller appends
 * the actions block with the decision buttons.
 */
export declare function buildPermissionPromptContentBlocks(parts: PermissionPromptParts): SlackBlock[];
/** A completed permission decision renders as a single muted context line. */
export declare function buildPermissionReceiptBlocks(text: string): SlackBlock[];
export declare function buildPermissionFullViewModalBlocks(fullView: PermissionPromptFullView): SlackBlock[];
export {};
