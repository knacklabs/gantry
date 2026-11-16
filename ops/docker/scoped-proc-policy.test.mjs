import assert from 'node:assert/strict';
import test from 'node:test';
import { scopedContainerSpec, replaceStoppedContainer } from './scoped-proc-policy.mjs';

const policy = { maskedPaths: ['/proc/acpi', '/sys/firmware'], readonlyPaths: [] };
function inspected() {
  return { Id: 'original-id', Name: '/gantry-test', Image: 'sha256:' + 'a'.repeat(64), State: { Running: false },
    Config: { Image: 'gantry-runtime@sha256:' + 'b'.repeat(64), User: '1000:1000', Env: ['SECRET=private'], Cmd: ['node', 'dist/index.js'], Labels: { 'gantry.security.proc-policy': 'scoped-v1', 'com.docker.compose.service': 'gantry-runtime' } },
    HostConfig: { Privileged: false, CapAdd: [], CapDrop: ['ALL'], ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges=true', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}'], NetworkMode: 'private-network', MaskedPaths: ['/proc/acpi','/proc/kcore','/sys/firmware'], ReadonlyPaths: ['/proc/sys'], AutoRemove: false },
    NetworkSettings: { Networks: { 'private-network': { Aliases: ['gantry-runtime'], IPAddress: '172.20.0.5', IPAMConfig: null } } } };
}
test('preserves Compose configuration, pinned image and network aliases; changes only process paths', () => {
 const original = inspected(); const result = scopedContainerSpec(original, policy);
 assert.equal(result.Image, original.Image);
 assert.equal(result.Env[0], 'SECRET=private');
 assert.deepEqual(result.HostConfig, { ...original.HostConfig, MaskedPaths: policy.maskedPaths, ReadonlyPaths: [] });
 assert.deepEqual(result.NetworkingConfig.EndpointsConfig, { 'private-network': { Aliases: ['gantry-runtime'] } });
 assert.deepEqual(original.HostConfig.ReadonlyPaths, ['/proc/sys']);
});
test('refuses running services, missing opt-in and broader host permissions', () => {
 for (const modify of [i=>i.State.Running=true,i=>i.Config.Image='gantry-runtime:latest',i=>delete i.Config.Labels['gantry.security.proc-policy'],i=>i.HostConfig.Privileged=true,i=>i.Config.User='0',i=>i.HostConfig.CapAdd=['SYS_ADMIN'],i=>i.HostConfig.CapDrop=[],i=>i.HostConfig.ReadonlyRootfs=false,i=>i.HostConfig.SecurityOpt=['seccomp=unconfined'],i=>i.HostConfig.PidMode='host',i=>i.HostConfig.NetworkMode='host',i=>i.HostConfig.Devices=[{PathOnHost:'/dev/sda'}],i=>i.Mounts=[{Type:'bind',Source:'/',Destination:'/host',RW:false}],i=>i.Mounts=[{Type:'bind',Source:'/var/run/docker.sock',Destination:'/socket',RW:false}],i=>i.HostConfig.ReadonlyPaths=['/proc/acpi']]) {
  const value=inspected(); modify(value); assert.throws(()=>scopedContainerSpec(value,policy));
 }
});
test('requires explicit arrays and retains unrelated sys masks', () => {
 assert.throws(()=>scopedContainerSpec(inspected(),{maskedPaths:[],readonlyPaths:[]}));
 assert.throws(()=>scopedContainerSpec(inspected(),{maskedPaths:policy.maskedPaths,readonlyPaths:['/etc']}));
});
test('creates and verifies a stopped replacement before removing the original; never starts or deletes volumes', async () => {
 const calls=[]; const original=inspected(); const expected=scopedContainerSpec(original,policy);
 const engine=async(method,url,body)=>{calls.push({method,url,body});if(url.endsWith('/json'))return url.includes('replacement-id')?{...original,Id:'replacement-id',Config:expected,HostConfig:expected.HostConfig}:original;if(method==='POST'&&url.startsWith('/containers/create'))return{Id:'replacement-id'};};
 await replaceStoppedContainer(engine,'original-id',policy);
 assert.equal(calls.some(c=>c.url.includes('/start')),false);
 assert.equal(calls.some(c=>c.url.includes('force=true')||c.url.includes('v=true')),false);
 const deletion=calls.findIndex(c=>c.method==='DELETE'&&c.url.includes('original-id'));
 const verified=calls.findIndex(c=>c.url==='/containers/replacement-id/json');
 assert.ok(verified<deletion);
});
test('failed candidate verification leaves the original intact', async () => {
 const calls=[];
 const engine=async(method,url,body)=>{calls.push({method,url,body});if(url.endsWith('/json'))return url.includes('replacement-id')?{...inspected(),HostConfig:{...inspected().HostConfig,MaskedPaths:[]}}:inspected();if(url.startsWith('/containers/create'))return{Id:'replacement-id'};};
 await assert.rejects(replaceStoppedContainer(engine,'original-id',policy));
 assert.equal(calls.some(c=>c.method==='DELETE'&&c.url.includes('original-id')),false);
});
