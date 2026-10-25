import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {bridgeCall} from './bridge.mjs';
import {readHttpSnapshot} from './http-source.mjs';
import {PolicyError} from './policy.mjs';

export async function runLocalCheck({config,call=bridgeCall,read=readHttpSnapshot}={}) {
  const saved=await call(config,'get_session',{});
  if(!saved.session)throw new PolicyError('IITB_RECONNECT_REQUIRED');
  let snapshot;
  try {
    snapshot=await read(saved.session,{lastSuccessfulCheck:saved.last_successful_check});
    const result=await call(config,'ingest_local_snapshot',snapshot);
    const mode=await call(config,'configure_source',{mode:'local_https'});
    if(mode.mode!=='local_https' || mode.local_source_fresh!==true)throw new PolicyError('SOURCE_MODE_UNCONFIRMED');
    return {ok:true,checked_at:snapshot.observed_at,post_count:snapshot.posts.length,pending_count:result.pending_count,meeting_count:result.meeting_count,delivery_count:result.delivery_count,needs_attention:result.needs_attention};
  } finally {for(const cookie of snapshot?.session?.cookies || [])cookie.value='';for(const cookie of saved.session.cookies)cookie.value='';}
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const privateDir=fileURLToPath(new URL('../private/',import.meta.url)),lock=privateDir+'local-check.lock';
  let acquired=false;
  try {
    try {await mkdir(lock,{mode:0o700});acquired=true;}catch(error){
      if(error.code!=='EEXIST')throw error;
      if(Date.now()-(await stat(lock)).mtimeMs<10*60000)process.exit(0);
      await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});acquired=true;
    }
    const config=JSON.parse(await readFile(privateDir+'bridge-admin.json','utf8'));
    const result=await runLocalCheck({config});
    await writeFile(privateDir+'local-check-status.json',JSON.stringify(result,null,2),{mode:0o600});
    console.log('Placement check completed; pending: '+result.pending_count+'.');
  } catch(error) {
    const code=error instanceof PolicyError?error.code:'LOCAL_SOURCE_CHECK_FAILED';
    await writeFile(privateDir+'local-check-status.json',JSON.stringify({ok:false,attempted_at:new Date().toISOString(),error:code},null,2),{mode:0o600});
    console.error(code);process.exitCode=1;
  } finally {if(acquired)await rm(lock,{recursive:true,force:true});}
}
