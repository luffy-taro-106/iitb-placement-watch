import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const files=await Promise.all(['Bridge.gs','Source.gs'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
const BLOG='https://campus.placements.iitb.ac.in/blog/placement/';
const OWNER='owner@example.test',SECRET='synthetic-shared-secret-with-no-live-access';
const NOW=Date.parse('2026-10-12T08:00:00.000Z');
// Opaque enum fixtures deliberately cannot be established by string conversion.
const EVENT_CLOCK=Object.freeze({kind:'clock-event'}),SOURCE_CLOCK=Object.freeze({kind:'clock-source'});
const clone=value=>JSON.parse(JSON.stringify(value));
const session=()=>({cookies:[{name:'campus',value:'synthetic-cookie',domain:'campus.placements.iitb.ac.in',path:'/',expires:-1,secure:true,httpOnly:true,sameSite:'Lax'}],origins:[]});
const article='<article id="post-501"><h2><a href="?p=501">Synthetic announcement</a></h2><time datetime="2026-10-12T12:00:00+05:30">12 October</time><p>A complete fixture announcement.</p></article>';

function harness(options={}) {
  let now=NOW,locked=false,nonce=0,created=0,deleted=0,sourceReads=0,identityReads=0,configurationReads=0,executionReads=0,notifications=0;
  let triggers=[],effectiveOwner=options.effectiveOwner===undefined?OWNER:options.effectiveOwner,activeOwner=options.activeOwner===undefined?'':options.activeOwner;
  let mode=options.mode || 'success',metadataFailure=options.metadataFailure || null;
  const properties=new Map([['BRIDGE_SECRET',SECRET]]);
  const values={CONFIG_FILE_ID:{recipient_email:OWNER,calendar_id:OWNER,timezone:'Asia/Kolkata',baseline_cutoff:'2026-10-11T10:25:30+05:30'},STATE_FILE_ID:{posts:{},meetings:{},deliveries:[],pending:[],last_successful_check:null,last_error:null},SESSION_FILE_ID:{session:session(),verified_at:new Date(NOW).toISOString(),cloud_source_verification:null}};
  const props={getProperty:key=>properties.get(key)||null,getProperties:()=>Object.fromEntries(properties),deleteProperty:key=>properties.delete(key),setProperty(key,value) {
    if(key==='MONITOR_INSTALLATION_JSON' && metadataFailure==='throw')throw new Error('Synthetic storage failure');
    properties.set(key,key==='MONITOR_INSTALLATION_JSON' && metadataFailure==='corrupt'?'{}':value);return props;
  }};
  const lock={tryLock(){assert.equal(locked,false,'Nested ScriptLock acquisition');locked=true;return true;},waitLock(){assert.equal(locked,false,'Nested ScriptLock acquisition');locked=true;},releaseLock(){assert.equal(locked,true);locked=false;}};
  class ClockDate extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const trigger=(id,handler='runCheck',event=EVENT_CLOCK,source=SOURCE_CLOCK)=>({getUniqueId:()=>id,getHandlerFunction:()=>handler,getEventType:()=>event,getTriggerSource:()=>source});
  const context=vm.createContext({Date:ClockDate,PropertiesService:{getScriptProperties:()=>props},LockService:{getScriptLock:()=>lock},
    Session:{getActiveUser:()=>({getEmail:()=>activeOwner}),getEffectiveUser(){executionReads++;return {getEmail:()=>effectiveOwner};}},
    Gmail:{Users:{getProfile(){identityReads++;return {emailAddress:OWNER};}}},Calendar:{CalendarList:{get:()=>({id:OWNER,accessRole:'owner'})}},
    ContentService:{MimeType:{JSON:'JSON',TEXT:'TEXT'},createTextOutput:value=>({value,setMimeType(){return this;}})},
    Utilities:{Charset:{UTF_8:'UTF-8'},DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(_algorithm,value)=>[...createHash('sha256').update(value).digest()],computeHmacSha256Signature:(value,key)=>[...createHmac('sha256',key).update(value).digest()]},
    ScriptApp:{EventType:{CLOCK:EVENT_CLOCK},TriggerSource:{CLOCK:SOURCE_CLOCK},getProjectTriggers:()=>triggers.slice(),newTrigger(handler){assert.equal(handler,'runCheck');let minutes=null;const builder={timeBased(){return builder;},everyMinutes(value){assert.ok([5,30].includes(value));minutes=value;return builder;},create(){assert.ok([5,30].includes(minutes));const item=trigger('fixture-'+(++created));triggers.push(item);return item;}};return builder;},deleteTrigger(item){deleted++;triggers=triggers.filter(t=>t!==item);}},
    UrlFetchApp:{fetch(url,request){sourceReads++;assert.equal(url,BLOG);assert.equal(request.method,'get');assert.match(request.headers.Cookie,/campus=synthetic-cookie/);now+=100;
      const status=mode==='source_failure'?401:200;
      const text=mode==='source_failure'?'<h1>Unauthorized</h1>':article;
      return {getResponseCode:()=>status,getAllHeaders:()=>({'Content-Type':'text/html; charset=UTF-8'}),getContentText:()=>text,getContent:()=>Buffer.from(text)};
    }}
  });
  files.forEach((file,index)=>vm.runInContext(file,context,{filename:['Bridge.gs','Source.gs'][index]}));
  context.privateRead_=name=>clone(values[name]);
  context.privateWrite_=(name,value)=>{values[name]=clone(value);};
  const loadConfiguration=context.loadConfiguration_;
  context.loadConfiguration_=()=>{configurationReads++;return loadConfiguration();};
  context.notifyFailureOnce_=(state)=>{if(!state.failure){notifications++;state.failure={kind:'source_check_failed'};context.saveState_(state);}};
  context.ingestSnapshot_=(snapshot)=>{
    assert.equal(snapshot.source_url,BLOG);assert.equal(snapshot.complete,true);assert.equal(snapshot.posts.length,1);
    if(mode==='delivery_failure')throw new Error('Synthetic delivery failure');
    if(snapshot.session)context.saveSession_(snapshot.session,snapshot.observed_at);
    const state=context.loadState_();state.last_successful_check=snapshot.observed_at;state.last_error=null;
    if(mode==='unresolved_email')state.email_attempt={reference:'synthetic-reference'};
    if(mode==='unresolved_calendar')state.pending=[{calendar_complete:false}];
    context.saveState_(state);
    return {ok:true,needs_attention:mode==='result_attention',last_successful_check:snapshot.observed_at};
  };
  function envelope(action,payload={}) {
    const body={action,nonce:(++nonce).toString(16).padStart(32,'0'),issued_at:Math.floor(now/1000),payload};
    body.signature=createHmac('sha256',SECRET).update(JSON.stringify([body.action,body.nonce,body.issued_at,body.payload])).digest('hex');return body;
  }
  const post=body=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(body)}}).value);
  return {context,values,properties,envelope,post,call:(action,payload)=>post(envelope(action,payload)),trigger,
    setMode:value=>{mode=value;},advance:value=>{now+=value;},setTriggers:value=>{triggers=value;},get triggers(){return triggers;},
    stats:()=>({created,deleted,sourceReads,identityReads,configurationReads,executionReads,notifications,locked}),
    knowTrigger(item,interval=30){properties.set('MONITOR_INSTALLATION_JSON',JSON.stringify({version:1,trigger_id:item.getUniqueId(),handler:'runCheck',interval_minutes:interval,owner:OWNER}));}};
}

