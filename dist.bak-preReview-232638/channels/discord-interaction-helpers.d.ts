import type { DiscordInteraction, DiscordUser } from './discord-types.js';
export declare const DISCORD_API_ROOT = "https://discord.com/api/v10";
export declare const DISCORD_JID_PREFIX = "dc:";
export declare function discordUserName(user: DiscordUser | undefined, fallback?: string): string;
export declare function discordGantrySlashText(interaction: DiscordInteraction): string;
export declare function discordChannelIdFromJid(jid: string): string | null;
export declare function discordHeaders(token: string): Record<string, string>;
export declare function ackDiscordInteraction(botToken: string, interaction: DiscordInteraction, content: string): Promise<void>;
export declare function updateDiscordInteractionResponse(applicationId: string, interaction: DiscordInteraction, content: string): Promise<void>;
