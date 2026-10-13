'use strict';
const byId = id => document.getElementById(id);
let setupKey = '', qrObjectURL = '', poll, savedGroups = [], groupsLoaded = false;
const report = message => { byId('result').textContent = message; };
async function request(path, method = 'GET', payload) {
  const response = await fetch(path, {method, headers: {Authorization: `Bearer ${setupKey}`, ...(payload ? {'Content-Type':'application/json'} : {})}, ...(payload ? {body:JSON.stringify(payload)} : {})});
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'connection_unavailable');
  return data;
}
function readable(error) { return String(error.message).replaceAll('_',' '); }
async function status() {
  const data = await request('/api/status');
  report(`${data.linked ? 'Sending account linked.' : 'Sending account needs linking.'} ${data.connected ? 'Connected.' : 'Connecting or offline.'}\n${data.destination_count} destinations saved.\n${data.counts.queued} queued; ${data.counts.acknowledged} acknowledged by WhatsApp; ${data.counts.uncertain} need delivery review.`);
  if (data.linked) { byId('qr').hidden = true; clearInterval(poll); }
  return data;
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
  try {
    await request('/api/link','POST',{consent:true}); report('Preparing QR. Scan it using your separate sending account.');
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const data = await status(); if(data.linked) return;
        const response = await fetch('/api/qr',{headers:{Authorization:`Bearer ${setupKey}`}});
        if(response.ok){if(qrObjectURL)URL.revokeObjectURL(qrObjectURL);qrObjectURL=URL.createObjectURL(await response.blob());byId('qr').src=qrObjectURL;byId('qr').hidden=false;}
      } catch (error) { clearInterval(poll); report(readable(error)); }
    },3000);
  } catch(error) { report(readable(error)); }
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