test('Only the allowlisted valid fresh HMAC can reach activation identity or source checks',()=>{
  const h=harness();
  assert.equal(h.call('delete_every_trigger').error,'invalid_request');
  const bad=h.envelope('install_monitor');bad.signature='0'.repeat(64);
  assert.equal(h.post(bad).error,'authentication_failed');
  const expired=h.envelope('install_monitor');expired.issued_at-=301;
  expired.signature=createHmac('sha256',SECRET).update(JSON.stringify([expired.action,expired.nonce,expired.issued_at,expired.payload])).digest('hex');
  assert.equal(h.post(expired).error,'expired_request');
  assert.deepEqual(h.stats(),{created:0,deleted:0,sourceReads:0,identityReads:0,configurationReads:0,executionReads:0,notifications:0,locked:false});
  assert.equal(h.call('install_monitor',{interval_minutes:5}).error,'invalid_payload');
  assert.equal(h.stats().executionReads,0);assert.equal(h.stats().sourceReads,0);
  const valid=h.envelope('status');assert.equal(h.post(valid).ok,true);assert.equal(h.post(valid).error,'replayed_request');
});

test('Connection diagnostics require authenticated ownership and reveal only bounded stage metadata',()=>{
  const h=harness();
  h.properties.set('SOURCE_CONNECTION_TRACE',JSON.stringify({observed_at:new Date(NOW).toISOString(),secret:'never-return',steps:[
    {stage:'placement_renewal',status:302,cookie_present:true,url:'https://example.test/?code=never-return',cookies:'never-return'},
    {stage:'sso',status:200,cookie_present:false},
    {stage:'https://secret.example.test',status:200,cookie_present:true}
  ]}));
  const forged=h.envelope('connection_diagnostics');forged.signature='0'.repeat(64);
  assert.equal(h.post(forged).error,'authentication_failed');
  assert.equal(h.call('connection_diagnostics',{url:'https://example.test'}).error,'invalid_payload');
  const result=h.call('connection_diagnostics');
  assert.deepEqual(result,{ok:true,observed_at:new Date(NOW).toISOString(),steps:[{stage:'placement_renewal',status:302,cookie_present:true},{stage:'sso',status:200,cookie_present:false}]});
  assert.doesNotMatch(JSON.stringify(result),/never-return|secret/);
  assert.equal(h.stats().sourceReads,0);assert.equal(h.stats().created,0);
  const wrong=harness({effectiveOwner:'other@example.test'});
  assert.equal(wrong.call('connection_diagnostics').error,'wrong_account');
});

