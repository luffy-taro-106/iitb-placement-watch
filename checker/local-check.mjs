import {readFile,writeFile,mkdir,rm,stat,rename,chmod} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {bridgeCall} from './bridge.mjs';
import {readHttpSnapshot} from './http-source.mjs';
import {PolicyError} from './policy.mjs';

const READ_RETRIES=new Set(['BRIDGE_BUSY','BRIDGE_UNREACHABLE','INVALID_BRIDGE_RESPONSE']);
const pause=(ms,signal)=>sleep(ms,undefined,{signal});
export async function runLocalCheck({config,call=bridgeCall,read=readHttpSnapshot,signal,wait=pause}={}) {
  const deadline=AbortSignal.timeout(230000),runSignal=signal?AbortSignal.any([deadline,signal]):deadline;
  let saved,snapshot;
  async function readControl(action) {
    for(let attempt=0;;attempt++) {
      runSignal.throwIfAborted();
      try{return await call(config,action,{},undefined,{signal:runSignal,timeoutMs:25000});}
      catch(error){if(attempt>=2 || !READ_RETRIES.has(error.code) || runSignal.aborted)throw error;await wait([1000,3000][attempt],runSignal);}
    }
  }
  try {
    saved=await readControl('get_session');
    if(!saved.session)throw new PolicyError('IITB_RECONNECT_REQUIRED');
    snapshot=await read(saved.session,{lastSuccessfulCheck:saved.last_successful_check,signal:runSignal});
    let result,report;
    try {
      // Never retry an uncertain mutation. Its server-side provider receipt may already exist.
      result=await call(config,'ingest_local_snapshot',snapshot,undefined,{signal:runSignal,timeoutMs:90000});
    } catch(error) {
      // A lost response is success only after the exact complete read was acknowledged.
      try {
        report=await readControl('source_status');
        if(report.local_source_observed_at!==snapshot.observed_at || !report.local_source_fresh)throw error;
        const state=await readControl('status');
        result={pending_count:state.pending_count,meeting_count:state.meeting_count,delivery_count:state.delivery_count,needs_attention:state.needs_attention};
      } catch {throw error;}
    }
    if(result.source_mode==='local_https' && result.local_source_fresh===true && result.local_source_observed_at===snapshot.observed_at) {
      report={mode:'local_https',local_source_fresh:true,local_source_observed_at:snapshot.observed_at};
    }
    if(!report)report=await readControl('source_status');
    if(report.mode!=='local_https') {
      try {report=await call(config,'configure_source',{mode:'local_https'},undefined,{signal:runSignal,timeoutMs:25000});}
      catch(error) {try{report=await readControl('source_status');}catch{throw error;}}
    }
    if(report.mode!=='local_https' || report.local_source_fresh!==true || report.local_source_observed_at!==snapshot.observed_at)throw new PolicyError('SOURCE_MODE_UNCONFIRMED');
    return {ok:true,checked_at:snapshot.observed_at,post_count:snapshot.posts.length,pending_count:result.pending_count,meeting_count:result.meeting_count,delivery_count:result.delivery_count,needs_attention:result.needs_attention};
  } finally {
    for(const cookie of snapshot?.session?.cookies || [])cookie.value='';
    for(const cookie of saved?.session?.cookies || [])cookie.value='';
  }
}

export async function writeStatusAtomic(file,value) {
  const temporary=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
  try {await writeFile(temporary,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});await rename(temporary,file);await chmod(file,0o600);}
  finally {await rm(temporary,{force:true}).catch(()=>{});}
}
export function nextCheckStatus(previous,{result,error,at=new Date().toISOString(),running=false}={}) {
  const old=previous || {},success=result?.ok===true;
  const last=success?result.checked_at:old.last_successful_check || (old.ok?old.checked_at:null) || null;
  return {...old,...(result || {}),version:2,ok:success,error:success?null:error || old.error || null,running,last_attempt_at:at,
    last_successful_check:last,consecutive_failures:running?(old.consecutive_failures || 0):success?0:(old.consecutive_failures || 0)+1,
    last_success_counts:success?{post_count:result.post_count,pending_count:result.pending_count,meeting_count:result.meeting_count,delivery_count:result.delivery_count}:old.last_success_counts || null};
}
function livePid(pid) {
  if(!Number.isSafeInteger(pid)||pid<1)return false;
  try {process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}
export async function acquireLocalLock(path,{pid=process.pid,isLive=livePid,now=Date.now()}={}) {
  for(let attempt=0;attempt<2;attempt++) {
    try {
      await mkdir(path,{mode:0o700});const owner={pid,token:randomUUID(),started_at:new Date(now).toISOString()};
      await writeFile(path+'/owner.json',JSON.stringify(owner),{mode:0o600,flag:'wx'});return owner;
    } catch(error) {
      if(error.code!=='EEXIST')throw error;
      let owner;try{owner=JSON.parse(await readFile(path+'/owner.json','utf8'));}catch{}
      if(owner && isLive(owner.pid))return null;
      if(!owner && now-(await stat(path)).mtimeMs<30000)return null;
      await rm(path,{recursive:true});
    }
  }
  return null;
}
export async function releaseLocalLock(path,owner) {
  try {const current=JSON.parse(await readFile(path+'/owner.json','utf8'));if(current.pid===owner.pid && current.token===owner.token)await rm(path,{recursive:true});}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
async function rotateLog(file) {
  try {if((await stat(file)).size>1024*1024){await rm(file+'.1',{force:true});await rename(file,file+'.1');}}
  catch(error){if(error.code!=='ENOENT')throw error;}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const privateDir=fileURLToPath(new URL('../private/',import.meta.url)),lock=privateDir+'local-check.lock',statusFile=privateDir+'local-check-status.json';
  let owner,previous={};const controller=new AbortController();
  const watchdog=setTimeout(()=>{controller.abort();process.exitCode=1;},235000);watchdog.unref();
  try {
    owner=await acquireLocalLock(lock);if(!owner)process.exit(0);
    try{previous=JSON.parse(await readFile(statusFile,'utf8'));}catch{}
    await writeStatusAtomic(statusFile,nextCheckStatus(previous,{at:new Date().toISOString(),running:true}));
    await rotateLog(privateDir+'local-check.log');await rotateLog(privateDir+'local-check-error.log');
    const config=JSON.parse(await readFile(privateDir+'bridge-admin.json','utf8'));
    const result=await runLocalCheck({config,signal:controller.signal});
    await writeStatusAtomic(statusFile,nextCheckStatus(previous,{result}));
    console.log('Placement check completed; pending: '+result.pending_count+'.');
  } catch(error) {
    const code=controller.signal.aborted?'LOCAL_CHECK_TIMEOUT':error instanceof PolicyError?error.code:'LOCAL_SOURCE_CHECK_FAILED';
    await writeStatusAtomic(statusFile,nextCheckStatus(previous,{error:code}));
    console.error(code);process.exitCode=1;
  } finally {clearTimeout(watchdog);if(owner)await releaseLocalLock(lock,owner);}
}
