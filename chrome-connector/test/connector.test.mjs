import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {DOMParser} from 'linkedom';
import {BLOG,SSO_COOKIE_URL,PERMISSIONS,GOOGLE_PERMISSIONS,ConnectorError,validateConfig,canonical,signedRequest,bridgeCall,validateBridgeResult,verifyBlog,toSession,connect,checkActivation,revokePermissions} from '../core.mjs';
import {validTransportRequest,googleFetch} from '../google-fetch.mjs';

const NOW=Date.parse('2026-10-12T12:00:00Z');
const KEY='synthetic-test-key-never-used-with-a-provider';
const BRIDGE_URL='https://script.google.com/macros/s/SYNTHETIC_TEST_DEPLOYMENT/exec';
const RESULT_URL='https://script.googleusercontent.com/macros/echo?synthetic=test';
const HTML='<!doctype html><html><body><article id="post-900"><h2>Synthetic fixture notice</h2><time datetime="2026-10-12T12:00:00Z"></time><p>Fixture text only.</p></article></body></html>';
const parseHtml=html=>new DOMParser().parseFromString(html,'text/html');
const config=()=>({bridge_url:BRIDGE_URL,hmac_secret:KEY});
function response(text,{url=RESULT_URL,status=200,type='application/json'}={}) {
  const value=new Response(text,{status,headers:{'content-type':type}});
  Object.defineProperty(value,'url',{value:url});return value;
}
function cookie(extra={}) {
  return {name:'fixture_session',value:'synthetic',domain:'campus.placements.iitb.ac.in',path:'/',hostOnly:true,httpOnly:true,
    secure:true,session:true,sameSite:'lax',storeId:'0',...extra};
}
function groups(campus=[],sso=[]) {return [{url:BLOG,cookies:campus},{url:SSO_COOKIE_URL,cookies:sso}];}
function statusReply({installed=false,connected=true,proof=null,...extra}={}) {
  return {ok:true,connected,session_status:connected?'cloud_verified':'missing',session_verified_at:connected?new Date(NOW).toISOString():null,
    last_successful_check:proof,last_error:null,post_count:0,pending_count:0,meeting_count:0,delivery_count:0,
    monitor_installed:installed,needs_attention:false,cloud_source_verified_at:proof,last_cloud_source_check:proof,
    interval_minutes:installed?30:null,monitor_interval_minutes:installed?30:null,...extra};
}
function installReply(extra={}) {
  return {ok:true,installed:true,interval_minutes:30,cloud_source_verified_at:new Date(NOW).toISOString(),last_cloud_source_check:new Date(NOW).toISOString(),...extra};
}
function fixture({grant=true,bridgeOk=true,blogOk=true,rows=[cookie()],revoke=true,saveOk=true,incognito=false,installResult=null,installLost=false,saveLost=false,statusReplies=null}={}) {
  const events=[],bodies=[],raw=[];let active=false,requested=PERMISSIONS,saved=false,installed=false,statusIndex=0,elapsed=0;
  const chromeImpl={extension:{inIncognitoContext:incognito},permissions:{
    request:async request=>{events.push(request.permissions.length?'permissions':'google-permissions');requested=request;
      assert.deepEqual(request,request.permissions.length?{permissions:['cookies'],origins:[...PERMISSIONS.origins]}:{permissions:[],origins:[...GOOGLE_PERMISSIONS.origins]});active=grant;return grant;},
    remove:async()=>{events.push('revoke');if(revoke)active=false;return revoke;},
    getAll:async()=>({permissions:active?[...requested.permissions]:[],origins:active?[...requested.origins]:[]})
  },cookies:{getAll:async details=>{
    assert.deepEqual(details,{url:details.url,secure:true});assert.ok([BLOG,SSO_COOKIE_URL].includes(details.url));
    events.push(details.url===BLOG?'campus-cookies':'sso-cookies');
    const copies=details.url===BLOG?rows.map(item=>({...item})):[];raw.push(...copies);return copies;
  }}};
  const fetchImpl=async(url,options)=>{
    if(url===BLOG){events.push('blog');assert.equal(options.credentials,'include');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.redirect,'error');
      return response(blogOk?HTML:'<!doctype html><h1>Sign in</h1>',{url:BLOG,status:blogOk?200:401,type:'text/html'});}
    assert.equal(url,BRIDGE_URL);assert.equal(options.credentials,'omit');
    const body=JSON.parse(options.body);bodies.push(body);events.push(body.action);
    assert.equal(body.signature,createHmac('sha256',KEY).update(canonical(body.action,body.nonce,body.issued_at,body.payload)).digest('hex'));
    if(body.action==='status') {
      const result=!bridgeOk?{ok:false,error:'authentication_failed'}:statusReplies?statusReplies[Math.min(statusIndex,statusReplies.length-1)]:statusReply({installed,connected:saved,proof:installed?new Date(NOW).toISOString():null});
      statusIndex++;if(result.error==='busy')elapsed+=Math.min(options.timeoutMs,10000);return response(JSON.stringify(result));
    }
    if(body.action==='save_session') {
      saved=saveOk;
      if(saveLost)throw new Error('synthetic save response lost');
      return response(JSON.stringify(saveOk?{ok:true,connected:true}:{ok:false,error:'operation_failed'}));
    }
    assert.equal(body.action,'install_monitor');assert.deepEqual(body.payload,{});installed=true;
    if(installLost){elapsed+=options.timeoutMs;throw new Error('synthetic installation response lost');}
    return response(JSON.stringify(installResult || installReply()));
  };
  return {events,bodies,raw,deps:{chromeImpl,fetchImpl,cryptoImpl:webcrypto,now:()=>NOW,parseHtml,monotonicNow:()=>elapsed,waitImpl:async ms=>{elapsed+=ms;}},elapsed:()=>elapsed};
}