test('Signed activation verifies the execution owner; manual active-owner requirement stays intact',()=>{
  for(const effectiveOwner of ['', 'other@example.test']) {
    const h=harness({effectiveOwner});assert.equal(h.call('install_monitor').error,'wrong_account');assert.equal(h.stats().sourceReads,0);assert.equal(h.triggers.length,0);
    assert.equal(h.stats().configurationReads,1);assert.equal(h.stats().executionReads,1);
  }
  const webapp=harness();assert.throws(()=>webapp.context.installMonitor(),/wrong_account/);
  assert.equal(webapp.call('install_monitor').installed,true);
  const editor=harness({activeOwner:OWNER});assert.equal(editor.context.installMonitor().installed,true);
  const invalidConfiguration=harness();invalidConfiguration.values.CONFIG_FILE_ID.recipient_email='other@example.test';
  assert.equal(invalidConfiguration.call('install_monitor').error,'wrong_account');assert.equal(invalidConfiguration.stats().executionReads,0);assert.equal(invalidConfiguration.stats().sourceReads,0);
});

test('Cloud failures and unfinished native delivery cannot create a schedule, and source alerts stay deduplicated',()=>{
  for(const mode of ['source_failure','delivery_failure','unresolved_email','unresolved_calendar','result_attention']) {
    const h=harness({mode});const result=h.call('install_monitor');assert.equal(result.ok,false,mode);assert.equal(h.stats().created,0,mode);assert.equal(h.triggers.length,0,mode);
    assert.equal(result.error,mode==='source_failure'?'source_connection_required':'delivery_needs_review',mode);
    assert.equal(h.stats().locked,false);
    const status=h.call('status');assert.equal(status.monitor_installed,false);assert.equal(status.monitor_interval_minutes,null);
    assert.equal(status.cloud_source_verified_at===null,mode==='source_failure');
    if(mode==='source_failure') {
      h.call('install_monitor');assert.equal(h.stats().notifications,1);assert.equal(status.last_error,'source_check_failed');
      h.setMode('success');assert.equal(h.call('install_monitor').installed,true);assert.equal(h.values.STATE_FILE_ID.failure,null);
    }
  }
  const account=harness(),loadConfiguration=account.context.loadConfiguration_;let loads=0;
  account.values.STATE_FILE_ID.last_error='source_check_failed';
  account.context.loadConfiguration_=()=>{if(++loads===2)throw new Error('Synthetic account validation failure');return loadConfiguration();};
  assert.equal(account.call('install_monitor').error,'operation_failed');assert.equal(account.stats().created,0);assert.equal(account.stats().sourceReads,0);
  const unknown=harness();unknown.values.STATE_FILE_ID.last_error='private-provider-text';unknown.context.runCheckUnlocked_=()=>({ok:false,error:'check_failed',failure_phase:'delivery'});
  assert.deepEqual(unknown.call('install_monitor'),{ok:false,error:'operation_failed'});assert.equal(unknown.stats().created,0);
});

