import {describe,it,expect,vi} from 'vitest';
import {handleSourceDocumentTask} from '../../../src/jobs/ipc-source-document-handler.js';
describe('source document operation authority',()=>{
 for(const authorization of [undefined,{action:'memory_save'},{action:'source_document',signature:'invalid',context:{appId:'app',agentId:'agent:interactive',chatJid:'app:app:D1',sourceRunId:'foreign',sourceWorkspaceMemoryId:'foreign'}}])it('rejects missing, cross-operation, and forged authority before reading storage or launching a renderer',async()=>{
  const store=vi.fn();await expect(handleSourceDocumentTask({sourceAgentFolder:'interactive',data:{appId:'app',agentId:'agent:interactive',sourceRunId:'run',chatJid:'app:app:D1',payload:{action:'render_source_document',authorization,document:{version:1}}},deps:{getFileArtifactStore:store}} as never)).rejects.toThrow();expect(store).not.toHaveBeenCalled();
 });
});
