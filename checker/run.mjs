import {chromium} from 'playwright';
import {bridgeCall,bridgeConfig} from './bridge.mjs';
import {collectSnapshot,installNetworkPolicy} from './extract.mjs';
import {filterSession,sourceConfig,PolicyError} from './policy.mjs';

export async function runSourceCheck({env=process.env,browserType=chromium,call=bridgeCall}={}) {
  sourceConfig(env);const config=bridgeConfig(env),stored=await call(config,'get_session',{});
  if (!stored.session) throw new PolicyError('IITB_RECONNECT_REQUIRED');
  const session=filterSession(stored.session);
  const browser=await browserType.launch({headless:true,args:['--disable-breakpad','--disable-crash-reporter']});
  const timer=setTimeout(()=>browser.close().catch(()=>{}),240000);
  try {
    const context=await browser.newContext({storageState:session,acceptDownloads:false,serviceWorkers:'block'});
    await installNetworkPolicy(context);
    const page=await context.newPage();
    const snapshot=await collectSnapshot(page,{lastSuccessfulCheck:stored.last_successful_check});
    snapshot.session=filterSession(await context.storageState());
    const result=await call(config,'ingest_snapshot',snapshot);
    return {pending_count:result.pending_count ?? 0,meeting_count:result.meeting_count ?? 0,delivery_count:result.delivery_count ?? 0};
  } finally {clearTimeout(timer);await browser.close();}
}
if (import.meta.url===new URL(process.argv[1] || '', 'file:').href) {
  runSourceCheck().then(result=>console.log('Manual source check finished. Pending updates: '+result.pending_count+'.'))
    .catch(error=>{console.error(error instanceof PolicyError?error.code:'SOURCE_CHECK_FAILED');process.exitCode=1;});
}