test('HMAC envelope matches the deployed canonical protocol and URL validation rejects arbitrary destinations',async()=>{
  const envelope=await signedRequest('status',{},KEY,{cryptoImpl:webcrypto,now:()=>NOW});
  assert.match(envelope.nonce,/^[a-f\d]{32}$/);assert.equal(envelope.issued_at,NOW/1000);
  assert.equal(envelope.signature,createHmac('sha256',KEY).update(JSON.stringify(['status',envelope.nonce,envelope.issued_at,{}])).digest('hex'));
  assert.deepEqual(validateConfig(config()),config());
  for(const url of ['http://script.google.com/macros/s/test/exec','https://evil.invalid/exec',BRIDGE_URL+'?key=x',BRIDGE_URL+'#x','https://script.google.com@evil.invalid/exec'])
    assert.throws(()=>validateConfig({bridge_url:url,hmac_secret:KEY}),ConnectorError);
  assert.throws(()=>canonical('get_session',envelope.nonce,envelope.issued_at,{}),ConnectorError);
});

test('only URL-matching Secure official cookies map to the empty-origin session with proper scope and deduplication',()=>{
  const parent=cookie({name:'fixture_shared',domain:'.iitb.ac.in',hostOnly:false,sameSite:'no_restriction'});
  const sso=cookie({domain:'.sso.iitb.ac.in',hostOnly:false,name:'fixture_remember',sameSite:'strict',session:false,expirationDate:NOW/1000+60});
  const expired=cookie({name:'expired_fixture',session:false,expirationDate:NOW/1000-1});
  const ignored=cookie({secure:false});
  const session=toSession(groups([cookie(),parent,expired,ignored],[parent,sso]),NOW);
  assert.equal(session.cookies.length,3);assert.deepEqual(session.origins,[]);
  assert.deepEqual(session.cookies.map(item=>item.sameSite),['Lax','None','Strict']);
  assert.deepEqual(session.cookies.map(item=>item.domain),['campus.placements.iitb.ac.in','.iitb.ac.in','.sso.iitb.ac.in']);
  assert.equal(session.cookies[0].expires,-1);assert.equal(session.cookies[2].expires,NOW/1000+60);
  assert.ok(session.cookies.every(item=>!Object.hasOwn(item,'storeId')&&!Object.hasOwn(item,'hostOnly')));
});