test('Successful activation reads the whole cloud source and is idempotent only for a proven 5-minute CLOCK trigger',()=>{
  const h=harness(),first=h.call('install_monitor');
  assert.deepEqual(Object.keys(first).sort(),['cloud_source_verified_at','installed','interval_minutes','last_cloud_source_check','ok']);
  assert.equal(first.ok,true);assert.equal(first.installed,true);assert.equal(first.interval_minutes,5);
  assert.equal(first.cloud_source_verified_at,new Date(NOW+100).toISOString());assert.equal(h.stats().sourceReads,1);assert.equal(h.stats().created,1);
  h.advance(1000);const second=h.call('install_monitor');assert.equal(second.installed,true);assert.equal(h.stats().created,1);assert.equal(h.stats().sourceReads,2);
  assert.ok(Date.parse(second.cloud_source_verified_at)>Date.parse(first.cloud_source_verified_at));
  const status=h.call('status');assert.equal(status.monitor_installed,true);assert.equal(status.interval_minutes,5);assert.equal(status.monitor_interval_minutes,5);assert.equal(status.session_status,'cloud_verified');
  assert.equal(JSON.stringify(status).includes('synthetic-cookie'),false);assert.equal(JSON.stringify(first).includes('fixture-'),false);
  h.values.STATE_FILE_ID.last_error='provider-private-details';const sanitized=h.call('status');assert.equal(sanitized.last_error,'operation_failed');assert.equal(sanitized.needs_attention,true);assert.equal(JSON.stringify(sanitized).includes('provider-private-details'),false);h.values.STATE_FILE_ID.last_error=null;
  h.setTriggers([h.triggers[0],h.trigger('duplicate')]);const duplicate=h.call('install_monitor');assert.equal(duplicate.error,'duplicate_monitor_triggers');assert.equal(h.stats().sourceReads,2);
  assert.equal(h.call('status').monitor_installed,false);assert.equal(h.call('status').needs_attention,true);
});

test('Unknown intervals, IDs, event types, and trigger sources never count as an installation',()=>{
  for(const kind of ['unknown','different_id','wrong_interval','wrong_event','wrong_source']) {
    const h=harness(),item=h.trigger('existing','runCheck',kind==='wrong_event'?'ON_OPEN':EVENT_CLOCK,kind==='wrong_source'?'SPREADSHEETS':SOURCE_CLOCK);h.setTriggers([item]);
    if(kind!=='unknown')h.knowTrigger(kind==='different_id'?h.trigger('not-existing'):item,kind==='wrong_interval'?10:30);
    assert.equal(h.call('install_monitor').error,'monitor_verification_required',kind);assert.equal(h.stats().created,0);assert.equal(h.stats().sourceReads,0);
    assert.equal(h.call('status').monitor_installed,false);assert.equal(h.call('status').monitor_interval_minutes,null);
  }
});

test('A new trigger is removed if its private metadata cannot be persisted or verified',()=>{
  for(const metadataFailure of ['throw','corrupt']) {
    const h=harness({metadataFailure});assert.equal(h.call('install_monitor').ok,false);assert.equal(h.stats().created,1);assert.equal(h.stats().deleted,1);assert.equal(h.triggers.length,0);
    assert.equal(h.call('status').monitor_installed,false);assert.equal(h.call('status').monitor_interval_minutes,null);
  }
});

test('A replacement browser session atomically invalidates cloud proof, while source cookie renewal keeps fresh proof',()=>{
  const h=harness();assert.equal(h.call('install_monitor').installed,true);
  const oldProof=h.call('status').cloud_source_verified_at;h.advance(1000);
  const replacement=session();replacement.cookies[0].value='replacement-cookie';
  assert.equal(h.call('save_session',{source_url:BLOG,session:replacement,verified_at:new Date(NOW+1100).toISOString()}).connected,true);
  const saved=h.call('status');assert.equal(saved.cloud_source_verified_at,null);assert.equal(saved.last_cloud_source_check,null);assert.equal(saved.session_status,'saved_not_live_verified');assert.equal(saved.monitor_installed,true);
  assert.equal(h.call('get_session').session.cookies[0].value,'replacement-cookie');
  h.values.SESSION_FILE_ID.session=session(); // Substitute only synthetic source credentials.
  assert.equal(h.call('install_monitor').installed,true);assert.equal(h.stats().created,1);
  assert.ok(Date.parse(h.call('status').cloud_source_verified_at)>Date.parse(oldProof));
  // Manual ingestion's successful timestamp cannot establish cloud provenance.
  h.context.saveSession_(session(),new Date(NOW+1200).toISOString());
  h.call('ingest_snapshot',{source_url:BLOG,complete:true,observed_at:new Date(NOW+1200).toISOString(),posts:[{}]});
  assert.equal(h.call('status').cloud_source_verified_at,null);
});

