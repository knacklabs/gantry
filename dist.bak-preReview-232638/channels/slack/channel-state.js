import path from 'path';
import { logger } from '../../infrastructure/logging/logger.js';
import { createInboundAttachmentStorageRef } from '../../shared/inbound-attachment-writer.js';
import { ensurePrivateDirSync } from '../../shared/private-fs.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import { resolveWorkspaceFolderPath } from '../../platform/workspace-folder.js';
import { StreamResetEpochs } from '../stream-reset-epochs.js';
import { hydrateSlackConversationContext } from './conversation-context.js';
import { encodeSlackActionValue, formatSlackUserQuestionBody, formatSlackUserQuestionPromptText, parseSlackUserQuestionActionValue, truncateSlackButtonText, truncateSlackText, } from './channel-user-question-utils.js';
import { tryNativeStreamAppend, tryNativeStreamStart, tryNativeStreamStop, } from './native-stream.js';
import { writeSlackAttachmentResponse } from './attachment-download.js';
import { cancelMatchingPendingQuestions, } from '../interaction-settlement.js';
export class SlackChannelState {
    name = 'slack';
    app = null;
    botToken;
    appToken;
    opts;
    botUserId = null;
    userNameCache = new Map();
    channelNameCache = new Map();
    activeStreams = new Map();
    streamResetEpochs = new StreamResetEpochs();
    streamGenerationByJid = new Map();
    sealedStreamGenerationByJid = new Map();
    activeProgress = new Map();
    sealedProgressGenerationByKey = new Map();
    progressStateLoaded = false;
    pendingPermissionPrompts = new Map();
    pendingUserQuestions = new Map();
    pendingTodos = new Map();
    pendingRichForms = new Map();
    dropPendingInteraction(kind, request) {
        if (kind === 'permission') {
            for (const [providerAlias, pending] of this.pendingPermissionPrompts) {
                if (pending.request.requestId !== request.requestId ||
                    pending.sourceAgentFolder !== request.sourceAgentFolder ||
                    (pending.request.appId || 'default') !== (request.appId || 'default')) {
                    continue;
                }
                pending.settled = true;
                clearTimeout(pending.timer);
                this.pendingPermissionPrompts.delete(providerAlias);
            }
            return;
        }
        for (const [key, pending] of this.pendingUserQuestions) {
            if (pending.requestId !== request.requestId ||
                pending.sourceAgentFolder !== request.sourceAgentFolder ||
                pending.callback.scope.appId !== (request.appId || 'default')) {
                continue;
            }
            pending.settled = true;
            if (pending.timer)
                clearTimeout(pending.timer);
            this.pendingUserQuestions.delete(key);
        }
    }
    async cancelPendingQuestion(cancellation) {
        return cancelMatchingPendingQuestions({
            cancellation,
            pending: this.pendingUserQuestions.values(),
            request: (pending) => ({
                requestId: pending.requestId,
                sourceAgentFolder: pending.sourceAgentFolder,
                appId: pending.callback.scope.appId,
            }),
            settle: (pending, reason) => this.finalizeUserQuestionPrompt(pending, pending.question.multiSelect ? [] : '', undefined, reason),
        });
    }
    constructor(botToken, appToken, opts) {
        this.botToken = botToken;
        this.appToken = appToken;
        this.opts = opts;
    }
    streamKey(jid, threadId) {
        return `${jid}:${threadId || ''}`;
    }
    progressKey(jid, threadId) {
        return `progress:${this.streamKey(jid, threadId)}`;
    }
    shouldAcceptProgressUpdate(key, generation, done) {
        if (done || generation === undefined)
            return true;
        const sealed = this.sealedProgressGenerationByKey.get(key);
        return sealed === undefined || generation > sealed;
    }
    markProgressGenerationDone(key, generation) {
        if (generation === undefined)
            return;
        const sealed = this.sealedProgressGenerationByKey.get(key);
        if (sealed === undefined || generation > sealed) {
            this.sealedProgressGenerationByKey.set(key, generation);
        }
    }
    pendingUserQuestionKey(callback) {
        return callback.providerAlias;
    }
    formatUserQuestionPromptText(request, question, timeoutMs) {
        return formatSlackUserQuestionPromptText(request, question, timeoutMs);
    }
    buildUserQuestionBlocks(pending) {
        const elements = pending.question.options.map((option, optionIndex) => {
            const isSelected = pending.selectedOptionIndexes.has(optionIndex);
            const prefix = pending.question.multiSelect
                ? isSelected
                    ? '[x] '
                    : '[ ] '
                : '';
            const label = truncateSlackButtonText(`${prefix}${optionIndex + 1}. ${option.label}`);
            return {
                type: 'button',
                action_id: `gantry_userq_select_${optionIndex}`,
                text: {
                    type: 'plain_text',
                    text: label,
                },
                value: encodeSlackActionValue({
                    callback: pending.callback,
                    optionIndex,
                }),
            };
        });
        if (pending.question.multiSelect) {
            elements.push({
                type: 'button',
                action_id: 'gantry_userq_done',
                text: {
                    type: 'plain_text',
                    text: truncateSlackButtonText(pending.selectedOptionIndexes.size > 0
                        ? `Done (${pending.selectedOptionIndexes.size})`
                        : 'Done'),
                },
                style: 'primary',
                value: encodeSlackActionValue({
                    callback: pending.callback,
                    done: true,
                }),
            });
        }
        elements.push({
            type: 'button',
            action_id: 'gantry_userq_other',
            text: {
                type: 'plain_text',
                text: truncateSlackButtonText('✏️ Other…'),
            },
            value: encodeSlackActionValue({
                callback: pending.callback,
            }),
        });
        return [
            {
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: truncateSlackText(`❓ ${pending.question.header}`, 150),
                    emoji: true,
                },
            },
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: formatSlackUserQuestionBody(pending.question),
                },
            },
            {
                type: 'actions',
                elements,
            },
        ];
    }
    parseUserQuestionActionValue(rawValue) {
        return parseSlackUserQuestionActionValue(rawValue);
    }
    async refreshUserQuestionPrompt(pending) {
        if (!this.app)
            return;
        try {
            await this.app.client.chat.update({
                channel: pending.channelId,
                ts: pending.messageTs,
                text: pending.promptText,
                blocks: this.buildUserQuestionBlocks(pending),
            });
        }
        catch (err) {
            logger.debug({
                requestId: pending.requestId,
                questionIndex: pending.questionIndex,
                err,
            }, 'Failed to refresh Slack user question prompt');
        }
    }
    async finalizeUserQuestionPrompt(pending, selection, answeredBy, reason) {
        if (pending.settled)
            return;
        pending.settled = true;
        const key = this.pendingUserQuestionKey(pending.callback);
        this.pendingUserQuestions.delete(key);
        if (pending.timer)
            clearTimeout(pending.timer);
        pending.resolve({ selected: selection, answeredBy });
        if (!this.app)
            return;
        const selectionText = Array.isArray(selection)
            ? selection.join(', ')
            : selection;
        const actor = answeredBy ? ` (by ${answeredBy})` : '';
        const text = selectionText
            ? `✅ ${pending.question.header} · ${selectionText}${actor}`
            : `⌛ ${pending.question.header} · ${reason || 'no answer'}`;
        try {
            await this.app.client.chat.update({
                channel: pending.channelId,
                ts: pending.messageTs,
                text,
                blocks: [
                    { type: 'context', elements: [{ type: 'mrkdwn', text }] },
                ],
            });
        }
        catch (err) {
            logger.debug({
                requestId: pending.requestId,
                questionIndex: pending.questionIndex,
                err,
            }, 'Failed to finalize Slack user question prompt');
        }
    }
    clearStreamingStateForJid(jid) {
        for (const [key, state] of this.activeStreams.entries()) {
            if (!key.startsWith(`${jid}:`))
                continue;
            if (state.nativeStreamTs) {
                void this.tryNativeStreamStop(state.channelId, state.nativeStreamTs);
            }
            this.streamResetEpochs.deleteState(key, this.activeStreams);
        }
    }
    shouldAcceptStreamingChunk(jid, generation) {
        if (generation === undefined)
            return true;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed !== undefined && generation <= sealed) {
            return false;
        }
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined) {
            this.streamGenerationByJid.set(jid, generation);
            return true;
        }
        if (generation < latest) {
            return false;
        }
        if (generation > latest) {
            this.clearStreamingStateForJid(jid);
            this.streamGenerationByJid.set(jid, generation);
        }
        return true;
    }
    markStreamingGenerationDone(jid, generation) {
        if (generation === undefined)
            return;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed === undefined || generation > sealed) {
            this.sealedStreamGenerationByJid.set(jid, generation);
        }
    }
    sealStreamingGenerationOnReset(jid) {
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined)
            return;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed === undefined || latest > sealed) {
            this.sealedStreamGenerationByJid.set(jid, latest);
        }
    }
    isCurrentStreamingGeneration(jid, generation) {
        if (generation === undefined)
            return true;
        const sealed = this.sealedStreamGenerationByJid.get(jid);
        if (sealed !== undefined && generation <= sealed) {
            return false;
        }
        const latest = this.streamGenerationByJid.get(jid);
        if (latest === undefined)
            return true;
        return generation === latest;
    }
    parseJid(jid) {
        if (!jid.startsWith('sl:'))
            return null;
        const channelId = jid.slice(3).trim();
        if (!channelId)
            return null;
        return { channelId };
    }
    isLikelyGroupConversation(channelId) {
        return !(channelId.startsWith('D') || channelId.startsWith('U'));
    }
    async resolveUserName(userId) {
        if (!userId)
            return 'Unknown User';
        const cached = this.userNameCache.get(userId);
        if (cached)
            return cached;
        if (!this.app)
            return userId;
        try {
            const result = (await this.app.client.users.info({
                user: userId,
            }));
            const displayName = result.user?.profile?.display_name ||
                result.user?.real_name ||
                result.user?.profile?.real_name ||
                result.user?.name ||
                userId;
            this.userNameCache.set(userId, displayName);
            return displayName;
        }
        catch (err) {
            logger.debug({ userId, err }, 'Failed to resolve Slack user name');
            return userId;
        }
    }
    async resolveChannelName(channelId) {
        const cached = this.channelNameCache.get(channelId);
        if (cached)
            return cached;
        if (!this.app)
            return channelId;
        try {
            const info = (await this.app.client.conversations.info({
                channel: channelId,
            }));
            if (info.channel?.is_im && info.channel.user) {
                const userName = await this.resolveUserName(info.channel.user);
                const name = `DM with ${userName}`;
                this.channelNameCache.set(channelId, name);
                return name;
            }
            const name = info.channel?.name || channelId;
            this.channelNameCache.set(channelId, name);
            return name;
        }
        catch (err) {
            logger.debug({ channelId, err }, 'Failed to resolve Slack channel name');
            return channelId;
        }
    }
    sanitizeFilename(raw) {
        const trimmed = raw.trim();
        const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_');
        return safe || 'attachment.bin';
    }
    async downloadSlackAttachment(jid, file, threadId, targetFolder) {
        const url = file.url_private_download || file.url_private;
        if (!url)
            return null;
        const groups = targetFolder
            ? []
            : findConversationRoutesForChat(this.opts.conversationRoutes(), jid, threadId, this.opts.providerAccountId);
        if (!targetFolder && groups.length < 1)
            return null;
        const filename = this.sanitizeFilename(file.name || file.title || 'attachment.bin');
        const storageRef = createInboundAttachmentStorageRef(filename);
        const folders = targetFolder
            ? [targetFolder]
            : Array.from(new Set(groups.map(([, group]) => group.folder)));
        if (folders.length !== 1)
            return null;
        try {
            const groupDir = resolveWorkspaceFolderPath(folders[0]);
            const attachDir = path.join(groupDir, 'attachments');
            ensurePrivateDirSync(attachDir);
            const destPath = path.join(groupDir, ...storageRef.split('/'));
            const resp = await fetch(url, {
                headers: {
                    authorization: `Bearer ${this.botToken}`,
                },
            });
            if (!resp.ok) {
                logger.warn({ jid, status: resp.status, filename }, 'Failed to download Slack attachment');
                return null;
            }
            const wrote = await writeSlackAttachmentResponse(resp, groupDir, storageRef);
            if (!wrote)
                return null;
            return { filePath: destPath, storageRef };
        }
        catch (err) {
            if (isFileExistsError(err))
                throw err;
            logger.warn({ jid, err, filename }, 'Slack attachment download failed');
            return null;
        }
    }
    async enrichMessage(jid, event, targetFolder) {
        const lines = [];
        const attachments = [];
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        if (text)
            lines.push(text);
        if (Array.isArray(event.files)) {
            for (const file of event.files) {
                const download = await this.downloadSlackAttachment(jid, file, event.thread_ts, targetFolder);
                const label = file.name || file.title || 'attachment';
                lines.push(`Attachment: ${label}`);
                const attachment = {
                    id: file.id ? `slack-file:${file.id}` : undefined,
                    kind: file.mimetype?.startsWith('image/') ? 'image' : 'file',
                    contentType: file.mimetype,
                    externalId: file.id,
                };
                if (download)
                    attachment.storageRef = download.storageRef;
                attachments.push(attachment);
            }
        }
        return { text: lines.join('\n').trim(), attachments };
    }
    async hydrateConversationContext(request) {
        return hydrateSlackConversationContext(request, {
            app: this.app,
            botUserId: this.botUserId,
            parseJid: (jid) => this.parseJid(jid),
            resolveUserName: (userId) => this.resolveUserName(userId),
        });
    }
    async tryNativeStreamStart(channelId, threadId, text) {
        return tryNativeStreamStart({ app: this.app, channelId, threadId, text });
    }
    async tryNativeStreamAppend(channelId, streamTs, text) {
        return tryNativeStreamAppend({ app: this.app, channelId, streamTs, text });
    }
    async tryNativeStreamStop(channelId, streamTs) {
        return tryNativeStreamStop({ app: this.app, channelId, streamTs });
    }
}
function isFileExistsError(error) {
    let current = error;
    while (typeof current === 'object' && current !== null) {
        if ('code' in current && current.code === 'EEXIST')
            return true;
        current = 'cause' in current ? current.cause : null;
    }
    return false;
}
