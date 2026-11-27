import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {createHash} from 'node:crypto';
import {createPostgresIntegrationRuntime,hasPostgresIntegrationDatabase,type PostgresIntegrationRuntime} from '../harness/postgres-integration-runtime.js';
import * as s from '@core/adapters/storage/postgres/schema/schema.js';
import {buildSourceContextReceipt} from '@core/adapters/storage/postgres/repositories/source-context-receipt.postgres.js';
import {hashSourceMessage,hashSourceContextReceipt} from '../../../../packages/sdk/src/source-channel.js';
const run=hasPostgresIntegrationDatabase?describe:describe.skip;
run('native selected and summarized source proofs',()=>{
 let runtime:PostgresIntegrationRuntime;
 let sessionId:string,conversationId:string;
 const binding={discussionId:'D',generation:1,workspaceId:'W',tenderId:'T'};
 beforeAll(async()=>{
  runtime=await createPostgresIntegrationRuntime({schemaPrefix:'source_context_proof'});
  const session=await runtime.control.ensureAppSession({appId:'default',conversationId:'D',chatJid:'app:default:D',workspaceFolder:'main_agent'});
  sessionId=session.sessionId;
  const [nativeSession]=await runtime.service.db.select().from(s.controlHttpSessionsPostgres).where(eq(s.controlHttpSessionsPostgres.sessionId,sessionId));
  conversationId=nativeSession!.conversationId;
  for(let i=1;i<=3;i++){
   const message={sourceMessageId:`M${i}`,sourcePosition:String(i),authorId:'P',authorKind:'human' as const,authorDisplayName:'Person',text:'stored source',createdAt:'2026-11-18T00:00:00.000Z',replyToSourceId:null,revisionId:'R',origin:'human' as const};
   await runtime.control.appendSourceMessage('default',sessionId,{binding,authority:{authorityId:'service',authorityVersion:'1',kind:'service',subject:'service',expiresAt:'2027-01-01T00:00:00.000Z'},message:{...message,contentHash:hashSourceMessage(message)},idempotencyKey:`store${i}`});
  }
  await runtime.service.db.insert(s.agentSessionDigestsPostgres).values({id:'digest',appId:'default',agentSessionId:sessionId,trigger:'source-context',digest:'Summary of earlier sources',messageCount:2,metadataJson:{generation:1,workspaceId:'W',sourceVersion:'R',coveredRange:{after:'0',through:'1'}}});
 },60000);
 afterAll(async()=>{if(runtime){await runtime.storageRuntime.runtimeEventNotifier.close();await runtime.cleanup();}});
 const input=async()=>{
  const [question]=await runtime.service.db.select().from(s.messagesPostgres).where(eq(s.messagesPostgres.sourceMessageId,'M3'));
  return {appId:'default',sessionId,conversationId,request:{binding,answerGoalId:'G',attemptId:'A',questionSourceId:'M3',sourceCutoff:'3',revisionId:'R'} as never,snapshot:{selectionMode:'recent' as const,sources:[{sourceMessageId:'M3',sourcePosition:'3',contentHash:question!.sourceContentHash!}]},text:JSON.stringify({answerUnits:[{source:'conversation',conversationSourceIds:['M1']}]})};
 };
 it('requires individual native hashes for summarized references and survives JSONB replay',async()=>{
  const value=await input();
  const result=await runtime.service.db.transaction(tx=>buildSourceContextReceipt(tx,{...value,summaryId:'digest'}));
  expect(result.summary!.citedSources[0]).toMatchObject({sourceMessageId:'M1',sourcePosition:'1'});
  expect(result.summary!.citedSources[0]!.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(result.summary!.sha256).toBe(createHash('sha256').update('Summary of earlier sources').digest('hex'));
  const jsonb=await runtime.service.db.execute<{value:typeof result}>(sql`select ${JSON.stringify(result)}::jsonb as value`);
  const {receiptHash,...body}=jsonb.rows[0]!.value;
  expect(hashSourceContextReceipt(body)).toBe(receiptHash);
 });
 it('rejects unselected siblings, missing/foreign summarized IDs and propagates database failure',async()=>{
  const value=await input();
  await expect(buildSourceContextReceipt(runtime.service.db,value)).rejects.toThrow(/not selected/);
  await expect(buildSourceContextReceipt(runtime.service.db,{...value,summaryId:'digest',text:JSON.stringify({answerUnits:[{source:'conversation',conversationSourceIds:['M2']}]})})).rejects.toThrow(/selected digest/);
  await expect(buildSourceContextReceipt(runtime.service.db,{...value,summaryId:'digest',text:JSON.stringify({answerUnits:[{source:'conversation',conversationSourceIds:['foreign']}]})})).rejects.toThrow(/Unknown/);
  await expect(buildSourceContextReceipt({select(){throw new Error('database unavailable');}} as never,{...value,summaryId:'digest'})).rejects.toThrow('database unavailable');
 });
});
