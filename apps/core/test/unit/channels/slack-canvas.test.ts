import { describe, expect, it, vi } from 'vitest';

import { SlackCanvasService } from '@core/channels/slack/canvas.js';
import { CONTENT_CANVAS_MARKDOWN_MAX_BYTES } from '@core/shared/content-canvas.js';
import {
  canvasTaskHandlers,
  configureCanvasIpcHandlers,
  parseCanvasAction,
} from '@core/jobs/ipc-canvas-handlers.js';

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

function handleFromLine(line: string): string {
  const match = /canvas_read_handle=([^;)]+)/.exec(line);
  if (!match?.[1]) throw new Error(`No canvas handle in ${line}`);
  return match[1];
}

describe('slack canvas tools', () => {
  it('does not treat fence-nested markers or code headings as sections', async () => {
    const { markdownHeadingLabels } =
      await import('@core/channels/slack/canvas-markdown.js');
    const md = [
      '# Real',
      '````',
      '~~~',
      '# code not a heading',
      '```',
      '# still code (shorter close fence)',
      '````',
      '## After',
      '~~~~',
      '# tilde code',
      '~~~~',
      '### Tail',
      '```',
      '<h1>Fenced Html</h1>',
      '```',
      '<h2>Live Html</h2>',
    ].join('\n');
    expect(markdownHeadingLabels(md)).toEqual([
      'Real',
      'After',
      'Tail',
      'Live Html',
    ]);
  });

  it('refuses update handles for canvases merely shared into the conversation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const service = new SlackCanvasService('xoxb-test', fetcher);
    const [line] = (
      await service.captureSharedCanvases('sl:C1', [
        { id: 'F-SHARED', title: 'Shared plan', filetype: 'canvas' },
      ])
    ).lines;
    const readHandle = handleFromLine(line!);

    await expect(
      service.executeCanvasAction('sl:C1', {
        action: 'update',
        canvasHandle: readHandle,
        operation: 'insert_at_end',
        markdown: 'unauthorized',
      }),
    ).rejects.toThrow(/read-only/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(line).toContain('read-only in this conversation');
  });

  it('creates in the host-derived channel and follows files.info for the permalink', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), body: bodyOf(init) });
        if (String(url).endsWith('/conversations.canvases.create')) {
          return json({ ok: true, canvas_id: 'F-CREATED' });
        }
        return json({
          ok: true,
          file: { permalink: 'https://workspace.slack.com/docs/F-CREATED' },
        });
      }) as typeof fetch,
    );

    const result = await service.executeCanvasAction('sl:C-HOST', {
      action: 'create',
      title: 'Plan',
      markdown: '# Plan',
    });

    expect(calls[0]).toMatchObject({
      url: 'https://slack.com/api/conversations.canvases.create',
      body: {
        channel_id: 'C-HOST',
        title: 'Plan',
        document_content: { type: 'markdown', markdown: '# Plan' },
      },
    });
    expect(calls[1]).toMatchObject({
      url: 'https://slack.com/api/files.info',
      body: { file: 'F-CREATED' },
    });
    expect(result).toMatchObject({
      permalink: 'https://workspace.slack.com/docs/F-CREATED',
      canvasReadHandle: expect.stringMatching(/^gantry_canvas_/),
      canvasUpdateHandle: expect.stringMatching(/^gantry_canvas_/),
    });
    expect(result.canvasReadHandle).not.toBe(result.canvasUpdateHandle);
  });

  it('creates a standalone canvas for DMs with an honest sharing message', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url, init) => {
        calls.push({ url: String(url), body: bodyOf(init) });
        if (String(url).endsWith('/canvases.create')) {
          return json({ ok: true, canvas_id: 'F-DM' });
        }
        return json({
          ok: true,
          file: { permalink: 'https://workspace.slack.com/docs/F-DM' },
        });
      }) as typeof fetch,
    );

    const result = await service.executeCanvasAction('sl:D0123456789', {
      action: 'create',
      title: 'Notes',
      markdown: '# Notes',
    });

    expect(calls[0]!.url).toBe('https://slack.com/api/canvases.create');
    expect(calls[0]!.body.channel_id).toBeUndefined();
    expect(result.message).toContain('Standalone canvas');
    expect(result.permalink).toBe('https://workspace.slack.com/docs/F-DM');
  });

  it('returns the existing bound canvas on the free-team limit', async () => {
    const calls: string[] = [];
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/conversations.canvases.create')) {
          return json({
            ok: false,
            error: 'free_team_canvas_tab_already_exists',
          });
        }
        if (String(url).endsWith('/conversations.info')) {
          return json({
            ok: true,
            channel: { properties: { canvas: { file_id: 'F-BOUND' } } },
          });
        }
        return json({ ok: true, file: { permalink: 'https://slack/F-BOUND' } });
      }) as typeof fetch,
    );

    const result = await service.executeCanvasAction('sl:C1', {
      action: 'create',
      markdown: '# Existing',
    });

    expect(result.message).toContain('creation was unnecessary');
    expect(result.canvasUpdateHandle).toMatch(/^gantry_canvas_/);
    expect(calls).toEqual([
      'https://slack.com/api/conversations.canvases.create',
      'https://slack.com/api/conversations.info',
      'https://slack.com/api/files.info',
    ]);
  });

  it('keeps files.info permalink failure non-fatal', async () => {
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url) =>
        String(url).endsWith('/conversations.canvases.create')
          ? json({ ok: true, canvas_id: 'F1' })
          : json({ ok: false, error: 'missing_scope' }),
      ) as typeof fetch,
    );

    const result = await service.executeCanvasAction('sl:C1', {
      action: 'create',
      markdown: 'body',
    });

    expect(result.permalink).toBeUndefined();
    expect(result.message).toContain('did not return its permalink');
  });

  it('reads bounded canvas export text and returns heading section handles', async () => {
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url, init) => {
        if (String(url).endsWith('/files.info')) {
          return json({
            ok: true,
            file: {
              url_private: 'https://files.slack.com/F1',
              permalink: 'https://slack/F1',
            },
          });
        }
        if (String(url).endsWith('/canvases.sections.lookup')) {
          const criteria = JSON.parse(String(init?.body)) as {
            criteria?: { contains_text?: string };
          };
          const text = criteria.criteria?.contains_text;
          if (text === 'Status')
            return json({ ok: true, sections: [{ id: 'S1' }] });
          if (text === 'Decisions')
            return json({ ok: true, sections: [{ id: 'S2' }] });
          return json({ ok: true, sections: [{ id: 'S1' }, { id: 'S2' }] });
        }
        return new Response('# Status\nBody\n## Decisions\nDone\n## Plan\nx', {
          headers: { 'content-type': 'text/plain' },
        });
      }) as typeof fetch,
    );
    const readHandle = handleFromLine(
      (
        await service.captureSharedCanvases('sl:C1', [
          { id: 'F1', filetype: 'canvas' },
        ])
      ).lines[0]!,
    );

    const result = await service.executeCanvasAction('sl:C1', {
      action: 'read',
      canvasHandle: readHandle,
    });

    expect(result.content).toContain('## Decisions');
    // 'Plan' matches two sections via contains_text: ambiguous, so no handle.
    expect(result.sections).toEqual([
      { label: 'Status', handle: expect.stringMatching(/^gantry_section_/) },
      { label: 'Decisions', handle: expect.stringMatching(/^gantry_section_/) },
    ]);
    expect(result.message).toContain('could not be offered');
  });

  it('extracts section labels from HTML-shaped canvas exports too', async () => {
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url, init) => {
        if (String(url).endsWith('/files.info')) {
          return json({
            ok: true,
            file: { url_private: 'https://files.slack.com/F1' },
          });
        }
        if (String(url).endsWith('/canvases.sections.lookup')) {
          const criteria = JSON.parse(String(init?.body)) as {
            criteria?: { contains_text?: string };
          };
          return json({
            ok: true,
            sections:
              criteria.criteria?.contains_text === 'Roll-out & risks'
                ? [{ id: 'S9' }]
                : [],
          });
        }
        return new Response(
          '<html><body><h1>Roll-out &amp; risks</h1><p>x</p></body></html>',
        );
      }) as typeof fetch,
    );
    const readHandle = handleFromLine(
      (
        await service.captureSharedCanvases('sl:C1', [
          { id: 'F1', filetype: 'canvas' },
        ])
      ).lines[0]!,
    );

    const result = await service.executeCanvasAction('sl:C1', {
      action: 'read',
      canvasHandle: readHandle,
    });
    expect(result.sections).toEqual([
      {
        label: 'Roll-out & risks',
        handle: expect.stringMatching(/^gantry_section_/),
      },
    ]);
  });

  it('refuses to send the bot token to non-Slack export hosts', async () => {
    const fetcher = vi.fn(async (url: unknown) =>
      String(url).endsWith('/files.info')
        ? json({
            ok: true,
            file: { url_private: 'https://attacker.example.com/steal' },
          })
        : json({ ok: true, sections: [] }),
    );
    const service = new SlackCanvasService(
      'xoxb-test',
      fetcher as unknown as typeof fetch,
    );
    const readHandle = handleFromLine(
      (
        await service.captureSharedCanvases('sl:C1', [
          { id: 'F1', filetype: 'canvas' },
        ])
      ).lines[0]!,
    );

    await expect(
      service.executeCanvasAction('sl:C1', {
        action: 'read',
        canvasHandle: readHandle,
      }),
    ).rejects.toThrow(/external\/remote file/);
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes('attacker.example.com'),
      ),
    ).toBe(false);
  });

  it('surfaces missing read scopes with reinstall guidance', async () => {
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url) =>
        String(url).endsWith('/files.info')
          ? json({
              ok: true,
              file: { url_private: 'https://files.slack.com/F1' },
            })
          : json({ ok: false, error: 'missing_scope' }),
      ) as typeof fetch,
    );
    const readHandle = handleFromLine(
      (
        await service.captureSharedCanvases('sl:C1', [
          { id: 'F1', filetype: 'canvas' },
        ])
      ).lines[0]!,
    );

    await expect(
      service.executeCanvasAction('sl:C1', {
        action: 'read',
        canvasHandle: readHandle,
      }),
    ).rejects.toThrow(/canvases:read and files:read.*reinstall/i);
  });

  it('never retargets a stale section handle and omits unresolvable headings', async () => {
    const lookupResults: Array<Array<{ id: string }>> = [
      [{ id: 'S1' }], // read 1: any_header listing
      [{ id: 'S1' }], // read 1: id-bind for 'Duplicate' -> bound to S1
      [{ id: 'S2' }], // update 1 revalidation: S1 gone, similar section exists
      [{ id: 'S1' }, { id: 'S2' }], // read 2: any_header listing
      [], // read 2: bind fails -> heading omitted, no dead-end handle
    ];
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url) => {
        if (String(url).endsWith('/conversations.canvases.create')) {
          return json({ ok: true, canvas_id: 'F1' });
        }
        if (String(url).endsWith('/files.info')) {
          return json({
            ok: true,
            file: { url_private: 'https://files.slack.com/F1' },
          });
        }
        if (String(url).endsWith('/canvases.sections.lookup')) {
          return json({ ok: true, sections: lookupResults.shift() ?? [] });
        }
        return new Response('# Duplicate\nBody');
      }) as typeof fetch,
    );
    const created = await service.executeCanvasAction('sl:C1', {
      action: 'create',
      markdown: '# Duplicate',
    });
    const read = await service.executeCanvasAction('sl:C1', {
      action: 'read',
      canvasHandle: created.canvasReadHandle!,
    });
    const sectionHandle = read.sections![0]!.handle;

    // The handle is bound to S1; when S1 vanishes and only a similarly
    // named S2 remains, the edit must fail rather than retarget S2.
    await expect(
      service.executeCanvasAction('sl:C1', {
        action: 'update',
        canvasHandle: created.canvasUpdateHandle!,
        sectionHandle,
        operation: 'replace_section',
        markdown: '# Updated',
      }),
    ).rejects.toThrow(/No current canvas section matches/);

    const reread = await service.executeCanvasAction('sl:C1', {
      action: 'read',
      canvasHandle: created.canvasReadHandle!,
    });
    expect(reread.sections).toEqual([]);
    expect(reread.message).toContain('could not be offered');
  });

  it('surfaces Slack edit locks as retryable and serializes host edits per canvas', async () => {
    let editCalls = 0;
    let activeEdits = 0;
    let peakEdits = 0;
    const service = new SlackCanvasService(
      'xoxb-test',
      vi.fn(async (url) => {
        if (String(url).endsWith('/conversations.canvases.create')) {
          return json({ ok: true, canvas_id: 'F1' });
        }
        if (String(url).endsWith('/files.info')) {
          return json({ ok: true, file: {} });
        }
        if (String(url).endsWith('/canvases.edit')) {
          editCalls += 1;
          if (editCalls === 1) {
            return json({ ok: false, error: 'canvas_editing_locked' });
          }
          activeEdits += 1;
          peakEdits = Math.max(peakEdits, activeEdits);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeEdits -= 1;
          return json({ ok: true });
        }
        throw new Error(`Unexpected URL ${url}`);
      }) as typeof fetch,
    );
    const created = await service.executeCanvasAction('sl:C1', {
      action: 'create',
      markdown: 'body',
    });
    const update = (markdown: string) =>
      service.executeCanvasAction('sl:C1', {
        action: 'update',
        canvasHandle: created.canvasUpdateHandle!,
        operation: 'insert_at_end',
        markdown,
      });

    await expect(update('locked')).rejects.toThrow(/retryable/);
    await Promise.all([update('one'), update('two')]);
    expect(peakEdits).toBe(1);
  });

  it('enforces strict IPC fields and exact title and markdown boundaries', () => {
    expect(
      parseCanvasAction('canvas_create', {
        title: 'x'.repeat(300),
        markdown: 'y'.repeat(CONTENT_CANVAS_MARKDOWN_MAX_BYTES),
      }),
    ).toMatchObject({ action: 'create' });
    expect(() =>
      parseCanvasAction('canvas_create', { title: 'x'.repeat(301) }),
    ).toThrow(/at most 300/);
    expect(() =>
      parseCanvasAction('canvas_create', {
        markdown: 'y'.repeat(CONTENT_CANVAS_MARKDOWN_MAX_BYTES + 1),
      }),
    ).toThrow(/UTF-8 bytes/);
    expect(() =>
      parseCanvasAction('canvas_update', {
        canvas_handle: 'h',
        operation: 'insert_at_end',
        markdown: 'ok',
        changes: [{ operation: 'delete' }, { operation: 'replace' }],
      }),
    ).toThrow(/Unknown canvas field.*changes/);
    expect(() =>
      parseCanvasAction('canvas_update', {
        canvas_handle: 'h',
        operation: ['insert_at_end', 'delete_section'],
        markdown: 'ok',
      }),
    ).toThrow(/operation must be a string/);
  });

  it('rejects invalid IPC bounds before calling the provider adapter', async () => {
    const execute = vi.fn();
    configureCanvasIpcHandlers(execute);
    try {
      await canvasTaskHandlers.canvas_update!({
        data: {
          type: 'canvas_update',
          taskId: 'invalid-canvas-bound',
          appId: 'app-1',
          providerAccountId: 'slack-1',
          chatJid: 'sl:C1',
          targetJid: 'sl:C1',
          payload: {
            canvas_handle: 'opaque',
            operation: 'insert_at_end',
            markdown: 'x'.repeat(CONTENT_CANVAS_MARKDOWN_MAX_BYTES + 1),
          },
        },
        sourceAgentFolder: 'canvas_test',
        sourceAgentFolderJids: ['sl:C1'],
        conversationBindings: {},
        deps: {} as never,
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      configureCanvasIpcHandlers(undefined);
    }
  });
});