test('Even an apparent successful reader result cannot reuse historical or stale cloud proof',()=>{
  for(const delta of [-1,-11*60000,11*60000]) {
    const h=harness();h.values.SESSION_FILE_ID.cloud_source_verification={source_url:BLOG,complete:true,verifier:'apps_script_https',observed_at:new Date(NOW+delta).toISOString()};
    h.context.readPlacementSource_=()=>({source_url:BLOG,complete:true,observed_at:new Date(NOW).toISOString(),posts:[{}]});
    assert.equal(h.call('install_monitor').error,'source_connection_required');assert.equal(h.stats().created,0);
  }
});

test('Authenticated cadence migration retains outage and delivery history and replaces only the recorded legacy trigger',()=>{
  const h=harness({mode:'source_failure'}),old=h.trigger('legacy');h.setTriggers([old]);h.knowTrigger(old,30);
  h.values.STATE_FILE_ID.last_error='source_check_failed';
  h.values.STATE_FILE_ID.deliveries=[{email_id:'already-sent'}];
  const forged=h.envelope('configure_monitor',{interval_minutes:5});forged.signature='0'.repeat(64);
  assert.equal(h.post(forged).error,'authentication_failed');assert.equal(h.stats().created,0);
  for(const payload of [{},{interval_minutes:1},{interval_minutes:30},{interval_minutes:5,url:BLOG}]) {
    assert.equal(h.call('configure_monitor',payload).error,'invalid_payload');
  }
  assert.deepEqual(h.call('configure_monitor',{interval_minutes:5}),{ok:true,monitor_installed:true,monitor_interval_minutes:5});
  assert.equal(h.stats().created,1);assert.equal(h.stats().deleted,1);assert.equal(h.stats().sourceReads,0);
  assert.deepEqual(h.values.STATE_FILE_ID.deliveries,[{email_id:'already-sent'}]);
  const status=h.call('status');assert.equal(status.monitor_interval_minutes,5);assert.equal(status.needs_attention,true);assert.equal(status.last_error,'source_check_failed');
  assert.equal(h.call('configure_monitor',{interval_minutes:5}).ok,true);assert.equal(h.stats().created,1);
  const fresh=harness();assert.equal(fresh.call('configure_monitor',{interval_minutes:5}).error,'monitor_verification_required');assert.equal(fresh.stats().created,0);
  const other=harness({effectiveOwner:'other@example.test'});assert.equal(other.call('configure_monitor',{interval_minutes:5}).error,'wrong_account');
});

test('Cadence replacement rolls back before removing the legacy trigger if metadata persistence fails',()=>{
  for(const metadataFailure of ['throw','corrupt']) {
    const h=harness({metadataFailure}),old=h.trigger('legacy');h.setTriggers([old]);
    h.properties.set('MONITOR_INSTALLATION_JSON',JSON.stringify({version:1,trigger_id:'legacy',handler:'runCheck',interval_minutes:30,owner:OWNER}));
    assert.equal(h.call('configure_monitor',{interval_minutes:5}).ok,false);
    assert.deepEqual(h.triggers,[old]);assert.equal(h.stats().created,1);assert.equal(h.stats().deleted,1);
  }
});

test('Local network mode requires a fresh signed complete snapshot and never substitutes it for cloud proof',()=>{
 const h=harness();h.call('install_monitor');
 assert.equal(h.call('configure_source',{mode:'local_https'}).error,'source_connection_required');
 assert.equal(h.call('configure_source',{mode:'some_other_host'}).error,'invalid_payload');
 const payload={source_url:BLOG,complete:true,posts:[{}],observed_at:new Date(NOW+100).toISOString(),session:session()};
 const forged=h.envelope('ingest_local_snapshot',payload);forged.signature='0'.repeat(64);assert.equal(h.post(forged).error,'authentication_failed');
 assert.equal(h.call('ingest_local_snapshot',payload).ok,true);assert.equal(h.call('source_status').mode,'google_https');
 assert.equal(h.call('status').cloud_source_verified_at,null);
 assert.equal(h.call('configure_source',{mode:'local_https'}).mode,'local_https');
 const reads=h.stats().sourceReads;h.setMode('source_failure');assert.equal(h.context.runCheck().ok,true);assert.equal(h.stats().sourceReads,reads);
 h.advance(16*60000);assert.equal(h.call('source_status').local_source_fresh,false);assert.equal(h.context.runCheck().ok,false);assert.equal(h.stats().notifications,1);assert.equal(h.stats().sourceReads,reads);
});

