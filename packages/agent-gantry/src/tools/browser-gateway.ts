import type {
  GantryAgentTool,
  GantryAgentToolContext,
  GantryBrowserGatewayActAction,
  GantryBrowserGatewayInspectMode,
  GantryBrowserGatewayRequest,
  GantryBrowserGatewayStateRequest,
  GantryBrowserGatewayToolName,
  GantryBrowserGatewayToolProvider,
  GantryBrowserGatewayVerifyDocumentActionRequest,
} from '../shared/types.js';
import { summarizeAgentObservation } from '../tasks/agent-task-runner.js';
import {
  asNonEmptyString,
  asRecord,
  readNumber,
  readString,
  readStringArray,
} from '../shared/helpers.js';

export function createGantryBrowserGatewayAgentTools(
  provider: GantryBrowserGatewayToolProvider,
): readonly GantryAgentTool[] {
  const makeRequest = (
    toolName: GantryBrowserGatewayToolName,
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
  ): GantryBrowserGatewayRequest => ({
    toolName,
    correlationId:
      readString(input, 'correlationId') ?? context.correlationId ?? null,
    step: context.step,
    timeoutMs: readNumber(input, 'timeoutMs'),
    context,
  });

  const executeBrowserTool = async (
    toolName: GantryBrowserGatewayToolName,
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
    execute: (
      request: GantryBrowserGatewayRequest,
    ) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    try {
      const result = await execute(makeRequest(toolName, input, context));
      rememberBrowserGatewayObservation(context, toolName, result);
      return result;
    } catch (error) {
      const result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        toolName,
      };
      rememberBrowserGatewayObservation(context, toolName, result);
      return result;
    }
  };

  const makeStateRequest = (
    toolName: GantryBrowserGatewayToolName,
    input: Record<string, unknown>,
    context: GantryAgentToolContext,
  ): GantryBrowserGatewayStateRequest => ({
    ...makeRequest(toolName, input, context),
    snapshotId: readString(input, 'snapshotId'),
    stateRef: readString(input, 'stateRef'),
    family: readString(input, 'family'),
    cursor: readString(input, 'cursor') ?? readNumber(input, 'cursor'),
    limit: readNumber(input, 'limit'),
    query: readString(input, 'query'),
    families: readStringArray(input.families),
    tableId: readString(input, 'tableId') ?? readNumber(input, 'tableId'),
    rowCursor: readString(input, 'rowCursor') ?? readNumber(input, 'rowCursor'),
    elementId: readString(input, 'elementId'),
    ref: readString(input, 'ref'),
    selector: readString(input, 'selector'),
    queryOrCursor: readString(input, 'queryOrCursor'),
    tabId: readString(input, 'tabId'),
  });

  const tools: GantryAgentTool[] = [
    {
      name: 'browser_status',
      description:
        'Inspect whether the dedicated headed agent browser session is ready, without launching the scrape engine browser.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_status', input, context, (request) =>
          provider.status(request),
        ),
    },
    {
      name: 'browser_open',
      description:
        'Launch or reuse the dedicated headed agent browser profile and optionally navigate it to a URL.',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          profileKey: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_open', input, context, (request) =>
          provider.open({
            ...request,
            url: readString(input, 'url'),
            profileKey: readString(input, 'profileKey'),
          }),
        ),
    },
    {
      name: 'browser_inspect',
      description:
        'Inspect the current headed agent browser state: accessibility snapshot, screenshot, tabs, console, or network events.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['snapshot', 'screenshot', 'tabs', 'console', 'network'],
          },
          tabId: { type: 'string' },
          reason: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_inspect', input, context, (request) =>
          provider.inspect({
            ...request,
            mode: readBrowserInspectMode(input.mode),
            tabId: readString(input, 'tabId'),
            reason: readString(input, 'reason'),
          }),
        ),
    },
    {
      name: 'browser_act',
      description:
        'Perform one browser action in the headed agent browser, such as navigate, click, type, wait, select, tabs, dialog, or screenshot.',
      inputSchema: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate',
              'back',
              'forward',
              'reload',
              'click',
              'type',
              'fill',
              'select',
              'wait',
              'keyboard',
              'screenshot',
              'tab_new',
              'tab_select',
              'tab_close',
              'dialog',
            ],
          },
          tabId: { type: 'string' },
          payload: { type: 'object' },
          reason: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_act', input, context, (request) =>
          provider.act({
            ...request,
            action: readBrowserActAction(input.action),
            tabId: readString(input, 'tabId'),
            payload: asRecord(input.payload) ?? {},
            reason: readString(input, 'reason'),
          }),
        ),
    },
    ...(provider.verifyDocumentAction
      ? [
          {
            name: 'browser_verify_document_action',
            description:
              'Click one current row/detail-scoped tender document control and verify the practical outcome: browser download, document response, popup/new tab, handoff page, final download button, captcha, login gate, or no progress.',
            inputSchema: {
              type: 'object',
              properties: {
                tabId: { type: 'string' },
                selector: { type: 'string' },
                ref: { type: 'string' },
                snapshotId: { type: 'string' },
                text: { type: 'string' },
                label: { type: 'string' },
                payload: { type: 'object' },
                reason: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool(
                'browser_verify_document_action',
                input,
                context,
                (request) =>
                  (
                    provider.verifyDocumentAction as NonNullable<
                      GantryBrowserGatewayToolProvider['verifyDocumentAction']
                    >
                  )({
                    ...request,
                    tabId: readString(input, 'tabId'),
                    selector: readString(input, 'selector'),
                    ref: readString(input, 'ref'),
                    snapshotId: readString(input, 'snapshotId'),
                    text: readString(input, 'text'),
                    label: readString(input, 'label'),
                    payload: asRecord(input.payload) ?? {},
                    reason: readString(input, 'reason'),
                  } satisfies GantryBrowserGatewayVerifyDocumentActionRequest),
              ),
          },
        ]
      : []),
    ...(provider.listStateSections
      ? [
          {
            name: 'browser_list_state_sections',
            description:
              'List the stored browser state sections for a snapshot: counts, stateRef, cursors, and unresolved families. Use this when the overview says more controls/tables/text exist.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool(
                'browser_list_state_sections',
                input,
                context,
                () =>
                  (
                    provider.listStateSections as NonNullable<
                      GantryBrowserGatewayToolProvider['listStateSections']
                    >
                  )(
                    makeStateRequest(
                      'browser_list_state_sections',
                      input,
                      context,
                    ),
                  ),
              ),
          },
        ]
      : []),
    ...(provider.readControls
      ? [
          {
            name: 'browser_read_controls',
            description:
              'Read a bounded cursor window from stored browser controls. family can be controls, route, detail, document, pagination, form, modal, table, or text.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                family: { type: 'string' },
                cursor: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                limit: { type: 'number' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool('browser_read_controls', input, context, () =>
                (
                  provider.readControls as NonNullable<
                    GantryBrowserGatewayToolProvider['readControls']
                  >
                )(makeStateRequest('browser_read_controls', input, context)),
              ),
          },
        ]
      : []),
    ...(provider.readTable
      ? [
          {
            name: 'browser_read_table',
            description:
              'Read a stored table summary and a bounded row window by tableId/tableIndex. Use this instead of assuming the first sampled rows are the whole listing.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                tableId: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                rowCursor: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                cursor: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                limit: { type: 'number' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool('browser_read_table', input, context, () =>
                (
                  provider.readTable as NonNullable<
                    GantryBrowserGatewayToolProvider['readTable']
                  >
                )(makeStateRequest('browser_read_table', input, context)),
              ),
          },
        ]
      : []),
    ...(provider.searchState
      ? [
          {
            name: 'browser_search_state',
            description:
              'Search stored browser state across controls, route/detail/document/pagination/form/modal/table/text families without sending the full DOM to the model.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                query: { type: 'string' },
                families: { type: 'array', items: { type: 'string' } },
                cursor: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                limit: { type: 'number' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool('browser_search_state', input, context, () =>
                (
                  provider.searchState as NonNullable<
                    GantryBrowserGatewayToolProvider['searchState']
                  >
                )(makeStateRequest('browser_search_state', input, context)),
              ),
          },
        ]
      : []),
    ...(provider.readElement
      ? [
          {
            name: 'browser_read_element',
            description:
              'Read exact stored details for one elementId, ref, or selector from the current snapshot store.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                elementId: { type: 'string' },
                ref: { type: 'string' },
                selector: { type: 'string' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool('browser_read_element', input, context, () =>
                (
                  provider.readElement as NonNullable<
                    GantryBrowserGatewayToolProvider['readElement']
                  >
                )(makeStateRequest('browser_read_element', input, context)),
              ),
          },
        ]
      : []),
    ...(provider.readTextChunks
      ? [
          {
            name: 'browser_read_text_chunks',
            description:
              'Read/search stored page text chunks for the snapshot. This is how the agent inspects text beyond the overview preview.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                queryOrCursor: { type: 'string' },
                query: { type: 'string' },
                cursor: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                limit: { type: 'number' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool(
                'browser_read_text_chunks',
                input,
                context,
                () =>
                  (
                    provider.readTextChunks as NonNullable<
                      GantryBrowserGatewayToolProvider['readTextChunks']
                    >
                  )(
                    makeStateRequest(
                      'browser_read_text_chunks',
                      input,
                      context,
                    ),
                  ),
              ),
          },
        ]
      : []),
    ...(provider.scrollToStateElement
      ? [
          {
            name: 'browser_scroll_to_state_element',
            description:
              'Scroll the browser to a stored elementId/ref/selector from the snapshot store, then inspect again before consequential action.',
            inputSchema: {
              type: 'object',
              properties: {
                snapshotId: { type: 'string' },
                stateRef: { type: 'string' },
                elementId: { type: 'string' },
                ref: { type: 'string' },
                selector: { type: 'string' },
                tabId: { type: 'string' },
                timeoutMs: { type: 'number' },
              },
              additionalProperties: false,
            },
            execute: async (
              input: Record<string, unknown>,
              context: GantryAgentToolContext,
            ) =>
              executeBrowserTool(
                'browser_scroll_to_state_element',
                input,
                context,
                () =>
                  (
                    provider.scrollToStateElement as NonNullable<
                      GantryBrowserGatewayToolProvider['scrollToStateElement']
                    >
                  )(
                    makeStateRequest(
                      'browser_scroll_to_state_element',
                      input,
                      context,
                    ),
                  ),
              ),
          },
        ]
      : []),
    {
      name: 'browser_close',
      description:
        'Close only the dedicated agent browser session/profile. This must not close any scrape-runtime browser page.',
      inputSchema: {
        type: 'object',
        properties: {
          timeoutMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      execute: async (input, context) =>
        executeBrowserTool('browser_close', input, context, (request) =>
          provider.close(request),
        ),
    },
  ];
  return tools;
}

function readBrowserInspectMode(
  value: unknown,
): GantryBrowserGatewayInspectMode {
  return value === 'screenshot' ||
    value === 'tabs' ||
    value === 'console' ||
    value === 'network'
    ? value
    : 'snapshot';
}

function readBrowserActAction(value: unknown): GantryBrowserGatewayActAction {
  const allowed = new Set<GantryBrowserGatewayActAction>([
    'navigate',
    'back',
    'forward',
    'reload',
    'click',
    'type',
    'fill',
    'select',
    'wait',
    'keyboard',
    'screenshot',
    'tab_new',
    'tab_select',
    'tab_close',
    'dialog',
  ]);
  return typeof value === 'string' &&
    allowed.has(value as GantryBrowserGatewayActAction)
    ? (value as GantryBrowserGatewayActAction)
    : 'wait';
}

function rememberBrowserGatewayObservation(
  context: GantryAgentToolContext,
  toolName: GantryBrowserGatewayToolName,
  observation: Record<string, unknown>,
): void {
  const existing = asRecord(context.state.browserGateway) ?? {};
  const observedScreenshotRefs =
    collectBrowserGatewayScreenshotRefs(observation);
  const screenshotRefs = [
    ...readStringArray(existing.screenshotRefs),
    ...observedScreenshotRefs,
  ].slice(-12);
  const compactObservation = summarizeAgentObservation(observation);
  const isSnapshotObservation =
    readString(observation, 'mode') === 'snapshot' ||
    Boolean(asRecord(observation.selectorEvidence));
  const currentBrowserState = buildCurrentBrowserState({
    step: context.step,
    toolName,
    observation,
    previousState: asRecord(existing.currentBrowserState),
    observedScreenshotRefs,
    screenshotRefs,
  });
  const browserGateway = {
    ...existing,
    lastToolName: toolName,
    lastObservation: compactObservation,
    ...(isSnapshotObservation
      ? { lastSnapshotObservation: compactObservation }
      : {}),
    screenshotRefs,
    currentBrowserState,
  };
  context.state.browserGateway = browserGateway;
  context.state.currentBrowserState = currentBrowserState;
  const browserContext = asRecord(context.state.browserContext) ?? {};
  context.state.browserContext = {
    ...browserContext,
    gateway: browserGateway,
  };
}

function buildCurrentBrowserState(input: {
  readonly step: number;
  readonly toolName: GantryBrowserGatewayToolName;
  readonly observation: Record<string, unknown>;
  readonly previousState: Record<string, unknown> | null;
  readonly observedScreenshotRefs: readonly string[];
  readonly screenshotRefs: readonly string[];
}): Record<string, unknown> {
  const snapshot = asRecord(input.observation.snapshot);
  const selectorEvidence = asRecord(input.observation.selectorEvidence);
  const pageTransition = asRecord(input.observation.pageTransition);
  const stateOverview =
    asRecord(input.observation.stateOverview) ??
    asRecord(snapshot?.stateOverview) ??
    asRecord(selectorEvidence?.stateOverview) ??
    asRecord(input.previousState?.stateOverview);
  const candidateInventory =
    asRecord(input.observation.candidateInventory) ??
    asRecord(snapshot?.candidateInventory) ??
    asRecord(selectorEvidence?.candidateInventory) ??
    asRecord(input.previousState?.candidateInventory);
  const lastStateWindow = buildLastStateWindow(input.observation);
  const observedScreenshotRef = input.observedScreenshotRefs[0] ?? null;
  const previousScreenshotRef =
    asNonEmptyString(input.previousState?.screenshotRef) ??
    input.screenshotRefs[input.screenshotRefs.length - 1] ??
    null;
  const hasCurrentDomState =
    Boolean(snapshot) ||
    Boolean(selectorEvidence) ||
    readString(input.observation, 'mode') === 'snapshot';
  const screenshotRef = observedScreenshotRef ?? previousScreenshotRef;
  const visualFreshness = observedScreenshotRef
    ? 'current'
    : hasCurrentDomState
      ? previousScreenshotRef
        ? 'previous'
        : 'missing'
      : previousScreenshotRef
        ? 'previous'
        : 'missing';
  const openSurfaces = collectOpenBrowserSurfaces(input.observation);
  const blockingOverlay =
    openSurfaces[0] ?? buildPointerInterceptOverlay(input.observation) ?? null;
  const actionCandidates = collectBrowserActionCandidates(input.observation);
  return compactRecord({
    step: input.step,
    toolName: input.toolName,
    url:
      readString(input.observation, 'currentUrl') ??
      readString(input.observation, 'url') ??
      readString(snapshot, 'url') ??
      readString(input.previousState, 'url'),
    title:
      readString(input.observation, 'title') ??
      readString(snapshot, 'title') ??
      readString(input.previousState, 'title'),
    snapshotId:
      readString(input.observation, 'snapshotId') ??
      readString(snapshot, 'snapshotId') ??
      readString(input.previousState, 'snapshotId'),
    stateRef:
      readString(input.observation, 'stateRef') ??
      readString(snapshot, 'stateRef') ??
      readString(selectorEvidence, 'stateRef') ??
      readString(input.previousState, 'stateRef'),
    screenshotRef,
    visualFreshness,
    openSurfaces,
    activeSurface: openSurfaces[0] ?? null,
    blockingOverlay,
    selectedAction: asRecord(pageTransition?.selectedAction) ?? null,
    stateOverview,
    candidateInventory,
    lastStateWindow:
      lastStateWindow ?? asRecord(input.previousState?.lastStateWindow) ?? null,
    actionCandidates,
    lastActionResult: compactRecord({
      status: readString(input.observation, 'status'),
      error: readString(input.observation, 'error'),
      mode: readString(input.observation, 'mode'),
      pageTransition: pageTransition
        ? compactRecord({
            outcome:
              readString(pageTransition, 'outcome') ??
              readString(pageTransition, 'status'),
            reason: readString(pageTransition, 'reason'),
          })
        : null,
    }),
  });
}

function buildLastStateWindow(
  observation: Record<string, unknown>,
): Record<string, unknown> | null {
  const mode = readString(observation, 'mode');
  if (!mode || !mode.startsWith('state_')) return null;
  const rowWindow = asRecord(observation.rowWindow);
  return compactRecord({
    mode,
    snapshotId: readString(observation, 'snapshotId'),
    stateRef: readString(observation, 'stateRef'),
    family: readString(observation, 'family'),
    query: readString(observation, 'query'),
    tableId:
      readString(asRecord(observation.table), 'tableId') ??
      readString(observation, 'tableId'),
    status: readString(observation, 'status'),
    totalCount:
      readNumber(observation, 'totalCount') ??
      readNumber(rowWindow, 'totalCount'),
    returnedCount:
      readNumber(observation, 'returnedCount') ??
      readNumber(rowWindow, 'returnedCount'),
    nextCursor:
      readString(observation, 'nextCursor') ??
      readString(rowWindow, 'nextCursor'),
    hasMore:
      typeof observation.hasMore === 'boolean'
        ? observation.hasMore
        : typeof rowWindow?.hasMore === 'boolean'
          ? rowWindow.hasMore
          : null,
  });
}

function collectBrowserActionCandidates(
  observation: Record<string, unknown>,
): Record<string, unknown>[] {
  const snapshot = asRecord(observation.snapshot);
  const candidates: Record<string, unknown>[] = [];
  const push = (candidate: Record<string, unknown>): void => {
    const compacted = compactRecord(candidate);
    const key = JSON.stringify([
      compacted.type,
      compacted.selector,
      compacted.ref,
      compacted.text,
      compacted.onclick,
      compacted.ngClick,
      compacted.tableIndex,
      compacted.rowIndex,
    ]);
    if (
      candidates.some(
        (entry) =>
          JSON.stringify([
            entry.type,
            entry.selector,
            entry.ref,
            entry.text,
            entry.onclick,
            entry.ngClick,
            entry.tableIndex,
            entry.rowIndex,
          ]) === key,
      )
    )
      return;
    candidates.push(compacted);
  };

  for (const windowItem of readRecordArray(observation.items).slice(0, 80)) {
    const item = asRecord(windowItem.item) ?? windowItem;
    const signal = [
      readString(windowItem, 'family'),
      candidateText(item),
      readString(item, 'selector'),
      readString(item, 'onclick'),
      readString(item, 'ngClick'),
      readString(item, 'className'),
      readString(item, 'href'),
    ]
      .filter(Boolean)
      .join(' ');
    push({
      type: isDocumentSignal(signal)
        ? 'document_action'
        : isPaginationSignal(signal)
          ? 'pagination_action'
          : /\b(view|detail|preview|open|more|tender)\b/i.test(signal)
            ? 'detail_action'
            : /\b(search|submit|apply|captcha|filter)\b/i.test(signal)
              ? 'form_action'
              : (readString(windowItem, 'family') ?? 'state_item'),
      family: readString(windowItem, 'family'),
      elementId:
        readString(item, 'elementId') ?? readString(windowItem, 'elementId'),
      ref: readString(item, 'ref') ?? readString(windowItem, 'ref'),
      snapshotId:
        readString(item, 'snapshotId') ??
        readString(observation, 'snapshotId') ??
        readString(snapshot, 'snapshotId'),
      selector:
        readString(item, 'selector') ?? readString(windowItem, 'selector'),
      text: candidateText(item),
      href: readString(item, 'href'),
      onclick: readString(item, 'onclick'),
      ngClick: readString(item, 'ngClick'),
      className: readString(item, 'className'),
    });
  }

  for (const table of readRecordArray(snapshot?.tables).slice(0, 6)) {
    const tableIndex = readNumberLike(table.tableIndex);
    const headers = readStringArray(table.headers).slice(0, 8);
    const rows = readRecordArray(table.rows).slice(0, 4);
    if (rows.length > 0) {
      push({
        type: 'table_rows',
        selector:
          typeof tableIndex === 'number'
            ? `table:nth-of-type(${tableIndex + 1}) tbody tr`
            : null,
        tableIndex,
        rowCount: rows.length,
        headers,
        samples: rows.map((row) =>
          readStringArray(row.cells).join(' | ').slice(0, 320),
        ),
      });
    }
    for (const row of rows) {
      const rowIndex = readNumberLike(row.rowIndex);
      const rowText = readStringArray(row.cells).join(' | ').slice(0, 320);
      for (const action of readRecordArray(row.actionRefs).slice(0, 8)) {
        const actionText = candidateText(action);
        const signal = `${actionText ?? ''} ${readString(action, 'selector') ?? ''} ${readString(action, 'onclick') ?? ''} ${readString(action, 'ngClick') ?? ''} ${readString(action, 'className') ?? ''}`;
        if (
          !/\b(view|detail|preview|open|tender|download|document|nit|boq|corrigendum|more)\b/i.test(
            signal,
          )
        )
          continue;
        push({
          type: /download|document|nit|boq|corrigendum/i.test(signal)
            ? 'document_action'
            : 'row_detail_action',
          tableIndex,
          rowIndex,
          rowText,
          ref: readString(action, 'ref'),
          snapshotId:
            readString(action, 'snapshotId') ??
            readString(snapshot, 'snapshotId'),
          selector: readString(action, 'selector'),
          text: actionText,
          onclick: readString(action, 'onclick'),
          ngClick: readString(action, 'ngClick'),
          className: readString(action, 'className'),
        });
      }
    }
  }

  for (const control of readRecordArray(snapshot?.interactive).slice(0, 80)) {
    const text = candidateText(control);
    const signal = [
      text,
      readString(control, 'ariaLabel'),
      readString(control, 'name'),
      readString(control, 'id'),
      readString(control, 'className'),
      readString(control, 'href'),
      readString(control, 'onclick'),
      readString(control, 'ngClick'),
      readString(control, 'value'),
      readString(control, 'title'),
      readString(control, 'selector'),
    ]
      .filter(Boolean)
      .join(' ');
    const base = {
      ref: readString(control, 'ref'),
      snapshotId:
        readString(control, 'snapshotId') ?? readString(snapshot, 'snapshotId'),
      selector: readString(control, 'selector'),
      text,
      label: readString(control, 'ariaLabel') ?? readString(control, 'title'),
      href: readString(control, 'href'),
      onclick: readString(control, 'onclick'),
      ngClick: readString(control, 'ngClick'),
      className: readString(control, 'className'),
    };
    if (isPaginationSignal(signal))
      push({ type: 'pagination_action', ...base });
    else if (
      /\b(search|submit|apply|go|show|list|captcha|security code|verification code)\b/i.test(
        signal,
      )
    ) {
      push({ type: 'form_action', ...base });
    } else if (isDocumentSignal(signal))
      push({ type: 'document_action', ...base });
    else if (/\b(view|detail|preview|open|tender)\b/i.test(signal)) {
      push({ type: 'detail_action', ...base });
    }
  }

  for (const control of readRecordArray(snapshot?.documentControls).slice(
    0,
    12,
  )) {
    push({
      type: 'document_action',
      ref: readString(control, 'ref'),
      snapshotId:
        readString(control, 'snapshotId') ?? readString(snapshot, 'snapshotId'),
      selector: readString(control, 'selector'),
      text: candidateText(control),
      href: readString(control, 'href'),
      onclick: readString(control, 'onclick'),
      ngClick: readString(control, 'ngClick'),
      className: readString(control, 'className'),
    });
  }

  for (const form of readRecordArray(snapshot?.forms).slice(0, 6)) {
    push({
      type: 'form',
      formIndex: readNumberLike(form.formIndex),
      action: readString(form, 'action'),
      method: readString(form, 'method'),
      fields: readRecordArray(form.fields)
        .slice(0, 12)
        .map((field) =>
          compactRecord({
            tag: readString(field, 'tag'),
            name: readString(field, 'name'),
            id: readString(field, 'id'),
            type: readString(field, 'type'),
            placeholder: readString(field, 'placeholder'),
            label: readString(field, 'label'),
          }),
        ),
    });
  }

  for (const modal of readRecordArray(snapshot?.modals).slice(0, 4)) {
    for (const action of readRecordArray(modal.actions).slice(0, 8)) {
      push({
        type: 'modal_action',
        modalSelector: readString(modal, 'selector'),
        modalText: readString(modal, 'text')?.slice(0, 320),
        ref: readString(action, 'ref'),
        snapshotId:
          readString(action, 'snapshotId') ??
          readString(snapshot, 'snapshotId'),
        selector: readString(action, 'selector'),
        text: candidateText(action),
        onclick: readString(action, 'onclick'),
        ngClick: readString(action, 'ngClick'),
        className: readString(action, 'className'),
      });
    }
  }

  return candidates
    .sort(
      (left, right) => scoreActionCandidate(right) - scoreActionCandidate(left),
    )
    .slice(0, 24);
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const record = asRecord(entry);
        return record ? [record] : [];
      })
    : [];
}

function candidateText(value: Record<string, unknown>): string | null {
  return (
    readString(value, 'text') ??
    readString(value, 'label') ??
    readString(value, 'ariaLabel') ??
    readString(value, 'title') ??
    readString(value, 'value')
  );
}

function isPaginationSignal(value: string): boolean {
  return /\b(next|previous|prev|pagination|page|more|load more|show more|view more|more tenders|load more tenders|clickForMoreTender|nextPage|gotoPage|loadMore|fetchMore)\b|^>$|^>>$|(?:^|\s)[1-9](?:\s|$)|\.\.\./i.test(
    value,
  );
}

function isDocumentSignal(value: string): boolean {
  return (
    /\b(document|download|pdf|nit|boq|corrigendum|attachment|file|downloadFile|fa-download)\b/i.test(
      value,
    ) &&
    !/\b(manual|faq|help|pki|dsc|signature|vendor registration|how to start|system requirement)\b/i.test(
      value,
    )
  );
}

function scoreActionCandidate(value: Record<string, unknown>): number {
  const type = readString(value, 'type') ?? '';
  const signal = Object.values(value)
    .filter((entry) => typeof entry === 'string')
    .join(' ');
  let score = 0;
  if (type.includes('document')) score += 80;
  if (type.includes('pagination')) score += 70;
  if (type.includes('row_detail') || type.includes('detail')) score += 60;
  if (type.includes('form')) score += 45;
  if (type === 'table_rows') score += 40;
  if (readString(value, 'ref')) score += 8;
  if (readString(value, 'selector')) score += 6;
  if (/captcha|search|submit|apply/i.test(signal)) score += 12;
  if (/download|document|nit|boq|corrigendum/i.test(signal)) score += 16;
  if (/next|more|page|clickForMoreTender|gotoPage/i.test(signal)) score += 16;
  return score;
}

function readNumberLike(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collectOpenBrowserSurfaces(value: unknown): Record<string, unknown>[] {
  const surfaces: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (entry: unknown, depth: number): void => {
    if (entry === null || entry === undefined || depth > 7 || seen.has(entry))
      return;
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    const record = asRecord(entry);
    if (!record) return;
    seen.add(record);
    const role = readString(record, 'role');
    const selector = readString(record, 'selector');
    const id = readString(record, 'id');
    const className =
      readString(record, 'className') ?? readString(record, 'class');
    const open =
      record.open === true || readString(record, 'ariaHidden') === 'false';
    const modalLike = /modal|dialog|overlay|backdrop/i.test(
      [role, selector, id, className].filter(Boolean).join(' '),
    );
    if (open && modalLike) {
      surfaces.push(
        compactRecord({
          type: /dialog/i.test(role ?? '') ? 'dialog' : 'modal',
          selector,
          id,
          role,
          text: readString(record, 'text'),
          actionCount: Array.isArray(record.actions)
            ? record.actions.length
            : null,
          documentControlCount: Array.isArray(record.documentControls)
            ? record.documentControls.length
            : null,
        }),
      );
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(value, 0);
  return surfaces.slice(0, 8);
}

function buildPointerInterceptOverlay(
  observation: Record<string, unknown>,
): Record<string, unknown> | null {
  const error = readString(observation, 'error');
  if (!error || !/intercepts pointer events/i.test(error)) return null;
  const selector = /<[^>]+\s(?:id|class)="([^"]+)"/i.exec(error)?.[1] ?? null;
  return compactRecord({
    type: 'blocking_overlay',
    selector: selector
      ? error.includes('id=')
        ? `#${selector}`
        : `.${selector.split(/\s+/)[0]}`
      : null,
    text: error.slice(0, 800),
    reason: 'pointer_events_intercepted',
  });
}

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry === null || entry === undefined) return false;
      if (Array.isArray(entry) && entry.length === 0) return false;
      return true;
    }),
  );
}

function collectBrowserGatewayScreenshotRefs(
  observation: Record<string, unknown>,
): readonly string[] {
  const refs: string[] = [];
  const directRef = asNonEmptyString(observation.screenshotRef);
  if (directRef) refs.push(directRef);
  const screenshot = asRecord(observation.screenshot);
  const localPath =
    asNonEmptyString(screenshot?.localPath) ??
    asNonEmptyString(screenshot?.path);
  if (localPath)
    refs.push(
      localPath.startsWith('browser-screenshot:')
        ? localPath
        : `browser-screenshot:file:${localPath}`,
    );
  const artifacts = Array.isArray(observation.artifacts)
    ? observation.artifacts
    : [];
  for (const artifact of artifacts) {
    const record = asRecord(artifact);
    const path =
      asNonEmptyString(record?.localPath) ?? asNonEmptyString(record?.path);
    if (path)
      refs.push(
        path.startsWith('browser-screenshot:')
          ? path
          : `browser-screenshot:file:${path}`,
      );
  }
  return Array.from(new Set(refs));
}
