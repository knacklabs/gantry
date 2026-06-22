import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Discord setup discovery', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers /gantry as a single guild command instead of bulk overwriting commands', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const { registerDiscordGantryCommand } =
      await import('@core/channels/discord-setup-discovery.js');
    const result = await registerDiscordGantryCommand({
      credentials: {
        botToken: 'discord-token',
        applicationId: '123456789',
      },
      guildId: '987654321',
    });

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://discord.com/api/v10/applications/123456789/guilds/987654321/commands',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"name":"gantry"'),
      }),
    );
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    const model = body.options.find(
      (option: { name?: string }) => option.name === 'model',
    );
    const thinking = body.options.find(
      (option: { name?: string }) => option.name === 'thinking',
    );
    expect(model.options[0]).toMatchObject({
      type: 3,
      name: 'value',
      required: false,
    });
    expect(thinking.options[0]).toMatchObject({
      type: 3,
      name: 'value',
      required: false,
    });
  });

  it('requires Discord Message Content intent during credential validation', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '123456789', flags: 0 }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { validateDiscordCredentials } =
      await import('@core/channels/discord-setup-discovery.js');
    const result = await validateDiscordCredentials({
      botToken: 'discord-token',
      applicationId: '123456789',
    });

    expect(result).toMatchObject({
      ok: false,
      message: 'Discord Message Content intent is not enabled.',
    });
  });

  it('accepts Discord credentials when the Message Content intent is enabled', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '123456789', flags: 1 << 19 }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { validateDiscordCredentials } =
      await import('@core/channels/discord-setup-discovery.js');
    const result = await validateDiscordCredentials({
      botToken: 'discord-token',
      applicationId: '123456789',
    });

    expect(result).toMatchObject({
      ok: true,
      message: 'Discord bot token validated.',
    });
  });

  it('does not offer forum channels until runtime forum posting is implemented', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'guild-1', name: 'Engineering' }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            { id: 'text-1', name: 'general', type: 0 },
            { id: 'forum-1', name: 'ideas', type: 15 },
          ]),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { listDiscordChannels } =
      await import('@core/channels/discord-setup-discovery.js');
    const result = await listDiscordChannels({
      credentials: {
        botToken: 'discord-token',
        applicationId: '123456789',
      },
    });

    expect(result.channels.map((channel) => channel.chatJid)).toEqual([
      'dc:text-1',
    ]);
  });

  it('rejects Discord setup when the bot lacks runtime channel permissions', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: '111111', name: 'Engineering' }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: '222222', name: 'ops', type: 0 }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'bot-1' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([{ id: '111111', permissions: String(1 << 10) }]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ roles: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ permission_overwrites: [] }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchSpy);

    const { verifyDiscordChannelAccess } =
      await import('@core/channels/discord-setup-discovery.js');
    const result = await verifyDiscordChannelAccess({
      credentials: {
        botToken: 'discord-token',
        applicationId: '123456789',
      },
      guildId: '111111',
      channelId: '222222',
    });

    expect(result).toMatchObject({
      ok: false,
      message: 'Discord bot lacks required channel permissions.',
    });
  });
});
