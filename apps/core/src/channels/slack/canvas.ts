import { randomUUID } from 'node:crypto';
import {
  asRecord,
  boundedResponseText,
  opaqueHandle,
  optionalString,
  remainingTimeoutMs,
  requiredString,
  SLACK_CANVAS_FETCH_TIMEOUT_MS,
  type CanvasHandleRecord,
  type SectionHandleRecord,
  type SlackCanvasFileLike,
  asCanvasReadError,
  boundCanvasIdFromConversationInfo,
  parseSlackConversationJid,
  isSlackFileUrl,
  CHANNEL_SCOPE_ERROR,
  READ_SCOPE_ERROR,
  SlackCanvasProviderError,
  WRITE_SCOPE_ERROR,
} from './canvas-support.js';

export type { SlackCanvasFileLike } from './canvas-support.js';
import {
  formatSectionCandidates,
  markdownHeadingLabels,
} from './canvas-markdown.js';
import {
  CONTENT_CANVAS_MARKDOWN_MAX_BYTES,
  type ContentCanvasAction,
  type ContentCanvasResult,
  type ContentCanvasSurface,
} from '../../shared/content-canvas.js';

type FetchLike = typeof fetch;

const REPLACE_ALL_TOKEN_TTL_MS = 10 * 60_000;
const MAX_SECTION_HANDLES_PER_READ = 20;
const MAX_SECTION_HANDLE_ENTRIES = 500;
const MAX_CANVAS_HANDLE_ENTRIES = 500;
const MAX_PREFLIGHT_ENTRIES = 100;
const SLACK_CANVAS_READ_DEADLINE_MS = 100_000;
const SLACK_STUB_HYDRATION_BUDGET_MS = 15_000;
const SLACK_CANVAS_EDIT_DEADLINE_MS = 90_000;

export class SlackCanvasService implements ContentCanvasSurface {
  private readonly canvasHandles = new Map<string, CanvasHandleRecord>();
  private readonly sectionHandles = new Map<string, SectionHandleRecord>();
  private readonly replaceAllPreflightIds = new Map<
    string,
    { canvasId: string; mintedAt: number }
  >();
  private readonly editTails = new Map<string, Promise<void>>();

  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async captureSharedCanvases(
    conversationJid: string,
    files: readonly SlackCanvasFileLike[],
  ): Promise<{ lines: string[]; canvasFileIds: Set<string> }> {
    const lines: string[] = [];
    const canvasFileIds = new Set<string>();
    let hydrated = 0;
    // Whole-pass budget: hydration is on the inbound path; never stall chat.
    const hydrateDeadlineAt = Date.now() + SLACK_STUB_HYDRATION_BUDGET_MS;
    for (let file of files) {
      const fileId = file.id;
      if (!fileId) continue;
      // Slack Connect access-check stubs lack mimetype; hydrate (bounded).
      if (
        !isSlackCanvasFile(file) &&
        !file.mimetype &&
        !file.filetype &&
        (file.mode === 'file_access' ||
          file.file_access === 'check_file_info') &&
        hydrated < 5 &&
        hydrateDeadlineAt - Date.now() > 1_000
      ) {
        hydrated += 1;
        try {
          const info = await this.slackApi(
            'files.info',
            { file: fileId },
            Math.min(10_000, hydrateDeadlineAt - Date.now()),
          );
          const resolved = (info.file ?? {}) as SlackCanvasFileLike;
          file = { ...file, ...resolved, id: fileId };
        } catch {
          continue;
        }
      }
      if (!isSlackCanvasFile(file)) continue;
      canvasFileIds.add(fileId);
      const handle = this.mintCanvasHandle({
        conversationJid,
        canvasId: fileId,
        access: 'read',
      });
      lines.push(
        `Canvas: ${file.title || file.name || 'shared canvas'} (canvas_read_handle=${handle}; read-only in this conversation)`,
      );
    }
    return { lines, canvasFileIds };
  }

