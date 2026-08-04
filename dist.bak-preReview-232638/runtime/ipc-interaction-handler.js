import fs from 'fs';
import path from 'path';
import { signIpcResponsePayload } from '../infrastructure/ipc/response-signing.js';
import { ensurePrivateDirSync, protectOwnerReadonlyFileSync, writePrivateFileSync, } from '../shared/private-fs.js';
import { buildPermissionResponseSignaturePayload } from '../shared/ipc-signing.js';
export async function processPermissionIpcRequest(request, deps) {
    return deps.requestPermissionApproval(request);
}
export async function processUserQuestionIpcRequest(request, deps) {
    return deps.requestUserAnswer(request);
}
function toTrimmedString(value, opts = {}) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!trimmed)
        return undefined;
    if (opts.maxLen && trimmed.length > opts.maxLen)
        return undefined;
    return trimmed;
}
function protectTerminalResponseFile(filePath) {
    try {
        protectOwnerReadonlyFileSync(filePath);
    }
    catch {
        // Best effort hardening only.
    }
}
function withSignature(privateKeyPem, payload) {
    const signature = signIpcResponsePayload(privateKeyPem, payload);
    if (!signature)
        return null;
    return { ...payload, signature };
}
export function writePermissionIpcResponse(ipcBaseDir, sourceAgentFolder, decision, privateKeyPem) {
    const responseDir = path.join(ipcBaseDir, sourceAgentFolder, 'permission-responses');
    ensurePrivateDirSync(responseDir);
    const responsePath = path.join(responseDir, `${decision.requestId}.json`);
    if (fs.existsSync(responsePath))
        return;
    const tmpPath = `${responsePath}.tmp`;
    const payload = withSignature(privateKeyPem, buildPermissionResponseSignaturePayload(decision));
    if (!payload)
        return;
    writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
    if (fs.existsSync(responsePath)) {
        fs.rmSync(tmpPath, { force: true });
        return;
    }
    fs.renameSync(tmpPath, responsePath);
    protectTerminalResponseFile(responsePath);
}
export function writeUserQuestionIpcResponse(ipcBaseDir, sourceAgentFolder, response, privateKeyPem) {
    const responseDir = path.join(ipcBaseDir, sourceAgentFolder, 'user-answers');
    ensurePrivateDirSync(responseDir);
    const responsePath = path.join(responseDir, `${response.requestId}.json`);
    if (fs.existsSync(responsePath))
        return;
    const tmpPath = `${responsePath}.tmp`;
    const safeAnswers = {};
    for (const [key, value] of Object.entries(response.answers || {})) {
        const safeKey = toTrimmedString(key, { maxLen: 500 });
        if (!safeKey)
            continue;
        if (typeof value === 'string') {
            safeAnswers[safeKey] = value.slice(0, 500);
            continue;
        }
        if (Array.isArray(value)) {
            const filtered = value
                .filter((entry) => typeof entry === 'string')
                .map((entry) => entry.slice(0, 200))
                .slice(0, 20);
            safeAnswers[safeKey] = filtered;
        }
    }
    const payload = withSignature(privateKeyPem, {
        requestId: response.requestId,
        answers: safeAnswers,
        ...(response.answeredBy ? { answeredBy: response.answeredBy } : {}),
    });
    if (!payload)
        return;
    writePrivateFileSync(tmpPath, JSON.stringify(payload, null, 2));
    if (fs.existsSync(responsePath)) {
        fs.rmSync(tmpPath, { force: true });
        return;
    }
    fs.renameSync(tmpPath, responsePath);
    protectTerminalResponseFile(responsePath);
}
