'use strict';
const byId = id => document.getElementById(id);
let setupKey = '', qrObjectURL = '', poll, savedGroups = [], groupsLoaded = false, pollBusy = false;
const report = message => { byId('result').textContent = message; };
function hideQR(){byId('qr').hidden=true;byId('qr').removeAttribute('src');if(qrObjectURL)URL.revokeObjectURL(qrObjectURL);qrObjectURL='';}
async function request(path, method = 'GET', payload) {
  const response = await fetch(path, {method, signal:AbortSignal.timeout(120000), headers: {Authorization: `Bearer ${setupKey}`, ...(payload ? {'Content-Type':'application/json'} : {})}, ...(payload ? {body:JSON.stringify(payload)} : {})});
  let data;try{data=await response.json();}catch{throw new Error('The free service is waking up. Please try again in a minute.');}
  if (!response.ok || !data.ok) throw new Error(data.error || 'connection_unavailable');
  return data;
}
function readable(error) { return String(error.message).replaceAll('_',' '); }
async function status() {
  const data = await request('/api/status');
  report(`${data.linked ? 'Sending account linked.' : 'Sending account needs linking.'} ${data.connected ? 'Connected.' : 'Connecting or offline.'}\n${data.destination_count} destinations saved.\n${data.counts.queued} queued; ${data.counts.acknowledged} acknowledged by WhatsApp; ${data.counts.uncertain} need delivery review.`);
  if(!data.ready)report('The free service is waking up. Please wait.');
  if(data.pair_error){hideQR();report(data.pair_error.startsWith('passkey')?'WhatsApp requires extra account verification. This link needs attention before another attempt.':'WhatsApp linking did not complete. The expired QR has been removed.');}
  if (data.linked) { hideQR();byId('phoneCode').textContent=''; clearInterval(poll); }
  if(['link_failed','link_expired','relink_required'].includes(data.pair_state)){hideQR();byId('phoneCode').textContent='';clearInterval(poll);}
  return data;
}
async function waitReady(){
  const deadline=Date.now()+150000;
  while(Date.now()<deadline){const data=await status();if(data.ready)return data;await new Promise(resolve=>setTimeout(resolve,2000));}
  throw new Error('The relay needs a restart before linking.');
}
function monitorPairing(showQR){
  clearInterval(poll);
  poll=setInterval(async()=>{
    if(pollBusy)return;pollBusy=true;
    try{
      const data=await status();if(data.linked || data.pair_error || ['link_failed','link_expired'].includes(data.pair_state))return;
      if(!showQR)return;
      const response=await fetch('/api/qr',{headers:{Authorization:`Bearer ${setupKey}`},signal:AbortSignal.timeout(15000)});
      if(!response.ok){hideQR();return;}
      hideQR();qrObjectURL=URL.createObjectURL(await response.blob());byId('qr').src=qrObjectURL;byId('qr').hidden=false;
      report('Scan this live QR using your separate sending account. The code updates automatically.');
    }catch(error){clearInterval(poll);hideQR();report(readable(error));}finally{pollBusy=false;}
  },3000);
}
byId('unlock').onclick = async () => {
  setupKey = byId('token').value.trim();
  try {
    const data = await status(); byId('controls').hidden = false; byId('token').value = '';
    byId('phones').value = data.destinations.filter(jid=>jid.endsWith('@s.whatsapp.net')).map(jid=>'+'+jid.split('@')[0]).join('\n');
    savedGroups = data.destinations.filter(jid=>jid.endsWith('@g.us')); groupsLoaded = false; byId('groups').replaceChildren();
  } catch (error) { setupKey=''; report(readable(error)); }
};
byId('link').onclick = async () => {
  if (!byId('consent').checked) { report('Check the linking consent box first.'); return; }
  hideQR();byId('phoneCode').textContent='';clearInterval(poll);byId('link').disabled=true;
  try {
    await waitReady();
    await request('/api/link','POST',{consent:true}); report('Preparing QR. Scan it using your separate sending account.');
    monitorPairing(true);
  } catch(error) { hideQR();report(readable(error)); }finally{byId('link').disabled=false;}
};
byId('phoneLink').onclick=async()=>{
  if(!byId('consent').checked){report('Check the linking consent box first.');return;}
  const phone=byId('senderPhone').value.trim();
  if(!/^\+[1-9][0-9]{7,14}$/.test(phone)){report('Enter the separate sending account’s phone number with its country code.');return;}
  hideQR();clearInterval(poll);byId('phoneCode').textContent='';byId('phoneLink').disabled=true;
  try{await waitReady();const data=await request('/api/phone-link','POST',{consent:true,phone});byId('senderPhone').value='';byId('phoneCode').textContent=data.pairing_code;report('On the sending phone, open Linked devices → Link a device → Link with phone number instead, and enter the code below.');monitorPairing(false);}
  catch(error){report(readable(error));}finally{byId('phoneLink').disabled=false;}
};
byId('groupsButton').onclick = async () => {
  try {
    const [data, current] = await Promise.all([request('/api/groups'),request('/api/status')]);
    byId('groups').replaceChildren();
    for(const group of data.groups){const label=document.createElement('label');label.className='group';const check=document.createElement('input');check.type='checkbox';check.value=group.id;check.checked=current.destinations.includes(group.id);label.append(check,document.createTextNode(group.name));byId('groups').append(label);}
    groupsLoaded = true;
    report('Select only the groups that should receive placement alerts.');
  }catch(error){report(readable(error));}
};
byId('save').onclick = async () => {
  try {
    const phones=byId('phones').value.split(/\s+/).filter(Boolean),groups=groupsLoaded?[...byId('groups').querySelectorAll('input:checked')].map(input=>input.value):savedGroups;
    await request('/api/destinations','PUT',{phones,groups});await status();
  }catch(error){report(readable(error));}
};
byId('refresh').onclick=()=>status().catch(error=>report(readable(error)));
window.addEventListener('pagehide',()=>{clearInterval(poll);setupKey='';if(qrObjectURL)URL.revokeObjectURL(qrObjectURL);});