test('unsafe, partitioned, oversized, mismatched-path, and changed cookie snapshots are rejected',()=>{
  for(const bad of [
    {partitionKey:{topLevelSite:'https://iitb.ac.in'}},{path:'/unrelated'}, {name:'bad;name'}, {value:'with space'},
    {value:'x'.repeat(4097)}, {path:'/'+ 'x'.repeat(1024)}, {sameSite:'unknown'}, {hostOnly:true,domain:'.iitb.ac.in'},
    {httpOnly:'true'}, {session:false,expirationDate:undefined}
  ]) assert.throws(()=>toSession(groups([cookie(bad)]),NOW),ConnectorError);
  assert.throws(()=>toSession(groups(Array.from({length:65},(_,index)=>cookie({name:'fixture_'+index}))),NOW),error=>error.code==='SESSION_TOO_LARGE');
  assert.throws(()=>toSession(groups([cookie({domain:'.iitb.ac.in',hostOnly:false})],[cookie({domain:'.iitb.ac.in',hostOnly:false,value:'changed'})]),NOW),error=>error.code==='SESSION_CHANGED');
  assert.throws(()=>toSession(groups([cookie({domain:'iitb.ac.in',hostOnly:true})]),NOW),error=>error.code==='SESSION_REQUIRED');
});

test('blog gate requires a fresh fixed-URL HTML 200 containing parsed announcement articles',async()=>{
  for(const item of [
    {text:HTML,url:'https://sso.iitb.ac.in/login'}, {text:HTML,url:BLOG,status:401},
    {text:'<h1>Login</h1>',url:BLOG}, {text:'<article id="post-fake"><h2>Fixture</h2></article>',url:BLOG},
    {text:HTML,url:BLOG,type:'text/plain'}
  ]) await assert.rejects(verifyBlog({fetchImpl:async()=>response(item.text,{url:item.url,status:item.status||200,type:item.type||'text/html'}),parseHtml}),error=>error.code==='BLOG_NOT_ACCESSIBLE');
  await assert.rejects(verifyBlog({fetchImpl:async()=>response('x'.repeat(2000001),{url:BLOG,type:'text/html'}),parseHtml}),error=>error.code==='BLOG_NOT_ACCESSIBLE');
  assert.deepEqual(await verifyBlog({fetchImpl:async()=>response(HTML,{url:BLOG,type:'text/html'}),parseHtml}),{verified:true});
});

test('Connect verifies missing-session backend status then blog, saves once before install, confirms real cloud activation, and revokes',async()=>{
  const f=fixture(),input=config();const pending=connect(input,f.deps);
  assert.deepEqual(f.events,['permissions']);
  const result=await pending;
  assert.deepEqual(f.events,['permissions','status','blog','campus-cookies','sso-cookies','save_session','install_monitor','revoke']);
  assert.deepEqual(result,{saved:true,source_verified_in_chrome:true,activated:true,cloud_verified:true,interval_minutes:30,
    cloud_source_verified_at:new Date(NOW).toISOString(),cookie_count:1,permissions_revoked:true});
  assert.deepEqual(Object.keys(f.bodies[1].payload),['source_url','session','verified_at']);
  assert.equal(f.bodies[1].payload.source_url,BLOG);assert.deepEqual(f.bodies[1].payload.session.origins,[]);
  assert.equal(input.hmac_secret,'');assert.ok(f.raw.every(item=>item.value===''));
  assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal(Object.hasOwn(result,'private_metadata'),false);
});

