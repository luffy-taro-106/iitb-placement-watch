import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,createHmac,randomUUID,randomBytes} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const code=(await Promise.all(['Bridge.gs','Meetings.gs','Deadlines.gs','Delivery.gs'].map(name=>readFile(new URL(name,import.meta.url),'utf8')))).join('\n');
const OWNER='owner@example.test',FRIEND='friend@example.test',BLOG='https://campus.placements.iitb.ac.in/blog/placement/';
const NOW=Date.parse('2026-10-12T17:30:00Z'),SECRET='synthetic-authorization-key-long-enough';
const clone=value=>JSON.parse(JSON.stringify(value));
const sony=()=>({id:'post-311',title:'Sony Japan | JAF Open',text:'JAF for Sony Japan is open.\nDeadline: 14th October(Wednesday) | 11:59 PM (Midnight)\nAn essay must be uploaded in the SOP section.',published:'2026-10-12T16:00:00+05:30',url:BLOG+'?p=311',links:[{text:'Essay format',url:'https://docs.google.com/document/d/synthetic-format/edit'}]});
function harness() {
  let locked=false,sends=0,inserts=0,patches=0,unknownSend=false,effectiveOwner=OWNER;
  const data={CONFIG_FILE_ID:{recipient_email:OWNER,calendar_id:OWNER,timezone:'Asia/Kolkata',baseline_cutoff:'2026-10-11T10:25:30+05:30'},STATE_FILE_ID:{posts:{},meetings:{},pending:[],deliveries:[],last_error:null,baseline_cutoff:'2026-10-11T10:25:30+05:30'}};
  const messages=new Map(),events=new Map(),properties=new Map([['BRIDGE_SECRET',SECRET]]);
  class Clock extends Date {constructor(...args){super(...(args.length?args:[NOW]));}static now(){return NOW;}}
  const bytes=value=>Array.isArray(value)?Buffer.from(value.map(b=>(b+256)%256)):Buffer.from(String(value));
  const props={getProperty:k=>properties.get(k)||null,getProperties:()=>Object.fromEntries(properties),setProperty:(k,v)=>properties.set(k,v),deleteProperty:k=>properties.delete(k)};
  const context=vm.createContext({Date:Clock,PropertiesService:{getScriptProperties:()=>props},LockService:{getScriptLock:()=>({tryLock(){assert.equal(locked,false);locked=true;return true;},releaseLock(){locked=false;}})},
    ContentService:{MimeType:{JSON:'JSON'},createTextOutput:value=>({value,setMimeType(){return this;}})},Session:{getEffectiveUser:()=>({getEmail:()=>effectiveOwner})},
    Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'UTF-8'},computeDigest:(_,value)=>[...createHash('sha256').update(value).digest()],computeHmacSha256Signature:(value,key)=>[...createHmac('sha256',key).update(value).digest()],
      getUuid:randomUUID,newBlob:value=>({getBytes:()=>[...bytes(value)],getDataAsString:()=>bytes(value).toString('utf8')}),base64Encode:value=>bytes(value).toString('base64'),base64EncodeWebSafe:value=>bytes(value).toString('base64url'),base64DecodeWebSafe:value=>[...Buffer.from(value,'base64url')],formatDate:date=>date.toISOString()},
    Gmail:{Users:{getProfile:()=>({emailAddress:OWNER}),Messages:{
      list(_user,{q}){const reference=q.match(/"([^"]+)"/)?.[1];return {messages:[...messages].filter(([,m])=>m.headers.some(h=>h.name==='To' && h.value.split(',').map(v=>v.trim()).includes(OWNER)) && (reference?m.html.includes(reference):q.includes(m.headers.find(h=>h.name==='Message-ID').value))).map(([id])=>({id}))};},
      get(_user,id){if(!messages.has(id))throw new Error('404 not found');const m=messages.get(id);return {id,labelIds:['SENT'],payload:{mimeType:'text/html',headers:clone(m.headers),body:{data:Buffer.from(m.html).toString('base64url')}}};},
      send({raw}){sends++;const [headerBlock,encodedBody]=Buffer.from(raw,'base64url').toString('utf8').split('\r\n\r\n');const headers=headerBlock.replace(/\r\n /g,' ').split('\r\n').map(line=>({name:line.slice(0,line.indexOf(':')),value:line.slice(line.indexOf(':')+1).trim()}));
        headers.find(h=>h.name==='Message-ID').value='<rewritten-'+sends+'@mail.gmail.com>';const id='mail-'+sends;messages.set(id,{headers,html:Buffer.from(encodedBody,'base64').toString('utf8')});if(unknownSend)throw new Error('Synthetic timeout after provider send');return {id};}
    }}},Calendar:{CalendarList:{get:()=>({id:OWNER,accessRole:'owner'})},Events:{get(_cal,id){if(!events.has(id))throw new Error('404 not found');return clone({organizer:{self:true,email:OWNER},...events.get(id)});},list:()=>({items:[]}),insert(event){inserts++;events.set(event.id,clone(event));return clone(event);},patch(event,_cal,id){patches++;events.set(id,{...events.get(id),...clone(event),id});return clone(events.get(id));}}}
  });
  vm.runInContext(code,context);
  context.privateRead_=key=>clone(data[key]);context.privateWrite_=(key,value)=>{data[key]=clone(value);};
  const envelope=(action,payload)=>{const nonce=randomBytes(16).toString('hex'),issued_at=NOW/1000;return {action,payload,nonce,issued_at,signature:createHmac('sha256',SECRET).update(JSON.stringify([action,nonce,issued_at,payload])).digest('hex')};};
  const post=body=>JSON.parse(context.doPost({postData:{contents:JSON.stringify(body)}}).value);
  return {context,data,messages,events,envelope,post,call:(action,payload={})=>post(envelope(action,payload)),configure:()=>post(envelope('configure_notifications',{announcement_recipients:[OWNER,FRIEND]})),
    ingest(posts){return context.ingestSnapshot_({source_url:BLOG,observed_at:new Clock().toISOString(),complete:true,posts},data.CONFIG_FILE_ID);},stats:()=>({sends,inserts,patches}),setUnknownSend:value=>{unknownSend=value;},setEffectiveOwner:value=>{effectiveOwner=value;}};
}

