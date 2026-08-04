const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5000;

export class DiscordMessageChannelCache {
  private readonly entries = new Map<
    string,
    { channelId: string; expiresAtMs: number }
  >();

  remember(jid: string, messageRef: string, channelId: string): void {
    const now = Date.now();
    const key = this.key(jid, messageRef);
    this.entries.delete(key);
    this.entries.set(key, { channelId, expiresAtMs: now + TTL_MS });
    for (const [candidate, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(candidate);
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }

  resolve(jid: string, messageRef: string): string | undefined {
    const key = this.key(jid, messageRef);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.channelId;
  }

  private key(jid: string, messageRef: string): string {
    return `${jid.trim()}:${messageRef.trim()}`;
  }
}