  async executeCanvasAction(
    conversationJid: string,
    action: ContentCanvasAction,
  ): Promise<ContentCanvasResult> {
    const channelId = parseSlackConversationJid(conversationJid);
    if (action.action === 'create') {
      return this.createCanvas(channelId, conversationJid, action);
    }
    const handle = this.resolveCanvasHandle(
      action.canvasHandle,
      conversationJid,
      action.action === 'update' ? 'write' : 'read',
    );
    if (action.action === 'read') {
      return this.readCanvas(conversationJid, handle.canvasId);
    }
    // Deadline includes queue wait: never START a mutation past caller timeout.
    const editDeadlineAt = Date.now() + SLACK_CANVAS_EDIT_DEADLINE_MS;
    return this.serializeEdit(handle.canvasId, () => {
      if (editDeadlineAt - Date.now() < 5_000) {
        throw new Error(
          'Canvas edit not attempted: earlier queued edits consumed the time budget. Nothing was changed; retry.',
        );
      }
      return this.updateCanvas(
        conversationJid,
        handle.canvasId,
        action,
        editDeadlineAt,
      );
    });
  }

  private async createCanvas(
    channelId: string,
    conversationJid: string,
    input: Extract<ContentCanvasAction, { action: 'create' }>,
  ): Promise<ContentCanvasResult> {
    let canvasId: string;
    let existing = false;
    try {
      const response = await this.slackApi('conversations.canvases.create', {
        channel_id: channelId,
        ...(input.title ? { title: input.title } : {}),
        ...(input.markdown !== undefined
          ? {
              document_content: {
                type: 'markdown',
                markdown: input.markdown,
              },
            }
          : {}),
      });
      canvasId = requiredString(response.canvas_id, 'canvas_id');
    } catch (error) {
      if (
        !(error instanceof SlackCanvasProviderError) ||
        (error.code !== 'free_team_canvas_tab_already_exists' &&
          error.code !== 'channel_canvas_already_exists')
      ) {
        throw error;
      }
      existing = true;
      canvasId = await this.resolveBoundCanvasId(channelId);
    }

    const handles = this.mintReadWriteHandles(conversationJid, canvasId);
    const permalink = await this.lookupPermalink(canvasId);
    return {
      message: existing
        ? 'This channel already has a canvas; creation was unnecessary and the existing bound canvas is ready.'
        : permalink
          ? 'Canvas created in this Slack conversation.'
          : 'Canvas created in this Slack conversation, but Slack did not return its permalink. The canvas handles are still usable.',
      ...handles,
      ...(permalink ? { permalink } : {}),
    };
  }

