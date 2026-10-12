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
function validateAnnouncementRecipients_(recipients,owner) {
  if(!Array.isArray(recipients) || !recipients.length || recipients.length>10)fail_('invalid_payload');
  var seen={},result=recipients.map(function(address){
    if(typeof address!=='string' || address.length>254 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(address))fail_('invalid_payload');
    var normalized=address.toLowerCase();if(seen[normalized])fail_('invalid_payload');seen[normalized]=true;return normalized;
  });
  if(!seen[owner.toLowerCase()])fail_('invalid_payload');return result;
}
function announcementRecipients_(configuration) {
  return validateAnnouncementRecipients_(configuration.announcement_recipients || [configuration.recipient_email],configuration.recipient_email);
}
function htmlEscape_(value) { return String(value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function comparePublishedPosts_(left,right) {
  var dateOrder=Date.parse(left.published)-Date.parse(right.published);
  if(dateOrder)return dateOrder;
  // WordPress IDs break equal-publication-time ties without losing precision for long digit strings.
  var leftId=String(left.id).slice(5).replace(/^0+(?=\d)/,''), rightId=String(right.id).slice(5).replace(/^0+(?=\d)/,'');
  return leftId.length-rightId.length || (leftId<rightId?-1:leftId>rightId?1:0);
}
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
  if(!state.deadline_calendar_migrated) reconcileExistingDeadlines_(state,configuration);
  deliverPending_(state,configuration);
  var attention=state.pending.some(function(post){return post.calendar_complete===false;});
  if(attention){state.last_error='calendar_needs_review';saveState_(state);}
  return {ok:true,needs_attention:attention,pending_count:state.pending.length,last_successful_check:state.last_successful_check,delivery_count:state.deliveries.length,meeting_count:Object.keys(state.meetings).length};
}
function mailHeaders_(message) {
  var headers={};((message.payload || {}).headers || []).forEach(function(h){
    var name=String(h.name).toLowerCase();if(Object.prototype.hasOwnProperty.call(headers,name) && ['to','from','cc','bcc','message-id','x-iitb-placement-delivery'].includes(name))fail_('uncertain_email_delivery');
    headers[name]=String(h.value).trim();
  });return headers;
}
function ownerMailbox_(value,recipient) {
  value=String(value || '').trim();
  var display=value.match(/^(?:"[^"\r\n]*"|[^<>,;\r\n]*)\s*<([^<>\s,;]+)>$/);
  return (display?display[1]:value).toLowerCase()===recipient.toLowerCase();
}
function verifySentOwner_(message,recipient,attempt) {
  if(!message || !(message.labelIds || []).includes('SENT'))fail_('uncertain_email_delivery');
  var headers=mailHeaders_(message);
  var expected=attempt && attempt.recipients ? validateAnnouncementRecipients_(attempt.recipients,recipient) : [recipient.toLowerCase()];
  var actual=String(headers.to || '').split(',').map(function(address){
    var match=address.trim().match(/^(?:"[^"\r\n]*"|[^<>,;\r\n]*)\s*<([^<>\s,;]+)>$/);
    return (match?match[1]:address.trim()).toLowerCase();
  });
  if(actual.length!==expected.length || new Set(actual).size!==actual.length || actual.some(function(address){return expected.indexOf(address)===-1;}) || !ownerMailbox_(headers.from,recipient) || headers.cc || headers.bcc)fail_('uncertain_email_delivery');
  if(attempt && attempt.subject && decodedSubject_(headers.subject)!==attempt.subject)fail_('uncertain_email_delivery');
  return headers;
}
function mailHtml_(message) {
  var htmlParts=[];
  function visit(part) {
    if(!part || typeof part.mimeType!=='string')fail_('uncertain_email_delivery');
    if(part.mimeType.toLowerCase()==='text/html') {
      var types=(part.headers || []).filter(function(h){return String(h.name).toLowerCase()==='content-type';});
      if(types.length!==1 || !/^text\/html\s*;\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*$/i.test(String(types[0].value)) || !part.body)fail_('uncertain_email_delivery');
      var data=part.body.data,bytes;
      if(typeof data==='string') {
        if(data.length>4000000 || !/^[A-Za-z0-9_-]*={0,2}$/.test(data))fail_('uncertain_email_delivery');
        try {bytes=Utilities.base64DecodeWebSafe(data);}catch(_){fail_('uncertain_email_delivery');}
      } else if(Array.isArray(data)) {
        // Advanced Gmail decodes bytes; REST returns a base64url string. Accept neither
        // arbitrary objects nor sparse/non-integer arrays, and normalize unsigned bytes.
        if(data.length>3000000)fail_('uncertain_email_delivery');
        bytes=[];
        for(var i=0;i<data.length;i++) {
          if(!Object.prototype.hasOwnProperty.call(data,i) || !Number.isInteger(data[i]) || data[i]<-128 || data[i]>255)fail_('uncertain_email_delivery');
          bytes.push(data[i]>127?data[i]-256:data[i]);
        }
      } else fail_('uncertain_email_delivery');
      if(bytes.length>3000000)fail_('uncertain_email_delivery');
      var decoded;try {decoded=Utilities.newBlob(bytes).getDataAsString('UTF-8');}catch(_){fail_('uncertain_email_delivery');}
      htmlParts.push(decoded);
    } else if(/^multipart\//i.test(part.mimeType)) (part.parts || []).forEach(visit);
    else if(part.mimeType.toLowerCase()!=='text/plain')fail_('uncertain_email_delivery');
  }
  visit(message.payload);if(htmlParts.length!==1)fail_('uncertain_email_delivery');return htmlParts[0];
}
function canonicalMailHtml_(body) {return String(body).replace(/\r\n?/g,'\n').replace(/\n+$/,'');}
function verifyDeliveryBody_(message,attempt,headers) {
  if(!attempt || !/^[a-f0-9]{64}$/.test(attempt.body_sha256 || ''))fail_('uncertain_email_delivery');
  var body=mailHtml_(message);
  if(sha256_(canonicalMailHtml_(body))!==attempt.body_sha256)fail_('uncertain_email_delivery');
  if(attempt.delivery_reference && (headers['x-iitb-placement-delivery']!==attempt.delivery_reference || !body.includes('<p>Delivery reference: '+attempt.delivery_reference+'</p>')))fail_('uncertain_email_delivery');
}
function verifyMail_(message,messageId,recipient,attempt) {
  var headers=verifySentOwner_(message,recipient,attempt);
  if(attempt && attempt.delivery_reference)verifyDeliveryBody_(message,attempt,headers);
  else {
    // Preserve recovery of messages from the original exact-Message-ID protocol.
    if(headers['message-id']!==messageId)fail_('uncertain_email_delivery');
    if(attempt && attempt.body_sha256)verifyDeliveryBody_(message,attempt,headers);
  }
  return message.id;
}
function findSent_(messageId,recipient,attempt) {
  if(attempt && attempt.provider_message_id) {
    var direct=Gmail.Users.Messages.get('me',attempt.provider_message_id,{format:'full'});
    if(!direct || direct.id!==attempt.provider_message_id)fail_('uncertain_email_delivery');
    return verifyMail_(direct,messageId,recipient,attempt);
  }
  var query=attempt && attempt.delivery_reference?'in:sent to:'+recipient+' from:'+recipient+' "'+attempt.delivery_reference+'"':'in:sent rfc822msgid:'+messageId;
  var found=Gmail.Users.Messages.list('me',{q:query,maxResults:2});
  if((found.messages || []).length>1) fail_('uncertain_email_delivery');
  if(!found.messages || !found.messages.length) return null;
  var verified=Gmail.Users.Messages.get('me',found.messages[0].id,{format:'full'});
  if(!verified || verified.id!==found.messages[0].id)fail_('uncertain_email_delivery');
  return verifyMail_(verified,messageId,recipient,attempt);
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
function digestBody_(state,revisions,reference) {
  if(!Array.isArray(revisions) || !revisions.length)fail_('uncertain_email_delivery');
  var body='<h2>IITB placement updates</h2>';
  revisions.forEach(function(revision){
    var post=state.pending.find(function(p){return p.id===revision.id && p.fingerprint===revision.fingerprint;});
    if(!post || !['announcement','calendar_recovery'].includes(revision.channel))fail_('uncertain_email_delivery');
    body+='<h3>'+htmlEscape_(post.title)+'</h3>';
    if(revision.channel==='announcement')body+='<p>'+htmlEscape_(post.text).replace(/\n/g,'<br>')+'</p>';
    else body+='<p>The earlier calendar action has now been completed.</p>';
    body+='<p><a href="'+htmlEscape_(post.url)+'">Placement blog source</a></p>';
    if(post.calendar_result) body+='<p>'+htmlEscape_(post.calendar_result.message || '')+'</p>';
    if(post.calendar_result && post.calendar_result.start) body+='<p>Meeting start: '+htmlEscape_(Utilities.formatDate(new Date(post.calendar_result.start),'Asia/Kolkata','dd MMM yyyy, h:mm a'))+' IST.</p>';
    if(post.calendar_result && post.calendar_result.deadlines)post.calendar_result.deadlines.forEach(function(deadline){
      if(deadline.start)body+='<p>Deadline: '+htmlEscape_(Utilities.formatDate(new Date(deadline.start),'Asia/Kolkata','dd MMM yyyy, h:mm a'))+' IST. Google Calendar email reminder: one hour before.</p>';
    });
    if(post.links.length) body+='<p>'+post.links.slice(0,25).map(function(link){return '<a href="'+htmlEscape_(link.url)+'">'+htmlEscape_(link.text || link.url)+'</a>';}).join(' · ')+'</p>';
  });
  if(reference)body+='<p>Delivery reference: '+reference+'</p>';
  return body;
}
function preserveAttemptBody_(state,attempt) {
  // Capture the legacy digest before any calendar retry can change its displayed outcome.
  if(!attempt.body_sha256) {attempt.body_sha256=sha256_(canonicalMailHtml_(digestBody_(state,attempt.revisions,attempt.delivery_reference || null)));saveState_(state);}
}
function htmlMailRaw_(recipient,subject,attempt,body) {
  var recipients=attempt.recipients?validateAnnouncementRecipients_(attempt.recipients,recipient):[recipient];
  var headers=['From: '+recipient,'To: '+recipients.join(', '),'Subject: '+subjectHeader_(subject),'Message-ID: '+attempt.message_id];
  if(attempt.delivery_reference)headers.push('X-IITB-Placement-Delivery: '+attempt.delivery_reference);
  return headers.concat(['MIME-Version: 1.0','Content-Type: text/html; charset=UTF-8','Content-Transfer-Encoding: base64','',''+Utilities.base64Encode(Utilities.newBlob(body).getBytes())]).join('\r\n');
}
function announcementSubject_(posts) {
  var titles=posts.map(function(post){return normalized_(post.title).replace(/\s+/g,' ');});
  if(titles.length===1)return titles[0].slice(0,200);
  var subject='',included=0;
  titles.forEach(function(title){if(included<3 && (subject.length+title.length+3)<=180){subject+=(subject?' ; ':'')+title;included++;}});
  if(!included){subject=titles[0].slice(0,150);included=1;}
  return subject+(included<titles.length?' (+'+(titles.length-included)+' more)':'');
}
function subjectHeader_(subject) {
  subject=String(subject).replace(/[\r\n\x00-\x1f\x7f]/g,' ').trim();
  if(!subject || subject.length>220)fail_('invalid_payload');
  if(/^[\x20-\x7e]+$/.test(subject))return subject;
  var words=[],part='';
  Array.from(subject).forEach(function(character){
    if(Utilities.newBlob(part+character).getBytes().length>42){words.push('=?UTF-8?B?'+Utilities.base64Encode(Utilities.newBlob(part).getBytes())+'?=');part='';}
    part+=character;
  });
  if(part)words.push('=?UTF-8?B?'+Utilities.base64Encode(Utilities.newBlob(part).getBytes())+'?=');return words.join('\r\n ');
}
function decodedSubject_(value) {
  return String(value || '').replace(/(\?=)\s+(?==\?UTF-8\?B\?)/gi,'$1').replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi,function(_,encoded){
    try{return Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded.replace(/\+/g,'-').replace(/\//g,'_'))).getDataAsString('UTF-8');}catch(_){fail_('uncertain_email_delivery');}
  });
}
function pruneDeliveredPending_(state) {
  state.pending=state.pending.filter(function(post){return !post.notified_email_id || !post.calendar_complete || post.calendar_followup_pending;});saveState_(state);
}
function recoverSentPlacementDigest(providerMessageId) {
  // Manual owner-only repair of a legacy rewritten Message-ID; no send or calendar action occurs.
  requireOwner_();
  if(typeof providerMessageId!=='string' || !/^[A-Za-z0-9_-]{1,256}$/.test(providerMessageId))fail_('invalid_request');
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try {
    var configuration=loadConfiguration_(),state=loadState_(),attempt=state.email_attempt;
    if(!attempt)fail_('uncertain_email_delivery');
    // Require the exact pending revisions even when an expected body hash was already saved.
    digestBody_(state,attempt.revisions,attempt.delivery_reference || null);preserveAttemptBody_(state,attempt);
    var message=Gmail.Users.Messages.get('me',providerMessageId,{format:'full'});
    if(!message || message.id!==providerMessageId)fail_('uncertain_email_delivery');
    var headers=verifySentOwner_(message,configuration.recipient_email,attempt);verifyDeliveryBody_(message,attempt,headers);
    acknowledgeEmail_(state,attempt,providerMessageId);pruneDeliveredPending_(state);
    return {ok:true,recovered:true,pending_count:state.pending.length};
  } finally {lock.releaseLock();}
}
function calendarWorkResult_(state,configuration,post) {
  // Backfilled originals must not replace a newer reminder. Later substantive edits to an
  // existing post remain actionable even when WordPress retains its original publication date.
  if(post.kind==='new') {
    var meeting=parseMeeting_(post);
    if(meeting.kind==='meeting' || meeting.kind==='cancel') {
      var matched=matchingMeeting_(state,post,meeting);
      if(matched && (matched.record.source_post_ids || []).some(function(id){
        return id!==post.id && state.posts[id] && comparePublishedPosts_(Object.assign({id:id},state.posts[id]),post)>0;
      })) {
        matched.record.source_post_ids=Array.from(new Set((matched.record.source_post_ids || []).concat([post.id])));
        if(state.posts[post.id])state.posts[post.id].calendar_event_id=matched.record.event_id;
        return {kind:'superseded',message:'A newer announcement for this saved meeting already supplies its calendar details; those details were retained.'};
      }
    }
  }
  return calendarResult_(state,configuration,post);
}
function deliverPending_(state,configuration) {
  if(state.replay_attempt) recoverReplay_(state,configuration);
  if(state.email_attempt) {
    preserveAttemptBody_(state,state.email_attempt);
    var recovered=findSent_(state.email_attempt.message_id,configuration.recipient_email,state.email_attempt);
    if(!recovered) fail_('uncertain_email_delivery');
    acknowledgeEmail_(state,state.email_attempt,recovered);
  }
  // Listings arrive newest-first. Apply calendar changes oldest-first so final reminders win.
  var unfinished=state.pending.filter(function(p){return !p.calendar_complete;}).sort(comparePublishedPosts_);
  unfinished.forEach(function(post){
    try {
      var previouslyFailed=post.calendar_complete===false;
      post.calendar_result=calendarWorkResult_(state,configuration,post);post.calendar_complete=true;
      delete post.calendar_followup_pending;
      if(previouslyFailed && post.notified_email_id && ['scheduled','cancelled'].includes(post.calendar_result.kind))post.calendar_followup_pending=true;
    }
    catch (_) { post.calendar_result={kind:'ambiguous',message:'Calendar scheduling needs review; a provider result may still need verification.'};post.calendar_complete=false;delete post.calendar_followup_pending; }
    saveState_(state);
  });
  var recipients=state.pending.filter(function(p){return !p.notified_email_id || p.calendar_followup_pending;});
  if(recipients.length) {
    var revisions=recipients.map(function(p){return {id:p.id,fingerprint:p.fingerprint,channel:p.notified_email_id?'calendar_recovery':'announcement'};});
    var mailRecipients=announcementRecipients_(configuration);
    var digestId=sha256_(JSON.stringify([revisions,mailRecipients])), messageId='<iitb-placement-'+digestId+'@placement-watch.invalid>';
    var reference='IITB-PW-'+digestId;
    var subject=announcementSubject_(recipients);
    var body=digestBody_(state,revisions,reference),attempt={message_id:messageId,delivery_reference:reference,body_sha256:sha256_(canonicalMailHtml_(body)),revisions:revisions,recipients:mailRecipients,subject:subject,started_at:new Date().toISOString()};
    var raw=htmlMailRaw_(configuration.recipient_email,subject,attempt,body);
    var already=findSent_(messageId,configuration.recipient_email,attempt);
    if(already) acknowledgeEmail_(state,attempt,already);
    else {
      state.email_attempt=attempt;saveState_(state);
      // A timeout remains uncertain. Future checks use a saved provider ID or exact body reference.
      var sent=Gmail.Users.Messages.send({raw:Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/,'')},'me');
      if(!sent || !sent.id) fail_('uncertain_email_delivery');
      attempt.provider_message_id=sent.id;saveState_(state);
      var verified=Gmail.Users.Messages.get('me',sent.id,{format:'full'});
      if(!verified || verified.id!==sent.id)fail_('uncertain_email_delivery');
      verifyMail_(verified,messageId,configuration.recipient_email,attempt);
      acknowledgeEmail_(state,attempt,sent.id);
    }
  }
  pruneDeliveredPending_(state);
}
function acknowledgeReplay_(state,attempt,id) {
  if(!state.replay_deliveries)state.replay_deliveries={};
  var receipt={email_id:id,post_id:attempt.post_id,subject:attempt.subject,recipients:attempt.recipients,at:new Date().toISOString()};
  state.replay_deliveries[attempt.request_id]=receipt;state.replay_attempt=null;saveState_(state);
  return Object.assign({ok:true,resent:true},receipt);
}
function recoverReplay_(state,configuration) {
  var attempt=state.replay_attempt;
  var recovered=findSent_(attempt.message_id,configuration.recipient_email,attempt);
  if(!recovered)fail_('uncertain_email_delivery');
  return acknowledgeReplay_(state,attempt,recovered);
}
function resendAnnouncement_(configuration,payload) {
  if(!/^post-\d+$/.test(payload.post_id || '') || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.request_id || ''))fail_('invalid_payload');
  var state=loadState_(),post=state.posts[payload.post_id];
  if(!post || !post.text || !post.title || !post.published)fail_('invalid_snapshot');
  if(state.email_attempt)fail_('uncertain_email_delivery');
  if(state.replay_attempt) {
    if(state.replay_attempt.request_id!==payload.request_id || state.replay_attempt.post_id!==payload.post_id)fail_('uncertain_email_delivery');
    return recoverReplay_(state,configuration);
  }
  var saved=state.replay_deliveries && state.replay_deliveries[payload.request_id];
  if(saved) {
    if(saved.post_id!==payload.post_id)fail_('invalid_payload');
    return Object.assign({ok:true,resent:true},saved);
  }
  post=Object.assign({},post,{id:payload.post_id});post.calendar_result=calendarResult_(state,configuration,post);
  var recipients=announcementRecipients_(configuration),subject=announcementSubject_([post]);
  var hash=sha256_(JSON.stringify(['requested_resend',payload.request_id,post.id,postFingerprint_(post),recipients]));
  var reference='IITB-PW-TEST-'+hash,messageId='<iitb-placement-test-'+hash+'@placement-watch.invalid>';
  var revisions=[{id:post.id,fingerprint:post.fingerprint || postFingerprint_(post),channel:'announcement'}];
  var body=digestBody_({pending:[Object.assign({},post,{fingerprint:revisions[0].fingerprint})]},revisions,reference);
  var attempt={request_id:payload.request_id,post_id:post.id,message_id:messageId,delivery_reference:reference,body_sha256:sha256_(canonicalMailHtml_(body)),recipients:recipients,subject:subject,started_at:new Date().toISOString()};
  var prior=findSent_(messageId,configuration.recipient_email,attempt);
  if(prior)return acknowledgeReplay_(state,attempt,prior);
  state.replay_attempt=attempt;saveState_(state);
  var sent=Gmail.Users.Messages.send({raw:Utilities.base64EncodeWebSafe(Utilities.newBlob(htmlMailRaw_(configuration.recipient_email,subject,attempt,body)).getBytes()).replace(/=+$/,'')},'me');
  if(!sent || !sent.id)fail_('uncertain_email_delivery');
  attempt.provider_message_id=sent.id;saveState_(state);
  var verified=Gmail.Users.Messages.get('me',sent.id,{format:'full'});
  if(!verified || verified.id!==sent.id)fail_('uncertain_email_delivery');
  verifyMail_(verified,messageId,configuration.recipient_email,attempt);
  return acknowledgeReplay_(state,attempt,sent.id);
}
function notifyFailureOnce_(state,configuration) {
  if(!state.failure) {state.failure={episode:Utilities.getUuid(),attempted:false,notified_email_id:null};saveState_(state);}
  if(state.failure.notified_email_id)return;
  var messageId='<iitb-placement-failure-'+sha256_(state.failure.episode)+'@placement-watch.invalid>';
  var body;
  if(!state.failure.attempted && !state.failure.delivery_reference) {
    state.failure.delivery_reference='IITB-PW-FAIL-'+sha256_(state.failure.episode);
    body='<p>The IITB placement monitor could not check for updates. Your IITB session may need reconnecting, or the source may be temporarily unavailable. Check the private setup status. This notice is sent once until checks recover.</p><p>Delivery reference: '+state.failure.delivery_reference+'</p>';
    state.failure.body_sha256=sha256_(canonicalMailHtml_(body));saveState_(state);
  }
  var recovered=findSent_(messageId,configuration.recipient_email,state.failure.delivery_reference?state.failure:null);
  if(recovered){state.failure.notified_email_id=recovered;saveState_(state);return;}
  if(state.failure.attempted)return;
  state.failure.attempted=true;saveState_(state);
  if(!body)body='<p>The IITB placement monitor could not check for updates. Your IITB session may need reconnecting, or the source may be temporarily unavailable. Check the private setup status. This notice is sent once until checks recover.</p><p>Delivery reference: '+state.failure.delivery_reference+'</p>';
  var raw=htmlMailRaw_(configuration.recipient_email,'IITB placement monitor needs attention',{message_id:messageId,delivery_reference:state.failure.delivery_reference},body);
  var sent=Gmail.Users.Messages.send({raw:Utilities.base64EncodeWebSafe(Utilities.newBlob(raw).getBytes()).replace(/=+$/,'')},'me');
  if(!sent || !sent.id)return;
  state.failure.provider_message_id=sent.id;saveState_(state);
  var verified=Gmail.Users.Messages.get('me',sent.id,{format:'full'});
  if(!verified || verified.id!==sent.id)fail_('uncertain_email_delivery');
  verifyMail_(verified,messageId,configuration.recipient_email,state.failure);
  state.failure.notified_email_id=sent.id;saveState_(state);
}
