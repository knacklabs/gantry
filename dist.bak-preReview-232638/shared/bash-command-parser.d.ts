export interface BashCommandRedirect {
    operator: string;
    target: string;
    destructive: boolean;
}
export interface BashCommandLeaf {
    argv: string[];
    commandText: string;
    redirects: BashCommandRedirect[];
}
export type BashCommandParseResult = {
    ok: true;
    leaves: BashCommandLeaf[];
} | {
    ok: false;
    reason: string;
};
export declare function parseBashCommand(command: string): BashCommandParseResult;
export declare function firstDestructiveRedirectTarget(command: string): string | undefined;
export declare function destructiveBashCommandHint(command: string): string | undefined;
export declare function bashLeafRuleContent(leaf: BashCommandLeaf): string;
export declare function normalizeBashLeafRuleContent(leaf: BashCommandLeaf): string | undefined;
export declare function normalizePersistentBashRuleContent(ruleContent: string): string;
export declare function nonDurableBashLeafReason(leaf: BashCommandLeaf): string | undefined;
export declare function wildcardSensitiveBashLeafReason(leaf: BashCommandLeaf, scope: string): string | undefined;
export declare function bashExecutableName(command: string): string;
export declare function formatBashArgv(argv: readonly string[]): string;
/**
 * Best-effort, human-readable gist of which programs a command runs, for
 * permission prompts ("npm, git"). Returns the ordered distinct program names,
 * or undefined when the command can't be parsed safely (the caller then falls
 * back to showing the raw command block instead).
 */
export declare function summarizeBashCommandPrograms(command: string): string | undefined;