test('permission denial or failed bridge/blog validation reads no cookies, sends no session, and still revokes',async()=>{
  for(const options of [{grant:false},{bridgeOk:false},{blogOk:false},{incognito:true}]) {
    const f=fixture(options);await assert.rejects(connect(config(),f.deps),ConnectorError);
    assert.equal(f.events.at(-1),'revoke');assert.equal(f.events.includes('campus-cookies'),false);assert.equal(f.events.includes('save_session'),false);
  }
});

test('failed save wipes cookie values and revokes; failed revocation explicitly requires removing the extension',async()=>{
  const failed=fixture({saveOk:false});await assert.rejects(connect(config(),failed.deps),error=>error.code==='BRIDGE_REJECTED');
  assert.ok(failed.raw.every(item=>item.value===''));assert.equal(failed.events.at(-1),'revoke');
  const unsafe=fixture({revoke:false});await assert.rejects(connect(config(),unsafe.deps),error=>error.code==='REMOVE_EXTENSION_REQUIRED');
  const f=fixture();assert.equal(await revokePermissions(f.deps.chromeImpl),true);
});

test('bridge replies require authenticated success and expected Google final response URL without exposing provider errors',async()=>{
  const common={cryptoImpl:webcrypto,now:()=>NOW};
  for(const item of [
    {text:'{"ok":false,"error":"private provider exception"}'}, {text:'not JSON'},
    {text:'{"ok":true}',url:'https://evil.invalid/macros/echo'}, {text:'{"ok":true}',url:'https://script.googleusercontent.com/unexpected'},
    {text:'x'.repeat(1500001)}
  ]) await assert.rejects(bridgeCall(config(),'status',{}, {...common,fetchImpl:async()=>response(item.text,{url:item.url||RESULT_URL})}),error=>error instanceof ConnectorError&&!error.message.includes('private provider'));
  await assert.rejects(bridgeCall(config(),'status',{}, {...common,fetchImpl:async()=>response(JSON.stringify({...statusReply(),email:'synthetic@example.invalid'}))}),error=>error.code==='BRIDGE_INVALID_RESPONSE');
  const missing=statusReply({connected:false});
  assert.deepEqual(await bridgeCall(config(),'status',{}, {...common,fetchImpl:async()=>response(JSON.stringify(missing))}),
    {ok:true,monitor_installed:false,monitor_interval_minutes:null,connected:false,healthy:false,needs_attention:false,last_error:null,session_verified_at:null,cloud_source_verified_at:null});
});

test('known cloud source or schedule failures never report activated and permit a deliberate reconnect retry',async()=>{
  for(const [error,code] of [['source_connection_required','CLOUD_SOURCE_UNAVAILABLE'],['monitor_verification_required','MONITOR_CONFIGURATION_REQUIRED'],['delivery_needs_review','DELIVERY_REVIEW_REQUIRED']]) {
    const f=fixture({installResult:{ok:false,error}});
    await assert.rejects(connect(config(),f.deps),result=>result.code===code&&!Object.hasOwn(result,'activationNotBefore'));
    assert.equal(f.events.at(-1),'revoke');assert.equal(f.bodies.filter(body=>body.action==='install_monitor').length,1);
    assert.ok(f.raw.every(row=>row.value===''));
  }
});

test('uncertain install is established by fresh healthy signed status without resaving cookies or repeating installation',async()=>{
  const f=fixture({installLost:true});const result=await connect(config(),f.deps);
  assert.equal(result.activated,true);assert.equal(result.cloud_verified,true);
  assert.equal(f.bodies.filter(body=>body.action==='save_session').length,1);assert.equal(f.bodies.filter(body=>body.action==='install_monitor').length,1);
  assert.equal(f.bodies.filter(body=>body.action==='status').length,2);assert.equal(f.events.at(-1),'revoke');assert.ok(f.elapsed()<=90000);
});

