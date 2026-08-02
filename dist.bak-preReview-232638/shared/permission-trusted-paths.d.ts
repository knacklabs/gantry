import { type BashCommandLeaf } from './bash-command-parser.js';
export declare function outOfTrustedRootReason(leaves: readonly BashCommandLeaf[], workspaceRoot: string | undefined, trustedRoots: readonly string[]): string | undefined;
export declare function canonicalizeTrustedRoot(target: string): string;