test('Sony announcement uses its exact title and both recipients; its deadline has a 60-minute email reminder',()=>{
  const h=harness();assert.equal(h.configure().ok,true);h.ingest([sony()]);
  const mail=h.messages.get('mail-1');assert.equal(mail.headers.find(h=>h.name==='Subject').value,'Sony Japan | JAF Open');assert.equal(mail.headers.find(h=>h.name==='To').value,OWNER+', '+FRIEND);
  assert.match(mail.html,/An essay must be uploaded/);assert.match(mail.html,/<br>/);assert.match(mail.html,/one hour before/);
  const event=[...h.events.values()][0];assert.equal(event.summary,'Sony Japan | JAF Open | Deadline');assert.equal(event.start.dateTime,'2026-10-14T18:29:00.000Z');
  assert.deepEqual(event.reminders.overrides,[{method:'email',minutes:60},{method:'popup',minutes:30}]);assert.equal(event.visibility,'private');assert.equal(event.transparency,'transparent');assert.deepEqual(event.attendees,[]);
  assert.match(event.description,/\?p=311/);assert.match(event.description,/synthetic-format/);assert.equal(event.conferenceData,null);
  h.ingest([sony()]);assert.deepEqual(h.stats(),{sends:1,inserts:1,patches:0});
});

test('Deadlines update one occurrence and reject unclear dates/times instead of inventing a deadline',()=>{
  const h=harness();h.ingest([sony()]);const id=[...h.events.keys()][0];
  h.ingest([{...sony(),text:'Deadline: 15th October 2026, 07:00 PM'}]);assert.equal(h.events.size,1);assert.equal(h.events.get(id).start.dateTime,'2026-10-15T13:30:00.000Z');assert.equal(h.stats().patches,1);
  for(const text of ['Deadline: 14th October','Deadline: 32 October, 11:59 PM','Deadline: 14th October, 8','Deadline: 14th October, 11:59 PM JST'])assert.equal(h.context.parseDeadlines_({...sony(),text})[0].kind,'ambiguous');
  assert.equal(h.context.parseDeadlines_({...sony(),text:'Deadline: 14thOctober | 11:59 PM'})[0].start,'2026-10-14T18:29:00.000Z');
  assert.equal(h.context.parseDeadlines_({...sony(),text:'Deadline: 2026-10-14 | 23:59'})[0].start,'2026-10-14T18:29:00.000Z');
  assert.equal(h.context.parseDeadlines_({...sony(),text:'Job code 1. Please read the guidelines.'}).length,0);
});

test('A meeting with a registration deadline saves both reminders and the original joining link',()=>{
  const h=harness();const meeting={...sony(),id:'post-500',url:BLOG+'?p=500',title:'Company | Pre-Placement Talk',text:'Date: 15 October 2026\nTime: 6:30 PM – 7:30 PM IST\nRegistration closes: 14 October 2026, 7 PM',links:[{text:'Join',url:'https://company.webex.com/meet/original'}]};
  h.ingest([meeting]);assert.equal(h.events.size,2);assert.equal(Object.keys(h.data.STATE_FILE_ID.meetings).length,1);assert.equal(Object.keys(h.data.STATE_FILE_ID.deadlines).length,1);
  const event=[...h.events.values()].find(e=>e.summary===meeting.title);assert.equal(event.location,meeting.links[0].url);assert.match(event.description,/Original joining link/);assert.equal(event.start.dateTime,'2026-10-15T13:00:00.000Z');
  h.ingest([meeting]);assert.equal(h.events.size,2);assert.equal(h.stats().sends,1);
});

