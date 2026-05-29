import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildExternalNotificationAdaptiveCard,
  createBotFrameworkTeamsTransport,
  createFirecrawlCrawlProvider,
  createFirecrawlFetchProvider,
  createFirecrawlSearchProvider,
  createHttpFetchProvider,
  createGantryClient,
  createGantryRuntime,
  createPgGantryRuntimeStorage,
  createStructuredModelTaskRunner,
  createTavilySearchProvider,
  parseExternalCardAction,
  signExternalCardAction,
  signExternalEventRequest,
  verifyExternalCardAction,
  verifyExternalEventSignature,
  verifyWebhookSignature,
  type BotFrameworkAdapterLike,
} from "../src/index.js";

describe("@cawstudios/agent-gantry", () => {
  it("maps Tavily search responses into structured search results", async () => {
    const provider = createTavilySearchProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        results: [{ url: "https://example.gov/tenders", title: "Tenders", content: "Bid notices" }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(provider.search({ query: "karnataka tenders", limit: 1 })).resolves.toMatchObject({
      provider: "tavily",
      items: [{ url: "https://example.gov/tenders", title: "Tenders", snippet: "Bid notices" }],
    });
  });

  it("maps Firecrawl search responses into structured search results", async () => {
    const provider = createFirecrawlSearchProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{
          url: "https://example.gov/tenders",
          title: "Tenders",
          markdown: "Bid notices and procurement updates",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(provider.search({ query: "karnataka tenders", limit: 1 })).resolves.toMatchObject({
      provider: "firecrawl-search",
      items: [{ url: "https://example.gov/tenders", title: "Tenders", snippet: "Bid notices and procurement updates" }],
    });
  });

  it("fetches and summarizes HTTP pages with blocking signals", async () => {
    const provider = createHttpFetchProvider({
      fetchImpl: async () => new Response("<html><title>Portal</title><body>Please login to continue</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    });

    await expect(provider.fetch({ url: "https://example.gov" })).resolves.toMatchObject({
      title: "Portal",
      blockedReason: "login_required",
      provider: "http-fetch",
    });
  });

  it("maps Firecrawl scrape responses into structured fetch results", async () => {
    const provider = createFirecrawlFetchProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          markdown: "Public tender notices",
          metadata: { sourceURL: "https://example.gov", title: "Procurement Portal" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(provider.fetch({ url: "https://example.gov" })).resolves.toMatchObject({
      url: "https://example.gov",
      title: "Procurement Portal",
      text: "Public tender notices",
      provider: "firecrawl-scrape",
    });
  });

  it("maps Firecrawl crawl responses into structured crawl pages", async () => {
    const provider = createFirecrawlCrawlProvider({
      apiKey: "test-key",
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{
          markdown: "Tender page",
          metadata: { sourceURL: "https://example.gov/tenders", title: "Tenders" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    await expect(provider.crawl({ url: "https://example.gov", limit: 1 })).resolves.toMatchObject({
      startUrl: "https://example.gov",
      provider: "firecrawl",
      pages: [{ url: "https://example.gov/tenders", title: "Tenders", text: "Tender page" }],
    });
  });

  it("fails search provider construction clearly when the Tavily key is missing", () => {
    expect(() => createTavilySearchProvider({ apiKey: "" })).toThrow("TAVILY_API_KEY");
  });

  it("fails Firecrawl provider construction clearly when the Firecrawl key is missing", () => {
    expect(() => createFirecrawlSearchProvider({ apiKey: "" })).toThrow("FIRECRAWL_API_KEY");
    expect(() => createFirecrawlFetchProvider({ apiKey: "" })).toThrow("FIRECRAWL_API_KEY");
    expect(() => createFirecrawlCrawlProvider({ apiKey: "" })).toThrow("FIRECRAWL_API_KEY");
  });

  it("signs and verifies external event requests", () => {
    const input = {
      secret: "secret",
      method: "post",
      path: "/v1/integrations/platform-events",
      timestamp: "1000",
      nonce: "nonce",
      rawBody: "{\"ok\":true}",
    };
    const signature = signExternalEventRequest(input);
    expect(verifyExternalEventSignature({ ...input, signature, nowMs: 1000 })).toBe(true);
    expect(verifyExternalEventSignature({ ...input, signature: "bad", nowMs: 1000 })).toBe(false);
  });

  it("verifies webhook signatures", () => {
    const secret = "secret";
    const timestamp = "1000";
    const eventId = "evt_1";
    const eventType = "delivery.status";
    const rawBody = "{\"ok\":true}";
    const signature = cryptoSign(secret, `${timestamp}.${eventId}.${eventType}.${rawBody}`);
    expect(verifyWebhookSignature({ secret, timestamp, eventId, eventType, rawBody, signature, nowMs: 1000 })).toBe(true);
  });

  it("renders signed Teams submit actions for embedded notification cards", () => {
    const card = buildExternalNotificationAdaptiveCard({
      integrationId: "manipal-tender-bot",
      eventId: "outbox-1",
      actionSecret: "secret",
      nowMs: 1000,
      payload: {
        resourceId: "tender-1",
        notificationCard: {
          schemaVersion: "external.notification.card.v1",
          renderer: "gantry_adaptive_card",
          title: "Tender",
          workspace: {
            workspaceId: "workspace-1",
            workspaceName: "Workspace",
            teamsChannelId: "19:workspace",
            teamsTenantId: "tenant-1",
          },
          actions: [{
            actionType: "mark_watching",
            label: "Watch",
            presentation: "submit",
            platformOperation: "mark_resource",
          }],
        },
      },
    });

    const action = (card?.actions as Array<{ data: unknown }>)[0]?.data;
    const parsed = parseExternalCardAction(action);
    expect(parsed).toMatchObject({
      integrationId: "manipal-tender-bot",
      eventId: "outbox-1",
      resourceId: "tender-1",
      workspaceId: "workspace-1",
      sourceWorkspaceId: "workspace-1",
      sourceChannelId: "19:workspace",
      teamsTenantId: "tenant-1",
      actionType: "mark_watching",
      platformOperation: "mark_resource",
    });
    expect(parsed && verifyExternalCardAction({ action: parsed, secret: "secret", nowMs: 1000 })).toBe(true);
  });

  it("signs v2 card actions with operation and request context", () => {
    const signed = signExternalCardAction({
      secret: "secret",
      signatureVersion: "v2",
      integrationId: "manipal-tender-bot",
      eventId: "outbox-admin-1",
      requestId: "request-1",
      resourceId: "tender-1",
      workspaceId: "workspace-1",
      sourceChannelId: "19:workspace",
      teamsTenantId: "tenant-1",
      actionType: "approve_deep_analysis",
      platformOperation: "requestTenderProcessing",
      nowMs: 1000,
    });
    const action = parseExternalCardAction({
      action: "external_card_action",
      signatureVersion: signed.signatureVersion,
      integrationId: "manipal-tender-bot",
      eventId: "outbox-admin-1",
      requestId: "request-1",
      resourceId: "tender-1",
      workspaceId: "workspace-1",
      sourceWorkspaceId: "workspace-1",
      sourceChannelId: "19:workspace",
      teamsTenantId: "tenant-1",
      actionType: "approve_deep_analysis",
      platformOperation: "requestTenderProcessing",
      nonce: signed.nonce,
      expiresAt: signed.expiresAt,
      signature: signed.signature,
    });

    expect(action).toMatchObject({
      signatureVersion: "v2",
      requestId: "request-1",
      platformOperation: "requestTenderProcessing",
    });
    expect(action && verifyExternalCardAction({ action, secret: "secret", nowMs: 1000 })).toBe(true);
    expect(action && verifyExternalCardAction({
      action: { ...action, platformOperation: "declineTenderProcessingApproval" },
      secret: "secret",
      nowMs: 1000,
    })).toBe(false);
  });

  it("sends notification card requests through the external platform event route", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = createGantryClient({
      baseUrl: "http://gantry.test",
      eventSecret: "secret",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
    });

    const result = await client.notifications.sendCard({
      integrationId: "manipal-tender-bot",
      eventId: "evt_1",
      occurredAt: "2026-05-24T00:00:00.000Z",
      target: { teamsChannelId: "channel", workspaceId: "workspace" },
      payload: { resourceId: "tender" },
    });

    expect(result.statusCode).toBe(202);
    expect(calls[0]?.url).toBe("http://gantry.test/v1/integrations/platform-events");
    expect((calls[0]?.init.headers as Record<string, string>)["x-gantry-external-event-signature"]).toBeTruthy();
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      eventType: "notification.card.requested",
      target: { teamsChannelId: "channel" },
    });
  });

  it("sends Teams thread replies through the control route", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = createGantryClient({
      baseUrl: "http://gantry.test",
      apiKey: "key",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
    });

    await client.teams.sendThreadReply({
      conversationId: "conversation",
      replyToId: "message",
      text: "hello",
    });

    expect(calls[0]?.url).toBe("http://gantry.test/v1/providers/teams/thread-replies");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      conversationId: "conversation",
      replyToId: "message",
      text: "hello",
    });
  });

  it("accepts minimal Response-like fetch mocks", async () => {
    const client = createGantryClient({
      baseUrl: "http://gantry.test",
      eventSecret: "secret",
      fetchImpl: async () => ({ ok: true, status: 202 }) as Response,
    });

    await expect(client.notifications.sendEvent({
      integrationId: "manipal-tender-bot",
      eventId: "evt_1",
      eventType: "tender_processing_failed",
      occurredAt: "2026-05-24T00:00:00.000Z",
      payload: { tenderId: "tender_1" },
    })).resolves.toMatchObject({ statusCode: 202 });
  });

  it("creates an embedded runtime without a control base URL", async () => {
    const messages: unknown[] = [];
    const runtime = createGantryRuntime({
      storage: {
        recordMessage: (input) => messages.push(input),
      },
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
      tasks: {
        runStructuredTask: async () => ({
          status: "completed",
          output: { ok: true },
        }),
      },
    });

    await expect(runtime.teams.sendCard({
      conversationId: "conversation",
      card: { type: "AdaptiveCard" },
    })).resolves.toMatchObject({ statusCode: 202 });
    await expect(runtime.tasks.runStructuredTask({
      taskType: "test",
      instructions: "return ok",
      input: {},
    })).resolves.toMatchObject({ output: { ok: true } });
    await expect(runtime.teams.handleIncomingActivity({
      activity: {
        type: "message",
        id: "message",
        text: "hello",
        conversation: { id: "conversation" },
        from: { aadObjectId: "user", name: "User" },
        channelData: { tenant: { id: "tenant" } },
      },
    })).resolves.toMatchObject({
      messageId: "message",
      conversationId: "conversation",
      teamsUserId: "user",
    });
    expect(messages).toHaveLength(1);
  });

  it("normalizes Teams message.value card submits without requiring invoke activities", async () => {
    const actionValue = { action: "external_card_action", eventId: "outbox-1" };
    const runtime = createGantryRuntime({
      teams: {
        sendCard: () => ({ accepted: true, statusCode: 202 }),
        sendDm: () => ({ accepted: true, statusCode: 202 }),
        sendThreadReply: () => ({ accepted: true, statusCode: 202 }),
      },
    });

    await expect(runtime.teams.handleIncomingActivity({
      activity: {
        type: "message",
        id: "message-action-1",
        value: actionValue,
        conversation: { id: "19:workspace" },
        from: { aadObjectId: "teams-user-1" },
        channelData: { tenant: { id: "tenant-1" } },
      },
    })).resolves.toMatchObject({
      type: "message",
      messageId: "message-action-1",
      conversationId: "19:workspace",
      value: actionValue,
      teamsTenantId: "tenant-1",
      teamsUserId: "teams-user-1",
    });
  });

  it("sends Teams cards through embedded Bot Framework transport", async () => {
    const sent: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (_reference, logic) => {
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: "teams-message-1" };
          },
        } as never);
      },
    };
    const storage = {
      getTeamsConversationReference: () => ({
        exists: true,
        conversationId: "conversation",
        conversationJid: "teams:conversation",
        serviceUrl: "https://smba.trafficmanager.net/emea/",
        rawReferenceJson: JSON.stringify({
          serviceUrl: "https://smba.trafficmanager.net/emea/",
          conversation: { id: "conversation" },
        }),
      }),
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: "bot",
      botAppPassword: "secret",
      storage,
      adapter,
    });

    await expect(transport.sendCard({
      conversationId: "conversation",
      card: { type: "AdaptiveCard" },
    })).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(sent).toHaveLength(1);
  });

  it("sends Teams thread replies with a thread-scoped conversation reference", async () => {
    const sent: unknown[] = [];
    const references: unknown[] = [];
    const adapter: BotFrameworkAdapterLike = {
      processActivity: async () => undefined,
      continueConversation: async (reference, logic) => {
        references.push(reference);
        await logic({
          sendActivity: async (activity: unknown) => {
            sent.push(activity);
            return { id: "teams-reply-1" };
          },
        } as never);
      },
    };
    const lookedUp: string[] = [];
    const storage = {
      getTeamsConversationReference: (conversationId: string) => {
        lookedUp.push(conversationId);
        return {
          exists: true,
          conversationId,
          conversationJid: `teams:${conversationId}`,
          serviceUrl: "https://smba.trafficmanager.net/emea/",
          rawReferenceJson: JSON.stringify({
            serviceUrl: "https://smba.trafficmanager.net/emea/",
            conversation: { id: conversationId },
          }),
        };
      },
    };
    const transport = createBotFrameworkTeamsTransport({
      botAppId: "bot",
      botAppPassword: "secret",
      storage,
      adapter,
    });

    await expect(transport.sendThreadReply({
      conversationId: "19:channel",
      replyToId: "parent-message",
      text: "hello",
    })).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    await expect(transport.sendThreadReply({
      conversationId: "19:channel;messageid=parent-message",
      replyToId: "parent-message",
      text: "again",
    })).resolves.toMatchObject({ accepted: true, statusCode: 202 });

    expect(lookedUp).toEqual(["19:channel", "19:channel"]);
    expect(references).toEqual([
      expect.objectContaining({ conversation: { id: "19:channel;messageid=parent-message" } }),
      expect.objectContaining({ conversation: { id: "19:channel;messageid=parent-message" } }),
    ]);
    expect(sent).toEqual([
      expect.objectContaining({ replyToId: "parent-message", text: "hello" }),
      expect.objectContaining({ replyToId: "parent-message", text: "again" }),
    ]);
  });

  it("returns a stable missing-reference result for Teams DMs", async () => {
    const transport = createBotFrameworkTeamsTransport({
      botAppId: "bot",
      botAppPassword: "secret",
      storage: {},
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => undefined,
      },
    });

    await expect(transport.sendDm({
      teamsUserId: "user",
      text: "hello",
    })).resolves.toMatchObject({
      accepted: false,
      statusCode: 409,
      body: { code: "teams_personal_conversation_reference_missing" },
    });
  });

  it("creates a personal Teams conversation when only a channel reference is known", async () => {
    const sent: string[] = [];
    let createdConversation = false;
    const transport = createBotFrameworkTeamsTransport({
      botAppId: "bot",
      botAppPassword: "secret",
      storage: {
        getTeamsPersonalConversationReference: () => ({
          exists: true,
          conversationId: "19:channel-thread",
          conversationJid: "teams:19:channel-thread",
          serviceUrl: "https://smba.test/",
          tenantId: "tenant-1",
          teamsUserId: "user-1",
          rawReferenceJson: JSON.stringify({
            serviceUrl: "https://smba.test/",
            user: { id: "29:user", aadObjectId: "user-1" },
            bot: { id: "28:bot" },
            conversation: {
              id: "19:channel-thread",
              conversationType: "channel",
              isGroup: true,
              tenantId: "tenant-1",
            },
          }),
        }),
      },
      adapter: {
        processActivity: async () => undefined,
        continueConversation: async () => {
          throw new Error("should create a personal conversation first");
        },
        createConversation: async (_reference: unknown, parameters: { readonly isGroup?: boolean }, logic: (context: { sendActivity(activity: { text?: string }): Promise<{ id: string }> }) => Promise<void>) => {
          createdConversation = parameters.isGroup === false;
          await logic({
            sendActivity: async (activity) => {
              sent.push(activity.text ?? "");
              return { id: "dm-message-1" };
            },
          });
        },
      },
    });

    await expect(transport.sendDm({
      teamsUserId: "user-1",
      teamsTenantId: "tenant-1",
      text: "hello",
    })).resolves.toMatchObject({ accepted: true, statusCode: 202 });
    expect(createdConversation).toBe(true);
    expect(sent).toEqual(["hello"]);
  });

  it("creates pg-backed runtime storage using the Gantry schema", async () => {
    const calls: unknown[][] = [];
    const storage = createPgGantryRuntimeStorage({
      pool: {
        query: async (...args: unknown[]) => {
          calls.push(args);
          return { rows: [] };
        },
      },
    });

    await storage.recordMessage?.({
      provider: "teams",
      conversationId: "conversation",
      messageId: "message",
      occurredAt: "2026-05-25T00:00:00.000Z",
    });
    expect(String(calls[0]?.[0])).toContain('"gantry_runtime"."runtime_messages"');
  });

  it("runs structured model tasks and records audit state", async () => {
    const audits: unknown[] = [];
    const runner = createStructuredModelTaskRunner({
      model: {
        generateJson: async () => ({
          recipeSnapshotJson: { steps: [] },
          validationReportJson: { valid: true },
        }),
      },
      storage: {
        recordStructuredTaskRun: (input) => audits.push(input),
      },
    });

    await expect(runner.runStructuredTask({
      taskType: "recipe",
      instructions: "return a recipe",
      input: { websiteId: "website" },
      correlationId: "website",
    })).resolves.toMatchObject({
      status: "completed",
      output: { recipeSnapshotJson: { steps: [] } },
    });
    expect(audits).toHaveLength(1);
  });
});

function cryptoSign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
