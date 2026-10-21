import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

test('the pinned deny-default profile adds only the demonstrated sandbox operations', () => {
 const bytes=fs.readFileSync(new URL('./seccomp.json',import.meta.url));
 const profile=JSON.parse(bytes);const provenance=JSON.parse(fs.readFileSync(new URL('./provenance.json',import.meta.url)));
 assert.equal(profile.defaultAction,'SCMP_ACT_ERRNO');
 const {comment,...allowance}=profile.syscalls.at(-1);
 assert.deepEqual(allowance,{names:['clone','unshare','mount','umount2','pivot_root','chroot'],action:'SCMP_ACT_ALLOW'});
 assert.deepEqual(provenance.addedSyscalls,profile.syscalls.at(-1).names);
 assert.equal(provenance.profileSha256,createHash('sha256').update(bytes).digest('hex'));
 assert.ok(!profile.syscalls.some(rule=>rule.action==='SCMP_ACT_ALLOW'&&!rule.includes&&!rule.args&&rule.names.includes('setns')));
});