test('Already delivered announcements acquire future deadline markers without being emailed again',()=>{
  const h=harness(),post=sony();h.data.STATE_FILE_ID.posts[post.id]={...post,fingerprint:h.context.postFingerprint_(post),notified_email_id:'historical-mail'};
  h.ingest([post]);assert.equal(h.events.size,1);assert.equal(h.stats().sends,0);assert.equal(h.data.STATE_FILE_ID.posts[post.id].notified_email_id,'historical-mail');assert.equal(h.data.STATE_FILE_ID.deadline_calendar_migrated,true);
});

test('Requested Sony resend reaches both recipients exactly once and leaves ordinary revision history intact',()=>{
  const h=harness();h.configure();h.ingest([sony()]);const original=h.data.STATE_FILE_ID.posts['post-311'].notified_email_id;
  const result=h.call('resend_announcement',{post_id:'post-311',request_id:'sony-test-request'});assert.equal(result.ok,true);assert.deepEqual(result.recipients,[OWNER,FRIEND]);assert.equal(result.subject,sony().title);
  assert.equal(h.stats().sends,2);assert.equal(h.events.size,1);assert.equal(h.data.STATE_FILE_ID.posts['post-311'].notified_email_id,original);
  assert.equal(h.call('resend_announcement',{post_id:'post-311',request_id:'sony-test-request'}).email_id,result.email_id);h.ingest([sony()]);assert.equal(h.stats().sends,2);
});

test('An uncertain requested send is recovered from Sent without a second send, even after recipient settings change',()=>{
  const h=harness();h.ingest([sony()]);h.configure();h.setUnknownSend(true);
  assert.equal(h.call('resend_announcement',{post_id:'post-311',request_id:'lost-send-request'}).ok,false);assert.ok(h.data.STATE_FILE_ID.replay_attempt);
  assert.equal(h.call('configure_notifications',{announcement_recipients:[OWNER]}).ok,true);h.setUnknownSend(false);
  const result=h.call('resend_announcement',{post_id:'post-311',request_id:'lost-send-request'});assert.equal(result.ok,true);assert.deepEqual(result.recipients,[OWNER,FRIEND]);assert.equal(h.stats().sends,2);assert.equal(h.data.STATE_FILE_ID.replay_attempt,null);
});

test('Recipient changes retain authenticated ownership and reject forged authorization or header injection',()=>{
  const h=harness(),forged=h.envelope('configure_notifications',{announcement_recipients:[OWNER,FRIEND]});forged.signature='0'.repeat(64);
  assert.equal(h.post(forged).error,'authentication_failed');assert.equal(h.data.CONFIG_FILE_ID.announcement_recipients,undefined);
  for(const recipients of [[FRIEND],[OWNER,OWNER],[OWNER,'friend@example.test\r\nBcc: outsider@example.test']])assert.equal(h.call('configure_notifications',{announcement_recipients:recipients}).error,'invalid_payload');
  h.setEffectiveOwner('outsider@example.test');assert.equal(h.configure().error,'wrong_account');assert.equal(h.data.CONFIG_FILE_ID.announcement_recipients,undefined);
});

test('Non-ASCII announcement titles survive MIME encoding and unexpected recipients or subjects fail readback',()=>{
  const h=harness();h.configure();h.ingest([{...sony(),title:'Company — Préparation session',text:'A new announcement without timing.'}]);
  const message=h.context.Gmail.Users.Messages.get('me','mail-1'),receipt=h.data.STATE_FILE_ID.deliveries[0];assert.ok(receipt);
  assert.equal(h.context.decodedSubject_(message.payload.headers.find(h=>h.name==='Subject').value),'Company — Préparation session');
  const attempt={recipients:[OWNER,FRIEND],subject:'Company — Préparation session'};
  assert.doesNotThrow(()=>h.context.verifySentOwner_(message,OWNER,attempt));
  const wrongRecipient=clone(message);wrongRecipient.payload.headers.find(h=>h.name==='To').value+=', outsider@example.test';assert.throws(()=>h.context.verifySentOwner_(wrongRecipient,OWNER,attempt),/uncertain_email_delivery/);
  const wrongSubject=clone(message);wrongSubject.payload.headers.find(h=>h.name==='Subject').value='Generic update';assert.throws(()=>h.context.verifySentOwner_(wrongSubject,OWNER,attempt),/uncertain_email_delivery/);
});

test('Changing reader formatting or duplicated header links does not re-mail a previously delivered announcement',()=>{
 const h=harness(),post=sony();h.ingest([post]);assert.equal(h.stats().sends,1);
 h.ingest([{...post,text:post.text.replace(/\n/g,'   '),links:[...post.links,...post.links]}]);
 assert.equal(h.stats().sends,1);assert.equal(h.data.STATE_FILE_ID.pending.length,0);
 h.ingest([{...post,text:post.text.replace('14th October','15th October')}]);
 assert.equal(h.stats().sends,2);assert.equal([...h.events.values()][0].start.dateTime,'2026-10-15T18:29:00.000Z');
});
