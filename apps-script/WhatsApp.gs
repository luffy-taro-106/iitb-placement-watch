/* Optional channel. Account keys and recipients live only in the private relay. */
function validateWhatsAppConfiguration_(value) {
  requireObject_(value);
  if(typeof value.enabled!=='boolean')fail_('invalid_payload');
  if(value.enabled && (typeof value.relay_url!=='string' || !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com\/v1$/.test(value.relay_url) || !/^[a-f0-9]{64}$/.test(value.relay_secret || '') || typeof value.activated_at!=='string' || !isFinite(Date.parse(value.activated_at))))fail_('invalid_payload');
  return value;
}
function whatsappState_(state) {
  if(!state.whatsapp)state.whatsapp={pending:{},accepted:{},last_error:null,last_accepted_at:null};
  return state.whatsapp;
}
function relayCall_(configuration,action,payload) {
  validateWhatsAppConfiguration_(configuration);
  var nonce=Utilities.getUuid().replace(/-/g,'').toLowerCase(),issued=Math.floor(Date.now()/1000);
  var signature=hex_(Utilities.computeHmacSha256Signature(JSON.stringify([action,nonce,issued,payload]),configuration.relay_secret,Utilities.Charset.UTF_8));
  var response=UrlFetchApp.fetch(configuration.relay_url,{method:'post',contentType:'application/json',payload:JSON.stringify({action:action,nonce:nonce,issued_at:issued,payload:payload,signature:signature}),followRedirects:false,muteHttpExceptions:true,validateHttpsCertificates:true});
  if(response.getResponseCode()<200 || response.getResponseCode()>=300)fail_('whatsapp_unavailable');
  var raw=response.getContentText();if(raw.length>20000)fail_('whatsapp_unavailable');
  var result;try{result=JSON.parse(raw);}catch(_){fail_('whatsapp_unavailable');}
  if(!result || result.ok!==true)fail_('whatsapp_unavailable');return result;
}
function configureWhatsApp_(configuration,payload) {
  requireObject_(payload);
  if(Object.keys(payload).some(function(key){return !['enabled','relay_url','relay_secret'].includes(key);}) || typeof payload.enabled!=='boolean')fail_('invalid_payload');
  var state=loadState_(),channel=whatsappState_(state),existing=configuration.whatsapp || {enabled:false};
  if(!payload.enabled) {
    if(Object.keys(payload).length!==1)fail_('invalid_payload');
    configuration.whatsapp=Object.assign({},existing,{enabled:false});privateWrite_('CONFIG_FILE_ID',configuration);return {ok:true,enabled:false};
  }
  var updated={enabled:true,relay_url:payload.relay_url,relay_secret:payload.relay_secret,activated_at:existing.enabled?existing.activated_at:new Date().toISOString()};
  validateWhatsAppConfiguration_(updated);
  if(Object.keys(channel.pending).length && (existing.relay_url!==updated.relay_url || existing.relay_secret!==updated.relay_secret))fail_('whatsapp_review_required');
  var proof=relayCall_(updated,'status',{});
  if(proof.ready!==true || proof.linked!==true || proof.connected!==true || proof.needs_attention!==false || !Number.isInteger(proof.destination_count) || proof.destination_count<1 || proof.destination_count>20)fail_('whatsapp_connection_required');
  configuration.whatsapp=updated;privateWrite_('CONFIG_FILE_ID',configuration);saveState_(state);
  return {ok:true,enabled:true,destination_count:proof.destination_count,activated_at:updated.activated_at};
}
function whatsappText_(post) {
  var text=post.text;
  var links=post.links.slice(0,20).map(function(link){return (link.text?link.text+': ':'')+link.url;}).join('\n');
  // UTF-16 cap is also below the relay's UTF-8 byte bound. The fixed source URL
  // remains present even if unusually long announcement content is shortened.
  var points=Array.from(text+(links?'\n\n'+links:''));
  return points.length>10000?points.slice(0,9900).join('')+'\n[Full announcement and remaining links are on the placement blog.]':points.join('');
}
function queueWhatsAppPost_(state,post,configuration,isNew) {
  if(!configuration.whatsapp || !configuration.whatsapp.enabled)return;
  validateWhatsAppConfiguration_(configuration.whatsapp);
  if(isNew && Date.parse(post.published)<=Date.parse(configuration.whatsapp.activated_at))return;
  var channel=whatsappState_(state),key=post.id+':'+post.fingerprint;
  if(channel.accepted[key] || channel.pending[key])return;
  channel.pending[key]={delivery_key:key,post_id:post.id,fingerprint:post.fingerprint,title:post.title,text:whatsappText_(post),source_url:post.url};
}
function flushWhatsApp_(configuration) {
  if(!configuration.whatsapp || !configuration.whatsapp.enabled)return;
  // Load again after email/Calendar work so saving this optional queue never
  // overwrites their newer delivery state. Failures stay isolated in this channel.
  var state=loadState_(),channel=whatsappState_(state),keys=Object.keys(channel.pending);
  for(var i=0;i<Math.min(keys.length,10);i++) {
    var key=keys[i];
    try {
      var receipt=relayCall_(configuration.whatsapp,'deliver',channel.pending[key]);
      if(receipt.delivery_key!==key || receipt.state!=='accepted')fail_('whatsapp_unavailable');
      channel.accepted[key]={at:new Date().toISOString()};delete channel.pending[key];channel.last_error=null;channel.last_accepted_at=new Date().toISOString();saveState_(state);
    } catch(_) {channel.last_error='whatsapp_delivery_pending';saveState_(state);return;}
  }
}
function whatsappStatus_(configuration) {
  var state=loadState_(),channel=whatsappState_(state),enabled=!!(configuration.whatsapp && configuration.whatsapp.enabled);
  var result={ok:true,enabled:enabled,pending_count:Object.keys(channel.pending).length,last_error:channel.last_error,last_accepted_at:channel.last_accepted_at,relay:null};
  if(enabled) {
    try {
      var proof=relayCall_(configuration.whatsapp,'status',{});
      result.relay={ready:proof.ready===true,linked:proof.linked===true,connected:proof.connected===true,destination_count:Number.isInteger(proof.destination_count)?proof.destination_count:0,needs_attention:proof.needs_attention!==false,queued_count:proof.counts && Number.isInteger(proof.counts.queued)?proof.counts.queued:null,acknowledged_count:proof.counts && Number.isInteger(proof.counts.acknowledged)?proof.counts.acknowledged:null,uncertain_count:proof.counts && Number.isInteger(proof.counts.uncertain)?proof.counts.uncertain:null};
    }catch(_){result.last_error='whatsapp_unavailable';}
  }
  return result;
}
