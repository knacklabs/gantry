import type { DiscordUser } from './discord-types.js';
export declare function discordHeaders(token: string): Record<string, string>;
export declare function discordReactionEmoji(emoji: string): string;
export declare function discordRateLimitRetryDelayMs(response: Response): number | null;
export declare function waitDiscordRetryDelay(delayMs: number): Promise<void>;
export declare function userName(user: DiscordUser | undefined, fallback?: string): string;