test('busy installation remains explicitly uncertain and all recovery requests fit the 90-second activation window',async()=>{
  const f=fixture({installLost:true,statusReplies:[statusReply({connected:false}),{ok:false,error:'busy'}]});
  await assert.rejects(connect(config(),f.deps),error=>error.code==='ACTIVATION_UNCONFIRMED'&&error.activationNotBefore===new Date(NOW).toISOString());
  assert.ok(f.elapsed()<=90000);assert.equal(f.events.at(-1),'revoke');
  assert.equal(f.bodies.filter(body=>body.action==='install_monitor').length,1);
  assert.equal(f.bodies.filter(body=>body.action==='save_session').length,1);
});

test('malformed lost install result falls through strictly validated status without trusting unknown metadata',async()=>{
  const f=fixture({installResult:{...installReply(),session:{cookies:['synthetic']}}});
  assert.throws(()=>validateBridgeResult('install_monitor',{...installReply(),session:{}},NOW),error=>error.code==='BRIDGE_INVALID_RESPONSE');
  const result=await connect(config(),f.deps);assert.equal(result.activated,true);
  assert.equal(f.bodies.filter(body=>body.action==='install_monitor').length,1);
  assert.equal(f.bodies.filter(body=>body.action==='status').length,2);
});

test('recovery refuses old proof, future proof, expired session, attention and source/calendar/delivery errors',async()=>{
  const fresh=new Date(NOW).toISOString(),old=new Date(NOW-300000).toISOString();
  for(const status of [
    statusReply({installed:true,proof:old}),statusReply({installed:true,proof:fresh,connected:false,session_status:'expired'}),
    statusReply({installed:true,proof:fresh,needs_attention:true}),statusReply({installed:true,proof:fresh,last_error:'source_check_failed'}),
    statusReply({installed:true,proof:fresh,last_error:'calendar_needs_review',needs_attention:true}),
    statusReply({installed:true,proof:fresh,last_error:'delivery_needs_review',needs_attention:true}),
    statusReply({installed:true,proof:new Date(NOW+61000).toISOString()})
  ]) {
    const f=fixture({installLost:true,statusReplies:[statusReply({connected:false}),status]});
    await assert.rejects(connect(config(),f.deps),ConnectorError);assert.equal(f.events.at(-1),'revoke');assert.ok(f.elapsed()<=90000);
  }
  const pending=fixture({installLost:true,statusReplies:[statusReply({connected:false}),statusReply()]});
  await assert.rejects(connect(config(),pending.deps),error=>error.code==='ACTIVATION_UNCONFIRMED'&&error.activationNotBefore===fresh);
  assert.equal(pending.bodies.filter(body=>body.action==='save_session').length,1);
});

test('Check activation asks for Google-only permissions, loads private configuration after gesture and only polls status',async()=>{
  const f=fixture({statusReplies:[statusReply({installed:true,proof:new Date(NOW).toISOString()})]});
  const pending=checkActivation(async()=>{assert.deepEqual(f.events,['google-permissions']);return config();},{...f.deps,notBefore:new Date(NOW).toISOString()});
  assert.deepEqual(f.events,['google-permissions']);
  assert.deepEqual(await pending,{activated:true,cloud_verified:true,interval_minutes:30,cloud_source_verified_at:new Date(NOW).toISOString(),permissions_revoked:true});
  assert.deepEqual(f.events,['google-permissions','status','revoke']);assert.equal(f.raw.length,0);
  assert.deepEqual(f.bodies.map(body=>body.action),['status']);
});

test('small status schema rejects unknown/session data, arbitrary errors and inconsistent intervals',()=>{
  for(const bad of [
    {extra:'unknown'}, {session:{}}, {last_error:'raw provider private error'}, {connected:'true'},
    {needs_attention:null}, {monitor_interval_minutes:15}, {interval_minutes:15}, {post_count:-1}
  ]) assert.throws(()=>validateBridgeResult('status',{...statusReply(),...bad},NOW),error=>error.code==='BRIDGE_INVALID_RESPONSE');
  const unhealthy=validateBridgeResult('status',statusReply({installed:true,proof:new Date(NOW).toISOString(),last_error:'calendar_needs_review',needs_attention:true}),NOW);
  assert.equal(unhealthy.healthy,false);assert.equal(unhealthy.last_error,'calendar_needs_review');
  assert.equal(Object.hasOwn(unhealthy,'post_count'),false);
});

