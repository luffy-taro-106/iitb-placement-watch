function validatePosts_(payload) {
  requireObject_(payload);
  if(payload.source_url!==PLACEMENT_BLOG_) fail_('invalid_source');
  if(payload.complete!==true || !Array.isArray(payload.posts) || !payload.posts.length || payload.posts.length>500) fail_('invalid_snapshot');
  validInstant_(payload.observed_at,true);
  var ids={};
  return payload.posts.map(function(post){
    requireObject_(post);
    if(!/^post-\d+$/.test(post.id || '') || ids[post.id] || typeof post.title!=='string' || !post.title.trim() || post.title.length>1000 || typeof post.text!=='string' || post.text.length>64000 || typeof post.url!=='string' || post.url!==PLACEMENT_BLOG_+'?p='+post.id.slice(5) || !Array.isArray(post.links) || post.links.length>100) fail_('invalid_snapshot');
    ids[post.id]=true;validInstant_(post.published,false);
    var links=post.links.map(function(link){requireObject_(link);if(typeof link.text!=='string' || link.text.length>1000 || typeof link.url!=='string' || link.url.length>4096 || !/^https?:\/\/[^\s]+$/i.test(link.url) || /[\r\n]/.test(link.url)) fail_('invalid_snapshot');return {text:normalized_(link.text),url:link.url};});
    return {id:post.id,title:normalized_(post.title),text:normalized_(post.text),published:post.published,url:post.url,links:links};
  });
}
function postFingerprint_(post) { return sha256_(JSON.stringify([post.title,post.text,post.links.map(function(a){return a.url;}).sort()])); }
function htmlEscape_(value) { return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function ingestSnapshot_(payload,configuration) {
  var posts=validatePosts_(payload), state=loadState_();
  if(payload.session) saveSession_(payload.session,payload.observed_at);
  posts.forEach(function(post){
    var old=state.posts[post.id], fingerprint=postFingerprint_(post), legacy=old && /^[a-f0-9]{8}$/.test(old.fingerprint || '');
    var isNew=!old && Date.parse(post.published)>Date.parse(state.baseline_cutoff);
    if(isNew || (old && !legacy && old.fingerprint!==fingerprint)) {
      // A newer revision also supersedes unfinished calendar work from an already mailed revision.
      // Sent history and an uncertain email_attempt remain independent and are still recovered below.
      state.pending=state.pending.filter(function(p){return p.id!==post.id || p.fingerprint===fingerprint;});
      if(!state.pending.some(function(p){return p.id===post.id && p.fingerprint===fingerprint;})) state.pending.push(Object.assign({},post,{fingerprint:fingerprint,kind:isNew?'new':'changed'}));
    }
    state.posts[post.id]=Object.assign({},old || {},post,{fingerprint:fingerprint});
  });
  state.last_successful_check=payload.observed_at;state.last_error=null;saveState_(state);
  deliverPending_(state,configuration);
  var attention=state.pending.some(function(post){return post.calendar_complete===false;});
  if(attention){state.last_error='calendar_needs_review';saveState_(state);}
  return {ok:true,needs_attention:attention,pending_count:state.pending.length,last_successful_check:state.last_successful_check,delivery_count:state.deliveries.length,meeting_count:Object.keys(state.meetings).length};
}
function verifyMail_(message,messageId,recipient) {
  if(!message || !(message.labelIds || []).includes('SENT'))fail_('uncertain_email_delivery');
  var headers={};((message.payload || {}).headers || []).forEach(function(h){headers[String(h.name).toLowerCase()]=String(h.value).trim();});
  if(headers['message-id']!==messageId || (headers.to || '').toLowerCase()!==recipient.toLowerCase())fail_('uncertain_email_delivery');
  return message.id;
}
function findSent_(messageId,recipient) {
  var found=Gmail.Users.Messages.list('me',{q:'in:sent rfc822msgid:'+messageId,maxResults:2});
  if((found.messages || []).length>1) fail_('uncertain_email_delivery');
  if(!found.messages || !found.messages.length) return null;
  var verified=Gmail.Users.Messages.get('me',found.messages[0].id,{format:'metadata',metadataHeaders:['Message-ID','To']});
  return verifyMail_(verified,messageId,recipient);
}
function acknowledgeEmail_(state,attempt,id) {
  attempt.revisions.forEach(function(revision){
    var pending=state.pending.find(function(p){return p.id===revision.id && p.fingerprint===revision.fingerprint;});
    if(revision.channel==='calendar_recovery') {
      if(pending){pending.calendar_followup_email_id=id;pending.calendar_followup_pending=false;}
      if(state.posts[revision.id])state.posts[revision.id].calendar_followup_email_id=id;
    } else {
      if(pending) pending.notified_email_id=id;
      if(state.posts[revision.id]) state.posts[revision.id].notified_email_id=id;
    }
  });
  if(!state.deliveries.some(function(d){return d.email_id===id;})) state.deliveries.push({email_id:id,revisions:attempt.revisions,at:new Date().toISOString()});
  state.email_attempt=null;saveState_(state);
}
function deliverPending_(state,configuration) {
  if(state.email_attempt) {
    var recovered=findSent_(state.email_attempt.message_id,configuration.recipient_email);
    if(!recovered) fail_('uncertain_email_delivery');
    acknowledgeEmail_(state,state.email_attempt,recovered);
  }
  var unfinished=state.pending.filter(function(p){return !p.calendar_complete;});
  unfinished.forEach(function(post){
    try {
      var previouslyFailed=post.calendar_complete===false;
      post.calendar_result=calendarResult_(state,configuration,post);post.calendar_complete=true;
      if(previouslyFailed && post.notified_email_id && ['scheduled','cancelled'].includes(post.calendar_result.kind))post.calendar_followup_pending=true;
    }
    catch (_) { post.calendar_result={kind:'ambiguous',message:'Calendar scheduling needs review; a provider result may still need verification.'};post.calendar_complete=false; }
    saveState_(state);
  });
  var recipients=state.pending.filter(function(p){return !p.notified_email_id || p.calendar_followup_pending;});
  if(recipients.length) {
    var revisions=recipients.map(function(p){return {id:p.id,fingerprint:p.fingerprint,channel:p.notified_email_id?'calendar_recovery':'announcement'};});
    var digestId=sha256_(JSON.stringify(revisions)), messageId='<iitb-placement-'+digestId+'@placement-watch.invalid>';
    var attempt={message_id:messageId,revisions:revisions,started_at:new Date().toISOString()};
    var body='<h2>IITB placement updates</h2>';
    recipients.forEach(function(post){
      body+='<h3>'+htmlEscape_(post.title)+'</h3>';
      if(!post.notified_email_id)body+='<p>'+htmlEscape_(post.text.slice(0,3000))+'</p>';
      else body+='<p>The earlier calendar action has now been completed.</p>';
      body+='<p><a href="'+htmlEscape_(post.url)+'">Placement blog source</a></p>';
      if(post.calendar_result) body+='<p>'+htmlEscape_(post.calendar_result.message || '')+'</p>';
      if(post.calendar_result && post.calendar_result.start) body+='<p>Meeting start: '+htmlEscape_(Utilities.formatDate(new Date(post.calendar_result.start),'Asia/Kolkata','dd MMM yyyy, h:mm a'))+' IST.</p>';
      if(post.links.length) body+='<p>'+post.links.slice(0,25).map(function(link){return '<a href="'+htmlEscape_(link.url)+'">'+htmlEscape_(link.text || link.url)+'</a>';}).join(' · ')+'</p>';
    });
    var subject='IITB placement: '+recipients.length+' update'+(recipients.length===1?'':'s');
    var raw=['From: '+configuration.recipient_email,'To: '+configuration.recipient_email,'Subject: '+subject,'Message-ID: '+messageId,'MIME-Version: 1.0','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',''+Utilities.base64Encode(Utilities.newBlob(body).getBytes())].join('\r\n');
    var already=findSent_(messageId,configuration.recipient_email);
    if(already) acknowledgeEmail_(state,attempt,already);
    else {
      state.email_attempt=attempt;saveState_(state);
      // A timeout remains uncertain. Future checks search Message-ID; they never blindly resend.
      var sent=Gmail.Users.Messages.send({raw:Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/,'')},'me');
      if(!sent || !sent.id) fail_('uncertain_email_delivery');
      var verified=Gmail.Users.Messages.get('me',sent.id,{format:'metadata',metadataHeaders:['Message-ID','To']});
      verifyMail_(verified,messageId,configuration.recipient_email);
      acknowledgeEmail_(state,attempt,sent.id);
    }
  }
  state.pending=state.pending.filter(function(post){return !post.notified_email_id || !post.calendar_complete || post.calendar_followup_pending;});saveState_(state);
}
function notifyFailureOnce_(state,configuration) {
  if(!state.failure) {state.failure={episode:Utilities.getUuid(),attempted:false,notified_email_id:null};saveState_(state);}
  if(state.failure.notified_email_id)return;
  var messageId='<iitb-placement-failure-'+sha256_(state.failure.episode)+'@placement-watch.invalid>';
  var recovered=findSent_(messageId,configuration.recipient_email);
  if(recovered){state.failure.notified_email_id=recovered;saveState_(state);return;}
  if(state.failure.attempted)return;
  state.failure.attempted=true;saveState_(state);
  var body='The IITB placement monitor could not check for updates. Your IITB session may need reconnecting, or the source may be temporarily unavailable. Check the private setup status. This notice is sent once until checks recover.';
  var raw=['From: '+configuration.recipient_email,'To: '+configuration.recipient_email,'Subject: IITB placement monitor needs attention','Message-ID: '+messageId,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','',''+body].join('\r\n');
  var sent=Gmail.Users.Messages.send({raw:Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/,'')},'me');
  if(!sent || !sent.id)return;
  var verified=Gmail.Users.Messages.get('me',sent.id,{format:'metadata',metadataHeaders:['Message-ID','To']});
  verifyMail_(verified,messageId,configuration.recipient_email);
  state.failure.notified_email_id=sent.id;saveState_(state);
}
