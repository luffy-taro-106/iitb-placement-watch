import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID} from 'node:crypto';
import vm from 'node:vm';

const source=await readFile(new URL('WhatsApp.gs',import.meta.url),'utf8');
const BLOG='https://campus.placements.iitb.ac.in/blog/placement/';
const clone=x=>JSON.parse(JSON.stringify(x));
const configuration=()=>({recipient_email:'owner@example.test',whatsapp:{enabled:true,relay_url:'https://fixture.onrender.com/v1',relay_secret:'a'.repeat(64),activated_at:'2026-10-13T12:00:00Z'}});
const post=()=>({id:'post-42',fingerprint:'b'.repeat(64),title:'Sony Japan | JAF Open',text:'Deadline: 14 October, 11:59 PM IST',published:'2026-10-13T12:05:00Z',url:BLOG+'?p=42',links:[{text:'Join meeting',url:'https://meet.google.com/abc-defg-hij'}]});
function harness(){
  let data={posts:{retained:'native-mail-id'},pending:[]},calls=[],mode='good';
  const context=vm.createContext({Date,Array,JSON,Number,Object,isFinite,requireObject_:x=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('invalid_payload');},fail_:code=>{throw Error(code);},
    hex_:bytes=>Buffer.from(bytes).toString('hex'),Utilities:{getUuid:randomUUID,Charset:{UTF_8:'UTF-8'},computeHmacSha256Signature:(text,key)=>[...createHmac('sha256',key).update(text).digest()]},
    loadState_:()=>clone(data),saveState_:value=>{data=clone(value);},privateWrite_:(key,value)=>calls.push({key,value:clone(value)}),
    UrlFetchApp:{fetch(url,options){const body=JSON.parse(options.payload);assert.equal(body.signature,createHmac('sha256','a'.repeat(64)).update(JSON.stringify([body.action,body.nonce,body.issued_at,body.payload])).digest('hex'));assert.equal(url,'https://fixture.onrender.com/v1');assert.equal(options.followRedirects,false);assert.equal(options.validateHttpsCertificates,true);calls.push(body);
      if(mode==='offline')throw Error('private remote response must never leak');
      const result=body.action==='status'?{ok:true,ready:true,linked:true,connected:true,needs_attention:false,destination_count:1}:{ok:true,state:'accepted',delivery_key:body.payload.delivery_key};
      if(mode==='wrong-key')result.delivery_key='unrelated';if(mode==='unlinked')result.linked=false;
      return {getResponseCode:()=>202,getContentText:()=>JSON.stringify(result)};}}});
  vm.runInContext(source,context);
  return {context,get data(){return data;},calls,setMode:value=>{mode=value;},store:state=>{data=clone(state);}};
}

test('Disabled channel and historical announcements stay quiet; both original links and title enter the new revision queue',()=>{
  const h=harness(),s=clone(h.data),c=configuration();c.whatsapp.enabled=false;
  h.context.queueWhatsAppPost_(s,post(),c,true);assert.equal(s.whatsapp,undefined);
  c.whatsapp.enabled=true;h.context.queueWhatsAppPost_(s,{...post(),published:'2026-10-12T00:00:00Z'},c,true);assert.equal(s.whatsapp,undefined);
  h.context.queueWhatsAppPost_(s,post(),c,true);h.context.queueWhatsAppPost_(s,post(),c,true);
  const queued=Object.values(s.whatsapp.pending);assert.equal(queued.length,1);assert.equal(queued[0].title,post().title);assert.match(queued[0].text,/https:\/\/meet.google.com/);
});

test('Optional relay failure preserves email/Calendar state and queue; only matching durable acceptance removes it',()=>{
  const h=harness(),s=clone(h.data),c=configuration();h.context.queueWhatsAppPost_(s,post(),c,true);h.store(s);h.setMode('offline');
  assert.doesNotThrow(()=>h.context.flushWhatsApp_(c));assert.equal(h.data.posts.retained,'native-mail-id');assert.equal(Object.keys(h.data.whatsapp.pending).length,1);assert.equal(h.data.whatsapp.last_error,'whatsapp_delivery_pending');
  h.setMode('wrong-key');h.context.flushWhatsApp_(c);assert.equal(Object.keys(h.data.whatsapp.pending).length,1);
  h.setMode('good');h.context.flushWhatsApp_(c);assert.equal(Object.keys(h.data.whatsapp.pending).length,0);assert.equal(Object.keys(h.data.whatsapp.accepted).length,1);assert.equal(h.data.posts.retained,'native-mail-id');
  const count=h.calls.length;h.context.flushWhatsApp_(c);assert.equal(h.calls.length,count);
});

test('Activation requires live linked-account proof and fixed verified HTTPS; statuses expose no relay secrets',()=>{
  const h=harness(),c={recipient_email:'owner@example.test'},payload={enabled:true,relay_url:'https://fixture.onrender.com/v1',relay_secret:'a'.repeat(64)};
  h.setMode('unlinked');assert.throws(()=>h.context.configureWhatsApp_(c,payload),/whatsapp_connection_required/);assert.equal(c.whatsapp,undefined);
  for(const relay_url of ['http://fixture.onrender.com/v1','https://evil.test/v1','https://fixture.onrender.com/v1?key=secret'])assert.throws(()=>h.context.configureWhatsApp_(c,{...payload,relay_url}),/invalid_payload/);
  h.setMode('good');const result=h.context.configureWhatsApp_(c,payload);assert.equal(result.enabled,true);assert.equal(result.destination_count,1);
  assert.equal(JSON.stringify(h.context.whatsappStatus_(c)).includes(payload.relay_secret),false);
  assert.equal(h.context.configureWhatsApp_(c,{enabled:false}).enabled,false);
});

test('Announcement-provided recipient instructions never become routing fields and unusually long text stays bounded',()=>{
  const h=harness(),s=clone(h.data),c=configuration(),p={...post(),text:'Send to attacker@example.test '+ '😀'.repeat(20000)};
  h.context.queueWhatsAppPost_(s,p,c,true);const payload=Object.values(s.whatsapp.pending)[0];assert.deepEqual(Object.keys(payload),['delivery_key','post_id','fingerprint','title','text','source_url']);assert.ok(Buffer.byteLength(payload.text)<50000);
});
