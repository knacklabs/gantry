import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  authorizeControlRequest,
  type ControlRouteContext,
} from '../handler-context.js';
import {
  readJson,
  readRawBody,
  sendApplicationError,
  sendError,
  sendJson,
} from '../http.js';
import {
  createExternalIngressModule,
  invokeExternalIngressForControl,
} from '../external-ingress-adapter.js';

const MAX_INGRESS_BODY_BYTES = 256 * 1024;

export async function handleExternalIngressRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ControlRouteContext,
  pathname: string,
): Promise<boolean> {
  if (pathname === '/v1/ingresses' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    try {
      const created = await createExternalIngressModule(ctx).create({
        appId: auth.appId,
        name: String(body.name || ''),
        enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
        metadata: body.metadata,
      });
      sendJson(res, 201, created);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (pathname === '/v1/ingresses' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:read',
    ]);
    if (!auth) return true;
    sendJson(res, 200, await createExternalIngressModule(ctx).list(auth.appId));
    return true;
  }

  const route = parseIngressRoute(pathname);
  if (!route) return false;

  if (route.action === 'get' && req.method === 'GET') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:read',
    ]);
    if (!auth) return true;
    try {
      sendJson(
        res,
        200,
        await createExternalIngressModule(ctx).get({
          appId: auth.appId,
          ingressId: route.ingressId,
        }),
      );
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (route.action === 'get' && req.method === 'PATCH') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:write',
    ]);
    if (!auth) return true;
    const body = (await readJson(req)) as Record<string, unknown>;
    const patch = {
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
    };
    if (Object.keys(patch).length === 0) {
      sendError(
        res,
        400,
        'INVALID_REQUEST',
        'PATCH body must include name, enabled, or metadata',
      );
      return true;
    }
    try {
      sendJson(
        res,
        200,
        await createExternalIngressModule(ctx).update({
          appId: auth.appId,
          ingressId: route.ingressId,
          patch,
        }),
      );
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (route.action === 'get' && req.method === 'DELETE') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:write',
    ]);
    if (!auth) return true;
    try {
      await createExternalIngressModule(ctx).delete({
        appId: auth.appId,
        ingressId: route.ingressId,
      });
      sendJson(res, 200, { deleted: true });
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (route.action === 'rotate' && req.method === 'POST') {
    const auth = authorizeControlRequest(req, res, ctx.keys, [
      'ingresses:write',
    ]);
    if (!auth) return true;
    try {
      sendJson(
        res,
        200,
        await createExternalIngressModule(ctx).rotate({
          appId: auth.appId,
          ingressId: route.ingressId,
        }),
      );
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (route.action === 'invoke' && req.method === 'POST') {
    const headers = readSignatureHeaders(req, res);
    if (!headers) return true;
    const rawBody = await readIngressRawBody(req, res);
    if (rawBody === null) return true;
    try {
      const result = await invokeExternalIngressForControl(ctx, {
        ingressId: route.ingressId,
        method: req.method,
        path: pathname,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        signature: headers.signature,
        rawBody,
      });
      sendJson(res, 202, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  if (route.action === 'wait' && req.method === 'POST') {
    const headers = readSignatureHeaders(req, res);
    if (!headers) return true;
    const rawBody = await readIngressRawBody(req, res);
    if (rawBody === null) return true;
    try {
      const result = await createExternalIngressModule(ctx).signedWait({
        ingressId: route.ingressId,
        method: req.method,
        path: pathname,
        timestamp: headers.timestamp,
        nonce: headers.nonce,
        signature: headers.signature,
        rawBody,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (!sendApplicationError(res, error)) throw error;
    }
    return true;
  }

  return false;
}

async function readIngressRawBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<string | null> {
  try {
    return (await readRawBody(req, MAX_INGRESS_BODY_BYTES)).toString('utf8');
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 413
    ) {
      sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Payload too large');
      return null;
    }
    throw error;
  }
}

function parseIngressRoute(pathname: string): {
  ingressId: string;
  action: 'get' | 'rotate' | 'invoke' | 'wait';
} | null {
  const webhookAliasMatch = /^\/webhooks\/([^/]+)(?:\/(wait))?$/.exec(pathname);
  if (webhookAliasMatch) {
    return {
      ingressId: decodeURIComponent(webhookAliasMatch[1]!),
      action: webhookAliasMatch[2] === 'wait' ? 'wait' : 'invoke',
    };
  }
  const actionMatch = /^\/v1\/ingresses\/([^/]+)\/(rotate|invoke|wait)$/.exec(
    pathname,
  );
  if (actionMatch) {
    return {
      ingressId: decodeURIComponent(actionMatch[1]!),
      action: actionMatch[2] as 'rotate' | 'invoke' | 'wait',
    };
  }
  const baseMatch = /^\/v1\/ingresses\/([^/]+)$/.exec(pathname);
  if (!baseMatch) return null;
  return { ingressId: decodeURIComponent(baseMatch[1]!), action: 'get' };
}

function readSignatureHeaders(
  req: IncomingMessage,
  res: ServerResponse,
): { timestamp: string; nonce: string; signature: string } | null {
  const timestamp = header(req, 'x-gantry-ingress-timestamp');
  const nonce = header(req, 'x-gantry-ingress-nonce');
  const signature = header(req, 'x-gantry-ingress-signature');
  const missing = [
    ['x-gantry-ingress-timestamp', timestamp],
    ['x-gantry-ingress-nonce', nonce],
    ['x-gantry-ingress-signature', signature],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    sendError(
      res,
      400,
      'INVALID_REQUEST',
      `Missing required ingress signature header: ${missing.join(', ')}`,
    );
    return null;
  }
  return { timestamp, nonce, signature };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
  return raw.trim();
}
