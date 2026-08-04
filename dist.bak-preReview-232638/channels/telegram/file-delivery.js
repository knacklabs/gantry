import { InputFile } from 'grammy';
import { telegramThreadOptionsFromString } from './channel-shared.js';
const TELEGRAM_FILE_MAX_BYTES = 50 * 1024 * 1024;
export async function sendTelegramDocuments(input) {
    const sent = [];
    for (const file of input.files ?? []) {
        if (file.sizeBytes > TELEGRAM_FILE_MAX_BYTES) {
            const id = await sendTelegramAttachmentUnavailable(input, `${file.filename} exceeds 50 MB.`);
            if (id)
                sent.push(id);
            continue;
        }
        try {
            const result = await input.api.sendDocument(input.chatId, new InputFile(file.content, file.filename), {
                ...telegramThreadOptionsFromString(input.threadId),
                caption: file.filename,
            });
            if (result.message_id !== undefined)
                sent.push(String(result.message_id));
        }
        catch {
            // ponytail: text already went out; skip failed attachment instead of duplicating the message on retry.
            const id = await sendTelegramAttachmentUnavailable(input, `${file.filename} upload failed.`);
            if (id)
                sent.push(id);
        }
    }
    return sent;
}
export async function appendTelegramDocumentMessageIds(externalMessageIds, api, chatId, options) {
    externalMessageIds.push(...(await sendTelegramDocuments({
        api,
        chatId,
        threadId: options.threadId,
        files: options.files,
    })));
}
async function sendTelegramAttachmentUnavailable(input, reason) {
    try {
        const result = await input.api.sendMessage(input.chatId, `Attachment unavailable in Telegram: ${reason}`, telegramThreadOptionsFromString(input.threadId));
        return result.message_id === undefined
            ? undefined
            : String(result.message_id);
    }
    catch {
        return undefined;
    }
}
