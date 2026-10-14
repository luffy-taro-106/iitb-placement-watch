import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {parseHTML} from 'linkedom';

const html=await readFile(new URL('index.html',import.meta.url),'utf8'),script=await readFile(new URL('admin.js',import.meta.url),'utf8');
function harness(){
  const {document,window}=parseHTML(html),calls=[];let callback,qrAvailable=true,ready=true;
  const state={ok:true,ready:true,linked:false,connected:false,pair_state:'waiting_for_scan',pair_error:'',destination_count:0,destinations:[],counts:{queued:0,acknowledged:0,uncertain:0}};
  const context=vm.createContext({document,window,Date,AbortSignal,URL:{createObjectURL:()=> 'blob:synthetic-qr',revokeObjectURL(){}},setTimeout:callback=>{callback();},setInterval:fn=>{callback=fn;return 1;},clearInterval:()=>{},
    fetch:async(path,options={})=>{calls.push({path,options});if(path==='/api/status')return Response.json({...state,ready});if(path==='/api/qr')return new Response('synthetic-image',{status:qrAvailable?200:404});if(path==='/api/link')return Response.json({ok:true});if(path==='/api/phone-link')return Response.json({ok:true,pairing_code:'ABCD-EFGH'});throw new Error('unexpected fixture request');}});
  vm.runInContext(script,context);
  const byId=id=>document.getElementById(id);
  byId('token').value='synthetic-private-key';byId('consent').checked=true;
  return {byId,state,calls,async unlock(){await byId('unlock').onclick();},async poll(){await callback();},setUnavailable(){qrAvailable=false;},setStarting(){ready=false;}};
}

test('Expired QR and verification failure remove the old image rather than invite repeated scans',async()=>{
  const h=harness();await h.unlock();await h.byId('link').onclick();await h.poll();assert.equal(h.byId('qr').hidden,false);
  h.setUnavailable();await h.poll();assert.equal(h.byId('qr').hidden,true);assert.equal(h.byId('qr').getAttribute('src'),null);
  h.state.pair_error='passkey_required';await h.poll();assert.match(h.byId('result').textContent,/extra account verification/);assert.equal(h.byId('qr').hidden,true);
  assert.equal(h.byId('token').value,'');
});

test('Phone-code linking requires a distinct explicitly supplied international sender number',async()=>{
  const h=harness();await h.unlock();h.byId('phones').value='+919000000001';
  await h.byId('phoneLink').onclick();assert.equal(h.calls.some(c=>c.path==='/api/phone-link'),false);
  h.byId('senderPhone').value='+919000000002';await h.byId('phoneLink').onclick();
  const call=h.calls.find(c=>c.path==='/api/phone-link');assert.deepEqual(JSON.parse(call.options.body),{consent:true,phone:'+919000000002'});assert.equal(h.byId('senderPhone').value,'');assert.equal(h.byId('phoneCode').textContent,'ABCD-EFGH');
  assert.match(h.byId('result').textContent,/sending phone/);assert.equal(h.byId('qr').hidden,true);
});
