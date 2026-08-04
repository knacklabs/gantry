async function uploadSlackAttachment(input) {
    const upload = await input.app.client.files.getUploadURLExternal({
        filename: input.file.filename,
        length: input.file.sizeBytes,
    });
    if (upload.ok === false || !upload.upload_url || !upload.file_id) {
        throw new Error(upload.error || 'Slack upload URL request failed');
    }
    const response = await fetch(upload.upload_url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from(input.file.content),
    });
    if (!response.ok) {
        throw new Error(`Slack external upload failed (${response.status})`);
    }
    const completed = await input.app.client.files.completeUploadExternal({
        files: [{ id: upload.file_id, title: input.file.filename }],
        channel_id: input.channelId,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
    });
    if (completed.ok === false) {
        throw new Error(completed.error || 'Slack upload completion failed');
    }
}
export async function uploadSlackAttachments(input) {
    for (const [index, file] of (input.files ?? []).entries()) {
        try {
            await uploadSlackAttachment({
                app: input.app,
                channelId: input.channelId,
                threadTs: input.threadTs,
                file,
            });
        }
        catch (error) {
            const reason = `${file.filename} upload failed.`;
            input.warnings.push('slack.attachment_upload_failed');
            input.log.warn({ jid: input.jid, path: file.filename, reason, error }, 'Slack attachment upload failed');
            try {
                const posted = await input.postSlackMessageWithRetry(input.app, {
                    channel: input.channelId,
                    text: `Attachment unavailable in Slack: ${reason}`,
                    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
                }, {
                    jid: input.jid,
                    part: index + 1,
                    totalParts: input.files?.length ?? 0,
                }, input.warnings, input.log);
                if (posted.ts)
                    input.externalMessageIds.push(posted.ts);
            }
            catch (fallbackError) {
                input.log.warn({ jid: input.jid, path: file.filename, reason, error: fallbackError }, 'Slack attachment fallback message failed');
                throw fallbackError;
            }
        }
    }
}