test('a lost save response can be confirmed by exact signed storage timestamp, with no blind save retransmission',async()=>{
  const f=fixture({saveLost:true});assert.equal((await connect(config(),f.deps)).activated,true);
  assert.deepEqual(f.events,['permissions','status','blog','campus-cookies','sso-cookies','save_session','status','install_monitor','revoke']);
  assert.equal(f.bodies.filter(body=>body.action==='save_session').length,1);
  const unknown=fixture({saveLost:true,statusReplies:[statusReply({connected:false}),statusReply({connected:false})]});
  await assert.rejects(connect(config(),unknown.deps),error=>error.code==='SESSION_SAVE_UNCONFIRMED');
  assert.equal(unknown.events.includes('install_monitor'),false);assert.equal(unknown.events.at(-1),'revoke');
});

test('Google-only transport validates signed envelopes, omits Chrome credentials, and rejects arbitrary requests',async()=>{
  const body=JSON.stringify(await signedRequest('status',{},KEY,{cryptoImpl:webcrypto,now:()=>NOW}));
  assert.equal(validTransportRequest(BRIDGE_URL,body),true);assert.equal(validTransportRequest(BLOG,body),false);
  assert.equal(validTransportRequest(BRIDGE_URL,'{}'),false);assert.equal(validTransportRequest(BRIDGE_URL,body.replace('status','get_session')),false);
  await assert.rejects(googleFetch(BLOG,body,async()=>assert.fail('must never fetch')),ConnectorError);
  const reply=await googleFetch(BRIDGE_URL,body,async(url,options)=>{
    assert.equal(url,BRIDGE_URL);assert.equal(options.credentials,'omit');assert.equal(options.redirect,'follow');assert.equal(options.body,body);
    return response('{"ok":true}');
  });assert.equal(reply.url,RESULT_URL);assert.equal(reply.text,'{"ok":true}');
  await assert.rejects(googleFetch(BRIDGE_URL,body,async()=>response('{"ok":true}',{url:BLOG})),ConnectorError);
});

test('manifest has no automatic browser access and local transport CSP permits only Google connections',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(manifest.optional_permissions,['cookies']);assert.deepEqual(manifest.optional_host_permissions,[...PERMISSIONS.origins]);
  for(const forbidden of ['permissions','host_permissions','background','content_scripts','externally_connectable','web_accessible_resources']) assert.equal(Object.hasOwn(manifest,forbidden),false);
  assert.equal(manifest.incognito,'not_allowed');
  const transport=await readFile(new URL('../google-transport.html',import.meta.url),'utf8');
  const csp=new DOMParser().parseFromString(transport,'text/html').querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  assert.match(csp,/connect-src https:\/\/script\.google\.com https:\/\/script\.googleusercontent\.com;/);
  assert.equal(csp.includes('iitb'),false);
});

test('Five-minute cloud activation passes strict readback and reports the actual cadence',async()=>{
  assert.equal(validateBridgeResult('install_monitor',installReply({interval_minutes:5}),NOW).interval_minutes,5);
  const result=validateBridgeResult('status',statusReply({installed:true,interval_minutes:5,monitor_interval_minutes:5}),NOW);
  assert.equal(result.monitor_interval_minutes,5);
});

test('Local reconnection saves the approved session once, revokes access, and never claims Google source activation',async()=>{
 const f=fixture(),result=await connect({...config(),source_mode:'local_https'},f.deps);
 assert.equal(result.saved,true);assert.equal(result.activated,false);assert.equal(result.local_verification_pending,true);assert.equal(result.permissions_revoked,true);
 assert.equal(f.bodies.some(b=>b.action==='install_monitor'),false);
});
