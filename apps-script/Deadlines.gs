/* Deadline markers are separate from meeting occurrences and never invite subscribers. */
function parseDeadlines_(post) {
  var labels=/\b(deadline|last date(?: to (?:apply|register|submit))?|apply by|submit by|register by|due (?:date|by)|(?:application|registration|submission)(?:s)? (?:close|closes|closing))\s*[:\-]?\s*([^\n]{1,180})/gi;
  var results=[],match;
  while((match=labels.exec(post.text))) {
    var value=match[2].trim().replace(/(\d{1,2})(?:st|nd|rd|th)(?=[A-Za-z\s])/gi,'$1 ');
    var dateMatch=value.match(/(?:\d{4}-\d{2}-\d{2}|\d{1,2}\s+[A-Za-z]{3,9}(?:\s*,?\s*\d{4})?|[A-Za-z]{3,9}\s+\d{1,2}(?:\s*,?\s*\d{4})?|\b(?:today|tomorrow)\b)/i);
    var date=dateMatch?dateParts_(dateMatch[0],post.published):null;
    var tail=dateMatch?value.slice(dateMatch.index+dateMatch[0].length):'';
    var timeMatch=tail.match(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b\d{1,2}:\d{2}\b/i);
    var time=timeMatch?timeParts_(timeMatch[0]):null;
    var zone=tail.match(/\b(UTC|GMT|EST|EDT|PST|PDT|CET|BST|JST)\b/i);
    var label=match[1].toLowerCase().replace(/\s+/g,' '),ordinal=results.filter(function(item){return item.label===label;}).length;
    if(!date || !time || zone) {results.push({kind:'ambiguous',label:label,ordinal:ordinal,message:'A deadline date, time or timezone is unclear; check the original announcement.'});continue;}
    results.push({kind:'deadline',label:label,ordinal:ordinal,start:istInstant_(date,time)});
  }
  return results;
}
function deadlineCalendarResults_(state,configuration,post) {
  if(!state.deadlines)state.deadlines={};
  return parseDeadlines_(post).map(function(deadline){
    if(deadline.kind!=='deadline')return deadline;
    var key='deadline-'+sha256_(post.id+'|'+deadline.label+'|'+deadline.ordinal);
    var record=state.deadlines[key],eventId=record?record.event_id:'iitbd'+sha256_(key),current=null;
    if(!record && Date.parse(deadline.start)<=Date.now())return {kind:'past',message:'The deadline has passed.'};
    try{current=Calendar.Events.get(configuration.calendar_id,eventId);}catch(error){if(!/404|not found/i.test(String(error.message)))throw error;}
    if(current) {
      var organizer=current.organizer || {},marker=(current.extendedProperties || {}).private || {};
      if(current.status==='cancelled' || !(organizer.self===true || String(organizer.email || '').toLowerCase()===configuration.recipient_email.toLowerCase()) ||
        (current.attendees || []).length || marker.placementDeadlineKey!==key || marker.placementSource!==post.id)fail_('calendar_review_required');
    }
    var title=post.title+' | Deadline',end=new Date(Date.parse(deadline.start)+15*60000).toISOString();
    var description=post.text+'\n\nSource: '+post.url+'\nDeadline marker (15 minutes); email reminder one hour before the published deadline.';
    if(post.links.length)description+='\nOriginal links:\n'+post.links.map(function(link){return (link.text || 'Link')+': '+link.url;}).join('\n');
    var event={summary:title,description:description,location:'',start:{dateTime:deadline.start,timeZone:'Asia/Kolkata'},end:{dateTime:end,timeZone:'Asia/Kolkata'},
      visibility:'private',transparency:'transparent',attendees:[],conferenceData:null,reminders:{useDefault:false,overrides:[{method:'email',minutes:60},{method:'popup',minutes:30}]},
      extendedProperties:{private:{placementDeadlineKey:key,placementSource:post.id}}};
    if(!current || current.summary!==title || current.description!==description || Date.parse(current.start && current.start.dateTime)!==Date.parse(deadline.start) ||
      !current.reminders || current.reminders.useDefault!==false || !(current.reminders.overrides || []).some(function(r){return r.method==='email' && r.minutes===60;})) {
      var written=current?Calendar.Events.patch(event,configuration.calendar_id,eventId,{sendUpdates:'none',conferenceDataVersion:1}):Calendar.Events.insert(Object.assign({id:eventId},event),configuration.calendar_id,{sendUpdates:'none',conferenceDataVersion:1});
      if(!written || written.id!==eventId)fail_('calendar_review_required');
    }
    var verified=Calendar.Events.get(configuration.calendar_id,eventId);
    if(!verified || verified.id!==eventId || verified.summary!==title || verified.description!==description || Date.parse(verified.start.dateTime)!==Date.parse(deadline.start) ||
      Date.parse(verified.end.dateTime)!==Date.parse(end) || verified.visibility!=='private' || verified.transparency!=='transparent' || (verified.attendees || []).length || verified.conferenceData || verified.hangoutLink ||
      !verified.reminders || verified.reminders.useDefault!==false || !(verified.reminders.overrides || []).some(function(r){return r.method==='email' && r.minutes===60;}))fail_('calendar_review_required');
    state.deadlines[key]={event_id:eventId,post_id:post.id,source_url:post.url,title:title,start:deadline.start,end:end};
    if(state.posts[post.id])state.posts[post.id].deadline_event_ids=Array.from(new Set((state.posts[post.id].deadline_event_ids || []).concat([eventId])));
    saveState_(state);
    return {kind:'scheduled',message:'Deadline saved to Google Calendar with a one-hour email reminder.',start:deadline.start,event_id:eventId};
  });
}
function calendarResult_(state,configuration,post) {
  var meeting=meetingCalendarResult_(state,configuration,post),deadlines=deadlineCalendarResults_(state,configuration,post);
  if(!deadlines.length)return meeting;
  var messages=deadlines.map(function(deadline){return deadline.message;}).filter(Boolean);
  var kind=meeting.kind==='announcement' && deadlines.some(function(deadline){return deadline.kind==='scheduled';})?'scheduled':meeting.kind;
  return Object.assign({},meeting,{kind:kind,message:([meeting.message].filter(Boolean).concat(messages)).join(' '),deadlines:deadlines});
}
function reconcileExistingDeadlines_(state,configuration) {
  Object.keys(state.posts).map(function(id){return Object.assign({id:id,links:[]},state.posts[id]);}).filter(function(post){return post.text && post.published;})
    .forEach(function(post){deadlineCalendarResults_(state,configuration,post);});
  state.deadline_calendar_migrated=true;saveState_(state);
}
