import { AttachmentResolver } from '../../application/attachments/attachment-resolver.js';
import type { HistoricalAttachmentFetcher } from '../../domain/ports/historical-attachment-fetcher.js';
import type { MessageAttachmentRepository } from '../../domain/ports/message-attachment-repository.js';
import { removeProviderAttachment } from '../../shared/provider-attachment-materialization.js';

export function createProviderAttachmentReclaimer(input: {
  materializationRoot: string;
  workspaceRoots: () => readonly string[];
}) {
  return (storageRef: string): Promise<void> =>
    removeProviderAttachment({
      materializationRoot: input.materializationRoot,
      workspaceRoots: input.workspaceRoots(),
      storageRef,
    });
}

export function createAttachmentOpen(input: {
  getRepository: () => MessageAttachmentRepository;
  fetcher: HistoricalAttachmentFetcher;
  materializationRoot: string;
  workspaceRoots: () => readonly string[];
}) {
  let resolver: AttachmentResolver | undefined;
  return (request: Parameters<AttachmentResolver['open']>[0]) => {
    resolver ??= new AttachmentResolver({
      repository: input.getRepository(),
      fetcher: input.fetcher,
      materializationRoot: input.materializationRoot,
      workspaceRoots: input.workspaceRoots,
    });
    return resolver.open(request);
  };
}