test('Direct cloud probe verifies the full source without delivery, mode changes, arbitrary URLs or private response data',()=>{
 const h=harness();const bad=h.envelope('probe_cloud_source');bad.signature='0'.repeat(64);assert.equal(h.post(bad).error,'authentication_failed');
 assert.equal(h.call('probe_cloud_source',{url:BLOG}).error,'invalid_payload');assert.equal(h.stats().sourceReads,0);
 h.properties.set('PLACEMENT_SOURCE_MODE','local_https');const result=h.call('probe_cloud_source');
 assert.equal(result.reachable,true);assert.equal(result.post_count,1);assert.ok(result.cloud_source_verified_at);assert.equal(h.call('source_status').mode,'local_https');assert.equal(h.values.STATE_FILE_ID.last_successful_check,null);assert.equal(h.stats().created,0);assert.equal(h.stats().notifications,0);
 assert.doesNotMatch(JSON.stringify(result),/synthetic-cookie|posts|session|source_url/);
 h.context.readPlacementSource_=()=>{const e=new Error('Private error must not leak');e.placementFailureReason='network_address_unavailable';throw e;};
 assert.deepEqual(h.call('probe_cloud_source'),{ok:true,reachable:false,reason:'network_address_unavailable',observed_at:new Date(NOW+100).toISOString()});
 const wrong=harness({effectiveOwner:'other@example.test'});assert.equal(wrong.call('probe_cloud_source').error,'wrong_account');
});
test('Returning to Google reading requires recent complete cloud proof and preserves the existing schedule',()=>{
 const h=harness();h.call('install_monitor');h.properties.set('PLACEMENT_SOURCE_MODE','local_https');
 assert.equal(h.call('configure_source',{mode:'google_https'}).mode,'google_https');assert.equal(h.stats().created,1);
 h.properties.set('PLACEMENT_SOURCE_MODE','local_https');h.advance(11*60000);
 assert.equal(h.call('configure_source',{mode:'google_https'}).error,'source_connection_required');assert.equal(h.call('source_status').mode,'local_https');
});

test('Explicit cloud restoration moves only the recorded schedule and never reports stale access as working',()=>{
 const h=harness();h.call('install_monitor');h.properties.set('PLACEMENT_SOURCE_MODE','local_https');h.advance(11*60000);
 const before=clone(h.values.STATE_FILE_ID);const r=h.call('restore_cloud_monitor');
 assert.deepEqual(r,{ok:true,mode:'google_https',monitor_interval_minutes:5,source_verified:false,awaiting_cloud_read:true});assert.deepEqual(h.values.STATE_FILE_ID,before);assert.equal(h.stats().created,1);
 const missing=harness();assert.equal(missing.call('restore_cloud_monitor').error,'monitor_verification_required');
 const forged=h.envelope('restore_cloud_monitor');forged.signature='0'.repeat(64);assert.equal(h.post(forged).error,'authentication_failed');
});
test('Scheduled cloud outages back off without duplicate notices and resume five-minute checks after recovery',()=>{
 const h=harness();h.call('install_monitor');h.setMode('source_failure');assert.equal(h.context.runCheck().ok,false);const reads=h.stats().sourceReads;
 assert.equal(h.context.runCheck().error,'source_retry_wait');assert.equal(h.stats().sourceReads,reads);assert.equal(h.stats().notifications,1);
 h.advance(5*60000);assert.equal(h.context.runCheck().ok,false);assert.equal(h.context.cloudSourceRetry_().failures,2);assert.equal(h.stats().notifications,1);
 h.advance(10*60000);h.setMode('success');assert.equal(h.context.runCheck().ok,true);assert.equal(h.context.cloudSourceRetry_(),null);assert.equal(h.call('status').last_error,null);
});
