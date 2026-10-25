import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireLocalLock,releaseLocalLock,nextCheckStatus,writeStatusAtomic,runLocalCheck} from '../local-check.mjs';
import {PolicyError} from '../policy.mjs';
const session=()=>({cookies:[{value:'synthetic'}],origins:[]});
const snapshot=()=>({source_url:'https://campus.placements.iitb.ac.in/blog/placement/',complete:true,posts:[{id:'post-1'}],observed_at:new Date().toISOString(),session:session()});

test('A failed check keeps its last success and writes private status atomically',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'iitb-local-status-'));try {
 const file=join(dir,'status.json'),good={ok:true,checked_at:'2026-10-25T12:00:00Z',post_count:110,pending_count:0,meeting_count:10,delivery_count:67};
 const first=nextCheckStatus({}, {result:good,at:'2026-10-25T12:01:00Z'});await writeStatusAtomic(file,first);
 const failed=nextCheckStatus(first,{error:'IITB_NETWORK_UNAVAILABLE',at:'2026-10-25T12:05:00Z'});await writeStatusAtomic(file,failed);
 const saved=JSON.parse(await readFile(file));assert.equal(saved.last_successful_check,good.checked_at);assert.equal(saved.consecutive_failures,1);assert.equal(saved.last_success_counts.delivery_count,67);assert.equal(saved.last_attempt_at,'2026-10-25T12:05:00Z');assert.equal((await stat(file)).mode&0o777,0o600);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('A live owner lock is never stolen by age; an exited owner is recoverable and only its token releases it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'iitb-local-lock-')),path=join(dir,'lock');try{
 const first=await acquireLocalLock(path,{pid:123,isLive:()=>true,now:1});assert.ok(first);
 assert.equal(await acquireLocalLock(path,{pid:456,isLive:()=>true,now:999999999}),null);
 await releaseLocalLock(path,{pid:123,token:'wrong'});assert.ok(await stat(path));
 const next=await acquireLocalLock(path,{pid:456,isLive:()=>false,now:999999999});assert.equal(next.pid,456);
 await releaseLocalLock(path,first);assert.ok(await stat(path));await releaseLocalLock(path,next);await assert.rejects(stat(path),{code:'ENOENT'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('An uncertain ingestion is reconciled from its exact observation, without another mutation or duplicate configure call',async()=>{
 const shot=snapshot(),calls=[];
 const result=await runLocalCheck({config:{},read:async()=>shot,call:async(_c,action)=>{
 calls.push(action);if(action==='get_session')return {session:session()};
 if(action==='ingest_local_snapshot')throw new PolicyError('BRIDGE_UNREACHABLE');
 if(action==='source_status')return {mode:'local_https',local_source_observed_at:shot.observed_at,local_source_fresh:true};
 if(action==='status')return {pending_count:0,meeting_count:10,delivery_count:68,needs_attention:false};
 throw new Error('Unexpected mutation');
 }});
 assert.equal(result.ok,true);assert.equal(calls.filter(a=>a==='ingest_local_snapshot').length,1);assert.equal(calls.includes('configure_source'),false);
});
test('A signed busy read is retried; an uncertain unacknowledged ingestion is not repeated',async()=>{
 const shot=snapshot();let gets=0,posts=0,waits=0;
 await assert.rejects(runLocalCheck({config:{},read:async()=>shot,wait:async()=>{waits++;},call:async(_c,action)=>{
 if(action==='get_session'){if(++gets===1)throw new PolicyError('BRIDGE_BUSY');return {session:session()};}
 if(action==='ingest_local_snapshot'){posts++;throw new PolicyError('BRIDGE_UNREACHABLE');}
 if(action==='source_status')return {mode:'local_https',local_source_observed_at:'2026-01-01T00:00:00Z',local_source_fresh:false};
 }}),e=>e.code==='BRIDGE_UNREACHABLE');assert.equal(gets,2);assert.equal(waits,1);assert.equal(posts,1);
});
test('A confirmed ingestion avoids extra mode calls and all work shares a cancellation signal',async()=>{
 const shot=snapshot(),calls=[];
 const result=await runLocalCheck({config:{},read:async(_s,options)=>{assert.ok(options.signal);return shot;},call:async(_c,action,_p,_f,options)=>{
 assert.ok(options.signal);calls.push(action);if(action==='get_session')return {session:session()};
 return {source_mode:'local_https',local_source_fresh:true,local_source_observed_at:shot.observed_at,pending_count:0,delivery_count:1,meeting_count:0,needs_attention:false};
 }});assert.equal(result.ok,true);assert.deepEqual(calls,['get_session','ingest_local_snapshot']);
 const abort=new AbortController();abort.abort();await assert.rejects(runLocalCheck({config:{},signal:abort.signal,call:async()=>{throw new Error('Must not start');}}));
});
