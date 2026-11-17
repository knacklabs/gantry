import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createClient } from '../packages/sdk/dist/index.js';

const {values}=parseArgs({options:{'prepare-settings':{type:'string'},'base-url':{type:'string'},'credential-only':{type:'boolean'},alias:{type:'string',default:'manipal.chat'}}});
const db=new URL(process.env.GANTRY_DATABASE_URL??'postgres://invalid/invalid');
if(!db.pathname.startsWith('/chat_validation_'))throw new Error('Refusing a database outside the isolated chat_validation_ namespace');
if(values['prepare-settings']){
 const target=path.resolve(values['prepare-settings']);
 if(!target.includes(`${path.sep}.local${path.sep}chat-validation${path.sep}`))throw new Error('Settings target must belong to the isolated chat validation directory');
 const {createDefaultRuntimeSettings}=await import('../dist/config/settings/runtime-settings-defaults.js');
 const {renderRuntimeSettingsYaml}=await import('../dist/config/settings/runtime-settings-renderer.js');
 const {loadRuntimeSettingsFromPath}=await import('../dist/config/settings/runtime-settings.js');
 const settings=fs.existsSync(target)?loadRuntimeSettingsFromPath(target):createDefaultRuntimeSettings();
 settings.modelAliases[values.alias]={provider:'anthropic',providerModelId:'claude-haiku-4-5-20251001',displayName:'Isolated chat Haiku 4.5',aliases:[values.alias],recommendedAlias:values.alias,source:'isolated-chat-validation',contextWindowTokens:200000,maxOutputTokens:64000,inputUsdPerMillionTokens:1,outputUsdPerMillionTokens:5,cachedInputUsdPerMillionTokens:.1,cacheWriteUsdPerMillionTokens:1.25,supportsThinking:false,supportedEffortLevels:[],supportsTools:true,supportedWorkloads:['chat']};
 settings.agent.defaultModel=values.alias;
 settings.desiredState.authoritative=false;
 settings.observer.enabled=false;
 settings.memory.dreaming.enabled=false;
 if(settings.memory.consolidation)settings.memory.consolidation.enabled=false;
 settings.memory.embeddings.enabled=false;
 for(const [id,provider] of Object.entries(settings.providers))if(id!=='app')provider.enabled=false;
 fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,renderRuntimeSettingsYaml(settings),{mode:0o600});
 console.log(JSON.stringify({settingsPrepared:true,alias:values.alias,providerModel:'claude-haiku-4-5-20251001',paidCalls:0}));
}else{
 const url=new URL(values['base-url']??'http://127.0.0.1:3939');
 if(!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Validation provisioning requires a loopback control endpoint');
 const appId=process.env.GANTRY_CONTROL_APP_ID?.trim();if(!appId)throw new Error('GANTRY_CONTROL_APP_ID required');
 const records=JSON.parse(process.env.GANTRY_CONTROL_API_KEYS_JSON??'[]');
 const record=records.find(row=>row.appId===appId&&row.scopes?.includes('credentials:admin'));
 if(!record?.token)throw new Error('Isolated app-scoped credentials administrator key required');
 if(!process.env.ANTHROPIC_API_KEY?.trim())throw new Error('Authorized isolated Anthropic key required');
 const client=createClient({baseUrl:url.href,apiKey:record.token});
 await client.models.credentials.put('anthropic',{authMode:'api_key',payload:{apiKey:process.env.ANTHROPIC_API_KEY.trim()}});
 console.log(JSON.stringify({providerCredentialProvisioned:true,appId,provider:'anthropic',paidCalls:0}));
}
