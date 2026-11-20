import { beforeEach, describe, it, expect, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  reject: vi.fn(),
  handle: vi.fn(),
}));
vi.mock('@core/jobs/ipc-shared.js', () => ({
  createTaskResponder: () => ({
    acceptData: mocks.accept,
    reject: mocks.reject,
  }),
  toTrimmedString: (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined,
}));
vi.mock('@core/jobs/ipc-source-document-handler.js', () => ({
  handleSourceDocumentTask: mocks.handle,
}));
import { fileArtifactTaskHandlers } from '@core/jobs/ipc-file-artifact-handlers.js';
const context = (extra = {}) => ({
  sourceAgentFolder: 'native-agent',
  sourceAgentFolderJids: [],
  data: {
    appId: 'app',
    chatJid: 'app:app:discussion',
    targetJid: 'app:app:discussion',
    sourceRunKind: 'interactive',
    payload: { action: 'render_source_document' },
    ...extra,
  },
  deps: {},
});
describe('native document routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handle.mockResolvedValue({ artifactId: 'verified' });
  });
  it('routes unregistered native source chat to signed operation authorization', async () => {
    await fileArtifactTaskHandlers.file_artifact(context() as never);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.accept).toHaveBeenCalledWith('Source document generated.', {
      artifactId: 'verified',
    });
  });
  it('retains target-override denial before document authorization', async () => {
    await fileArtifactTaskHandlers.file_artifact(
      context({ targetJid: 'app:app:other' }) as never,
    );
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.reject).toHaveBeenCalled();
  });
  it('denies rejected signed authority and never claims a document', async () => {
    mocks.handle.mockRejectedValue(new Error('Source document scope mismatch'));
    await fileArtifactTaskHandlers.file_artifact(context() as never);
    expect(mocks.handle).toHaveBeenCalledTimes(1);
    expect(mocks.accept).not.toHaveBeenCalled();
    expect(mocks.reject).toHaveBeenCalled();
  });
  it('ordinary unregistered file access remains denied', async () => {
    await fileArtifactTaskHandlers.file_artifact(
      context({ payload: { action: 'read', path: 'secret' } }) as never,
    );
    expect(mocks.handle).not.toHaveBeenCalled();
    expect(mocks.reject).toHaveBeenCalled();
  });
});