  private async readCanvas(
    conversationJid: string,
    canvasId: string,
  ): Promise<ContentCanvasResult> {
    // One deadline for the whole read, under the caller's 120s MCP timeout;
    // every provider request gets only the remaining time.
    const deadlineAt = Date.now() + SLACK_CANVAS_READ_DEADLINE_MS;
    const remaining = () => remainingTimeoutMs(deadlineAt);
    let info: Record<string, unknown>;
    let sections: Array<Record<string, unknown>>;
    try {
      [info, sections] = await Promise.all([
        this.fileInfo(canvasId, true, remaining()),
        this.lookupSections(
          canvasId,
          { section_types: ['any_header'] },
          remaining(),
        ),
      ]);
    } catch (error) {
      throw asCanvasReadError(error);
    }
    const file = asRecord(info.file);
    // Canvas exports may surface only url_private_download; prefer it.
    const url =
      optionalString(file?.url_private_download) ??
      optionalString(file?.url_private);
    if (!url) {
      throw new Error(
        'Slack canvas export is unavailable. Confirm canvases:read and files:read, reinstall the app to this workspace, and retry.',
      );
    }
    // Remote-file objects echo a caller-supplied URL as url_private: only
    // Slack HTTPS hosts may receive the bearer token (SSRF/credential leak).
    if (file?.is_external === true || !isSlackFileUrl(url)) {
      throw new Error(
        'This file is an external/remote file, not a Slack-hosted canvas; it cannot be read as a canvas.',
      );
    }

    let content: string;
    try {
      const response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.botToken}` },
        signal: AbortSignal.timeout(remaining()),
      });
      if (!response.ok) {
        throw new SlackCanvasProviderError(
          `http_${response.status}`,
          `Slack canvas export returned HTTP ${response.status}.`,
        );
      }
      content = await boundedResponseText(
        response,
        CONTENT_CANVAS_MARKDOWN_MAX_BYTES,
      );
    } catch (error) {
      throw asCanvasReadError(error);
    }

    const sectionLabels = markdownHeadingLabels(content);
    // Handles bind a Slack section id at read time. contains_text is a
    // containment filter over ids-only results, so only an exactly-one match
    // is safe (the exported heading exists, hence the single match IS it).
    // ATTEMPTS are capped so dense canvases cannot drive unbounded calls.
    const sectionResults: Array<{ label: string; handle: string }> = [];
    let omitted = 0;
    let attempts = 0;
    for (const label of sectionLabels) {
      if (
        attempts >= MAX_SECTION_HANDLES_PER_READ ||
        deadlineAt - Date.now() < 2_000
      ) {
        omitted += 1;
        continue;
      }
      attempts += 1;
      let found: Array<Record<string, unknown>> = [];
      try {
        found = await this.lookupSections(
          canvasId,
          { section_types: ['any_header'], contains_text: label },
          remaining(),
        );
      } catch {
        found = [];
      }
      const ids = found
        .map((section) => optionalString(section.id))
        .filter((id): id is string => Boolean(id));
      const sectionId = ids.length === 1 ? ids[0] : undefined;
      if (!sectionId) {
        omitted += 1;
        continue;
      }
      sectionResults.push({
        label,
        handle: this.mintSectionHandle({
          conversationJid,
          canvasId,
          label,
          sectionId,
        }),
      });
    }
    return {
      message:
        (sectionResults.length === 0
          ? 'Canvas read. No editable sections could be resolved; section-targeted edits are unavailable (whole-canvas operations still work).'
          : 'Canvas read. Section handles target headings and are revalidated immediately before every edit.') +
        (omitted > 0
          ? ` ${omitted} heading(s) could not be offered as section handles (duplicate or overlapping heading text, or beyond the per-read limit).`
          : ''),
      content,
      sections: sectionResults,
      ...(optionalString(file?.permalink)
        ? { permalink: optionalString(file?.permalink) }
        : {}),
    };
  }

  private async updateCanvas(
    conversationJid: string,
    canvasId: string,
    input: Extract<ContentCanvasAction, { action: 'update' }>,
    deadlineAt: number,
  ): Promise<ContentCanvasResult> {
    if (input.operation === 'replace_all') {
      // Single-use canvas-bound preflight id ties confirmation to a fresh lookup.
      const supplied = optionalString(input.replaceAllPreflightId);
      const minted = supplied
        ? this.replaceAllPreflightIds.get(supplied)
        : undefined;
      const valid =
        input.confirmReplaceAll === true &&
        minted !== undefined &&
        minted.canvasId === canvasId &&
        Date.now() - minted.mintedAt < REPLACE_ALL_TOKEN_TTL_MS;
      if (supplied) this.replaceAllPreflightIds.delete(supplied);
      if (!valid) {
        const current = await this.lookupSections(canvasId, {});
        const candidates = current
          .slice(0, MAX_SECTION_HANDLES_PER_READ)
          .map((section, index) => ({
            label: `section ${index + 1}`,
            handle: this.mintSectionHandle({
              conversationJid,
              canvasId,
              label: `section ${index + 1}`,
              sectionId: requiredString(section.id, 'section id'),
            }),
          }));
        for (const [id, held] of this.replaceAllPreflightIds) {
          if (Date.now() - held.mintedAt >= REPLACE_ALL_TOKEN_TTL_MS) {
            this.replaceAllPreflightIds.delete(id);
          }
        }
        while (this.replaceAllPreflightIds.size >= MAX_PREFLIGHT_ENTRIES) {
          const oldest = this.replaceAllPreflightIds.keys().next().value;
          if (oldest === undefined) break;
          this.replaceAllPreflightIds.delete(oldest);
        }
        const preflightId = randomUUID();
        this.replaceAllPreflightIds.set(preflightId, {
          canvasId,
          mintedAt: Date.now(),
        });
        throw new Error(
          `replace_all requires confirm_replace_all=true and the single-use preflight id ${preflightId} passed as replace_all_preflight_id (expires in 10 minutes). Review the current sections first: ${formatSectionCandidates(candidates)}`,
        );
      }
    }

    const needsSection = [
      'insert_before',
      'insert_after',
      'replace_section',
      'delete_section',
    ].includes(input.operation);
    const sectionId = needsSection
      ? await this.resolveSectionId(
          input.sectionHandle,
          conversationJid,
          canvasId,
          deadlineAt,
        )
      : undefined;
    const operation =
      input.operation === 'replace_section' || input.operation === 'replace_all'
        ? 'replace'
        : input.operation === 'delete_section'
          ? 'delete'
          : input.operation;
    const change: Record<string, unknown> = {
      operation,
      ...(sectionId ? { section_id: sectionId } : {}),
      ...(input.operation !== 'delete_section'
        ? {
            document_content: {
              type: 'markdown',
              markdown: input.markdown,
            },
          }
        : {}),
    };

    // Re-verify pre-mutation: a late edit must not land after caller timeout.
    const editRemainingMs = deadlineAt - Date.now();
    if (editRemainingMs < 5_000) {
      throw new Error(
        'Canvas edit not attempted: section revalidation consumed the time budget. Nothing was changed; retry.',
      );
    }
    try {
      await this.slackApi(
        'canvases.edit',
        { canvas_id: canvasId, changes: [change] },
        Math.min(SLACK_CANVAS_FETCH_TIMEOUT_MS, editRemainingMs),
      );
    } catch (error) {
      if (
        error instanceof SlackCanvasProviderError &&
        ['canvas_editing_locked', 'conflict', 'canvas_conflict'].includes(
          error.code,
        )
      ) {
        throw new Error(
          'Slack has this canvas locked or it changed concurrently. This is retryable; wait briefly, read the canvas again, and retry the edit.',
          { cause: error },
        );
      }
      if (
        error instanceof SlackCanvasProviderError &&
        ['canvas_not_found', 'canvas_deleted'].includes(error.code)
      ) {
        throw new Error(
          'This canvas handle is stale because the Slack canvas no longer exists. Share or create the canvas again.',
          { cause: error },
        );
      }
      throw error;
    }
    return {
      message:
        'Canvas updated. Slack applies last-write-wins; Gantry serialized its own edits, but concurrent human edits are not protected.',
    };
  }

  private async resolveSectionId(
    sectionHandle: string | undefined,
    conversationJid: string,
    canvasId: string,
    deadlineAt: number,
  ): Promise<string> {
    if (!sectionHandle) {
      throw new Error('This canvas update operation requires section_handle.');
    }
    const record = this.sectionHandles.get(sectionHandle);
    if (
      !record ||
      record.conversationJid !== conversationJid ||
      record.canvasId !== canvasId
    ) {
      throw new Error(
        'This section handle is stale or belongs to another canvas or conversation. Read the canvas again.',
      );
    }
    const matches = await this.lookupSections(
      canvasId,
      {},
      remainingTimeoutMs(deadlineAt),
    );
    const matched = matches.filter(
      (section) => section.id === record.sectionId,
    );
    if (matched.length === 0) {
      throw new Error(
        `No current canvas section matches "${record.label}". The section handle is stale; read the canvas again.`,
      );
    }
    if (matched.length > 1) {
      const candidates = matched.map((section, index) => ({
        label: `${record.label} (${index + 1})`,
        handle: this.mintSectionHandle({
          conversationJid,
          canvasId,
          label: `${record.label} (${index + 1})`,
          sectionId: requiredString(section.id, 'section id'),
        }),
      }));
      throw new Error(
        `Multiple canvas sections match "${record.label}"; choose one of these exact handles: ${formatSectionCandidates(candidates)}`,
      );
    }
    return requiredString(matched[0]?.id, 'section id');
  }

  private async lookupSections(
    canvasId: string,
    criteria: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Array<Record<string, unknown>>> {
    try {
      const response = await this.slackApi(
        'canvases.sections.lookup',
        { canvas_id: canvasId, criteria },
        timeoutMs,
      );
      return Array.isArray(response.sections)
        ? (response.sections.map(asRecord).filter(Boolean) as Array<
            Record<string, unknown>
          >)
        : [];
    } catch (error) {
      if (
        error instanceof SlackCanvasProviderError &&
        error.code === 'missing_scope'
      ) {
        throw new Error(READ_SCOPE_ERROR, { cause: error });
      }
      throw error;
    }
  }

  private async resolveBoundCanvasId(channelId: string): Promise<string> {
    const response = await this.slackApi('conversations.info', {
      channel: channelId,
    });
    const fileId = boundCanvasIdFromConversationInfo(response);
    if (!fileId) {
      throw new Error(
        'This channel already has a canvas, but Slack did not identify it. Open the existing canvas in Slack and try again after reinstalling the app scopes if needed.',
      );
    }
    return fileId;
  }

  private async lookupPermalink(canvasId: string): Promise<string | undefined> {
    try {
      const response = await this.fileInfo(canvasId, false);
      return optionalString(asRecord(response.file)?.permalink);
    } catch {
      return undefined;
    }
  }

  private fileInfo(
    canvasId: string,
    requiredForRead: boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.slackApi('files.info', { file: canvasId }, timeoutMs).catch(
      (error) => {
        if (
          requiredForRead &&
          error instanceof SlackCanvasProviderError &&
          error.code === 'missing_scope'
        ) {
          throw new Error(READ_SCOPE_ERROR);
        }
        throw error;
      },
    );
  }

  private async slackApi(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = SLACK_CANVAS_FETCH_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.botToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      // Below the 120s MCP deadline so a stall cannot hold serializeEdit.
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new SlackCanvasProviderError(
        `http_${response.status}`,
        `Slack ${method} returned HTTP ${response.status}.`,
        response.status === 429 || response.status >= 500,
      );
    }
    const payload = asRecord(await response.json());
    if (!payload) throw new Error(`Slack ${method} returned malformed JSON.`);
    if (payload.ok === false) {
      const code = optionalString(payload.error) || 'unknown_error';
      if (code === 'missing_scope') {
        throw new SlackCanvasProviderError(
          code,
          method.endsWith('canvases.create') || method === 'canvases.edit'
            ? WRITE_SCOPE_ERROR
            : method === 'conversations.info'
              ? CHANNEL_SCOPE_ERROR
              : READ_SCOPE_ERROR,
        );
      }
      throw new SlackCanvasProviderError(
        code,
        `Slack ${method} failed: ${code}.`,
      );
    }
    return payload;
  }

  private resolveCanvasHandle(
    handle: string,
    conversationJid: string,
    requiredAccess: 'read' | 'write',
  ): CanvasHandleRecord {
    const record = this.canvasHandles.get(handle);
    if (
      !record ||
      record.conversationJid !== conversationJid ||
      (requiredAccess === 'write' && record.access !== 'write')
    ) {
      throw new Error(
        requiredAccess === 'write'
          ? "This canvas update handle is stale, belongs to another conversation, or is read-only. Create the canvas here or use this channel's bound canvas."
          : 'This canvas read handle is stale or belongs to another conversation. Share or create the canvas here again.',
      );
    }
    return record;
  }

  private mintReadWriteHandles(
    conversationJid: string,
    canvasId: string,
  ): Pick<ContentCanvasResult, 'canvasReadHandle' | 'canvasUpdateHandle'> {
    return {
      canvasReadHandle: this.mintCanvasHandle({
        conversationJid,
        canvasId,
        access: 'read',
      }),
      canvasUpdateHandle: this.mintCanvasHandle({
        conversationJid,
        canvasId,
        access: 'write',
      }),
    };
  }

  private mintCanvasHandle(record: CanvasHandleRecord): string {
    // Re-sharing the same canvas reuses its handle (bounds map growth).
    for (const [existing, held] of this.canvasHandles) {
      if (
        held.conversationJid === record.conversationJid &&
        held.canvasId === record.canvasId &&
        held.access === record.access
      ) {
        return existing;
      }
    }
    while (this.canvasHandles.size >= MAX_CANVAS_HANDLE_ENTRIES) {
      const oldest = this.canvasHandles.keys().next().value;
      if (oldest === undefined) break;
      this.canvasHandles.delete(oldest);
    }
    const handle = opaqueHandle('canvas');
    this.canvasHandles.set(handle, record);
    return handle;
  }

  private evictSectionHandles(): void {
    // Other participants author canvas content: cap the map (FIFO eviction).
    while (this.sectionHandles.size >= MAX_SECTION_HANDLE_ENTRIES) {
      const oldest = this.sectionHandles.keys().next().value;
      if (oldest === undefined) break;
      this.sectionHandles.delete(oldest);
    }
  }

  private mintSectionHandle(record: SectionHandleRecord): string {
    this.evictSectionHandles();
    const handle = opaqueHandle('section');
    this.sectionHandles.set(handle, record);
    return handle;
  }

  private async serializeEdit<T>(
    canvasId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.editTails.get(canvasId) ?? Promise.resolve();
    let resolveTail!: () => void;
    const tail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });
    this.editTails.set(canvasId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      resolveTail();
      if (this.editTails.get(canvasId) === tail) {
        this.editTails.delete(canvasId);
      }
    }
  }
}

export function isSlackCanvasFile(file: SlackCanvasFileLike): boolean {
  return (
    file.mode === 'canvas' ||
    file.filetype === 'canvas' ||
    file.mimetype === 'application/vnd.slack-docs'
  );
}
