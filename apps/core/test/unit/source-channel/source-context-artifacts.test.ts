import {it,expect} from 'vitest';
import {sourceMessageArtifacts} from '../../../src/adapters/storage/postgres/repositories/source-message-artifacts.postgres.js';
const binding={discussionId:'D',generation:1,workspaceId:'W',tenderId:'T'};
const receipt={artifactId:'F',sessionId:'S',runId:'R',answerGoalId:'G',attemptId:'A',binding,format:'pdf',fileName:'checklist.pdf',contentType:'application/pdf',sizeBytes:20,sha256:'a'.repeat(64),rendererVersion:'1',manifestHash:'b'.repeat(64),citationIds:[],metadataFields:[]};
const message={id:'O',direction:'outbound',externalRefJson:{sourceAnswerGoalId:'G',sourceRunId:'R'}};
const input={appId:'app',sessionId:'S',binding,messages:[message]} as never;
const executor=(events:unknown[])=>({select:()=>({from:()=>({where:async()=>events})})}) as never;
it('recovers exact legacy receipts from the owned fenced outbound event, not source text',async()=>{
 const result=await sourceMessageArtifacts(executor([{runId:'R',correlationId:'G',payloadJson:JSON.stringify({runtimeOutputId:'O',text:JSON.stringify({artifacts:[receipt]})})}]),input);
 expect(result.get('O')).toEqual([receipt]);
 expect(await sourceMessageArtifacts(executor([{runId:'wrong',correlationId:'G',payloadJson:JSON.stringify({runtimeOutputId:'O',text:JSON.stringify({artifacts:[receipt]})})}]),input)).toEqual(new Map());
});
it('retains trusted metadata without further event reads and rejects foreign ownership',async()=>{
 const retained={...message,externalRefJson:{...message.externalRefJson,sourceArtifacts:[receipt]}};
 const noRead={select(){throw new Error('Unexpected history scan');}} as never;
 expect((await sourceMessageArtifacts(noRead,{...(input as object),appId:'app',sessionId:'S',binding,messages:[retained]} as never)).get('O')).toEqual([receipt]);
 await expect(sourceMessageArtifacts(noRead,{appId:'app',sessionId:'foreign',binding,messages:[retained]} as never)).rejects.toThrow(/ownership/);
});
