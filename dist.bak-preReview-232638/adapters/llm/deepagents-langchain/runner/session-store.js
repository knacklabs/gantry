import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { Duplex } from 'node:stream';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
// Adapter-private session projection for live (interactive) DeepAgents turns.
// Durable provider-session ownership stays Gantry-owned (AgentSession). This
// runner uses LangGraph's official Postgres checkpointer keyed by the Gantry
// provider session id (`thread_id=sessionId`), instead of replaying transcript
// messages or maintaining a custom file-backed checkpoint implementation.
//
// Scheduled jobs are ephemeral and never touch this store. A missing checkpoint
// for a resumed live session throws MISSING_DEEPAGENTS_SESSION so the host can
// expire the stale provider session and retry fresh on the same provider.
export const MISSING_DEEPAGENTS_SESSION_MARKER = 'No DeepAgents session found with session ID';
const RUNNER_CHECKPOINT_POOL_MAX_CONNECTIONS = 1;
export class DeepAgentSessionStore {
    config;
    timing;
    constructor(config, timing) {
        this.config = config;
        this.timing = timing;
    }
    static newSessionId() {
        return randomUUID();
    }
    newSessionId() {
        return DeepAgentSessionStore.newSessionId();
    }
    async create(sessionId) {
        assertSessionId(sessionId);
        return this.openSaver();
    }
    async load(sessionId) {
        assertSessionId(sessionId);
        const saver = await this.openSaver();
        let tuple;
        try {
            tuple = await saver.getTuple({
                configurable: { thread_id: sessionId },
            });
        }
        catch (error) {
            await saver.end().catch(() => { });
            throw error;
        }
        if (!tuple) {
            await saver.end().catch(() => { });
            throw new Error(`${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId}`);
        }
        return saver;
    }
    async openSaver() {
        const databaseUrl = this.config.databaseUrl.trim();
        const schema = this.config.schema.trim();
        if (!databaseUrl || !schema) {
            throw new Error('DeepAgents runner is missing Postgres checkpointer configuration for live session persistence.');
        }
        const poolConfig = {
            connectionString: databaseUrl,
            max: RUNNER_CHECKPOINT_POOL_MAX_CONNECTIONS,
        };
        const proxyUrl = deepAgentCheckpointerProxyUrl(this.config.proxyUrl);
        if (proxyUrl) {
            // pg uses this factory instead of opening databaseUrl directly, so
            // sandboxed runners reach private Postgres only through Gantry egress.
            poolConfig.stream = () => new HttpConnectPostgresStream(proxyUrl);
        }
        const pool = new pg.Pool(poolConfig);
        return createDeepAgentCheckpointSaverFromPool(pool, schema, this.timing);
    }
}
class HttpConnectPostgresStream extends Duplex {
    socket = new net.Socket();
    proxyBuffer = Buffer.alloc(0);
    connectedToTarget = false;
    connectCallback;
    pendingWrites = [];
    constructor(proxyUrl) {
        super();
        const proxy = parseHttpProxyUrl(proxyUrl);
        this.socket.on('error', (error) => this.destroy(error));
        this.socket.on('end', () => this.push(null));
        this.socket.on('close', () => this.emit('close'));
        this.socket.once('connect', () => {
            this.socket.write([
                `CONNECT ${this.targetAuthority} HTTP/1.1`,
                `Host: ${this.targetAuthority}`,
                '',
                '',
            ].join('\r\n'));
        });
        this.proxyHost = proxy.hostname;
        this.proxyPort = Number(proxy.port || '80');
    }
    proxyHost;
    proxyPort;
    targetAuthority = '';
    connect(portOrPath, hostOrCallback, callback) {
        if (typeof portOrPath !== 'number') {
            this.destroy(new Error('Postgres proxy stream requires TCP host/port.'));
            return this;
        }
        const host = typeof hostOrCallback === 'string' ? hostOrCallback : 'localhost';
        this.connectCallback =
            typeof hostOrCallback === 'function' ? hostOrCallback : callback;
        this.targetAuthority = postgresAuthority(host, portOrPath);
        this.socket.on('data', this.handleProxyData);
        this.socket.connect(this.proxyPort, this.proxyHost);
        return this;
    }
    setNoDelay(noDelay) {
        this.socket.setNoDelay(noDelay);
        return this;
    }
    setKeepAlive(enable, initialDelay) {
        this.socket.setKeepAlive(enable, initialDelay);
        return this;
    }
    ref() {
        this.socket.ref();
        return this;
    }
    unref() {
        this.socket.unref();
        return this;
    }
    _read() {
        this.socket.resume();
    }
    _write(chunk, encoding, callback) {
        if (!this.connectedToTarget) {
            this.pendingWrites.push({
                chunk: Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding),
                callback,
            });
            return;
        }
        this.socket.write(chunk, encoding, callback);
    }
    _final(callback) {
        this.socket.end(callback);
    }
    _destroy(error, callback) {
        this.socket.destroy(error ?? undefined);
        callback(error);
    }
    handleProxyData = (chunk) => {
        this.proxyBuffer = Buffer.concat([this.proxyBuffer, chunk]);
        const headerEnd = this.proxyBuffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            if (this.proxyBuffer.length > 8192) {
                this.destroy(new Error('Postgres proxy CONNECT response is too large.'));
            }
            return;
        }
        const header = this.proxyBuffer.subarray(0, headerEnd).toString('latin1');
        const firstLine = header.split('\r\n')[0] ?? '';
        if (!/^HTTP\/1\.[01] 2\d\d(?:\s|$)/.test(firstLine)) {
            this.destroy(new Error(`Postgres proxy CONNECT failed: ${firstLine}`));
            return;
        }
        const rest = this.proxyBuffer.subarray(headerEnd + 4);
        this.proxyBuffer = Buffer.alloc(0);
        this.socket.off('data', this.handleProxyData);
        this.socket.on('data', this.forwardData);
        this.connectedToTarget = true;
        this.emit('connect');
        this.connectCallback?.();
        this.flushPendingWrites();
        if (rest.length > 0)
            this.forwardData(rest);
    };
    forwardData = (chunk) => {
        if (!this.push(chunk))
            this.socket.pause();
    };
    flushPendingWrites() {
        for (const pending of this.pendingWrites.splice(0)) {
            this.socket.write(pending.chunk, pending.callback);
        }
    }
}
function parseHttpProxyUrl(value) {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'http:' ||
        !parsed.port ||
        (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1')) {
        throw new Error('DeepAgents checkpointer proxy must be a loopback http URL.');
    }
    return parsed;
}
function deepAgentCheckpointerProxyUrl(configured) {
    const trimmed = configured?.trim();
    if (trimmed)
        return trimmed;
    if (process.env.GANTRY_SANDBOX_RUNTIME_PROXY !== '1')
        return undefined;
    return (process.env.HTTP_PROXY?.trim() ||
        process.env.HTTPS_PROXY?.trim() ||
        process.env.http_proxy?.trim() ||
        process.env.https_proxy?.trim() ||
        undefined);
}
function postgresAuthority(host, port) {
    const normalizedHost = host.replace(/^\[|\]$/g, '');
    const authorityHost = normalizedHost.includes(':')
        ? `[${normalizedHost}]`
        : normalizedHost;
    return `${authorityHost}:${port}`;
}
export function createDeepAgentCheckpointSaverFromPool(pool, schema, timing) {
    return instrumentCheckpointSaver(new PostgresSaver(pool, undefined, { schema }), timing);
}
export function isMissingDeepAgentSessionError(error) {
    return new RegExp(MISSING_DEEPAGENTS_SESSION_MARKER, 'i').test(error ?? '');
}
function assertSessionId(sessionId) {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        throw new Error(`${MISSING_DEEPAGENTS_SESSION_MARKER}: ${sessionId} (invalid id)`);
    }
}
export function createDeepAgentCheckpointTiming(input) {
    let loadCount = 0;
    let loadMs = 0;
    let maxLoadMs;
    let writeCount = 0;
    let writeMs = 0;
    let maxWriteMs;
    const elapsedSince = (since) => Math.max(0, Math.round(input.nowMs() - since));
    const record = (kind, elapsedMs) => {
        if (kind === 'load') {
            loadCount += 1;
            loadMs += elapsedMs;
            maxLoadMs = Math.max(maxLoadMs ?? 0, elapsedMs);
            return;
        }
        writeCount += 1;
        writeMs += elapsedMs;
        maxWriteMs = Math.max(maxWriteMs ?? 0, elapsedMs);
    };
    return {
        async measureLoad(work) {
            const startedAt = input.nowMs();
            try {
                return await work();
            }
            finally {
                record('load', elapsedSince(startedAt));
            }
        },
        async measureWrite(work) {
            const startedAt = input.nowMs();
            try {
                return await work();
            }
            finally {
                record('write', elapsedSince(startedAt));
            }
        },
        snapshot() {
            return {
                loadCount,
                loadMs,
                ...(maxLoadMs !== undefined ? { maxLoadMs } : {}),
                writeCount,
                writeMs,
                ...(maxWriteMs !== undefined ? { maxWriteMs } : {}),
            };
        },
    };
}
function instrumentCheckpointSaver(saver, timing) {
    if (!timing)
        return saver;
    const originalGetTuple = saver.getTuple.bind(saver);
    saver.getTuple = ((...args) => timing.measureLoad(() => originalGetTuple(...args)));
    const originalPut = saver.put.bind(saver);
    saver.put = ((...args) => timing.measureWrite(() => originalPut(...args)));
    const originalPutWrites = saver.putWrites.bind(saver);
    saver.putWrites = ((...args) => timing.measureWrite(() => originalPutWrites(...args)));
    return saver;
}
