function normalized_(value) { return String(value).replace(/[ \t\f\v]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim(); }
function canonicalTitle_(value) {
  return normalized_(value).toLowerCase().replace(/\b(iitb|placement|reminder|update|updated|cancelled|canceled|rescheduled|postponed)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim();
}
function meetingChangeIntent_(post,type) {
  var terms=type==='cancel'?/\b(?:cancelled|canceled|cancellation|cancelling|canceling|cancel)\b/i:/\b(?:rescheduled|rescheduling|reschedule|postponed|postponement|new time|changed time|revised time)\b/i;
  var title=normalized_(post.title), body=normalized_(post.text);
  var mentions=(title+'\n'+body).split(/[\n.!?]+/).filter(function(sentence){return terms.test(sentence);});
  if(!mentions.length)return 'absent';
  // Conditional or negated change wording is not authorization to change a saved event.
  var uncertain=/\b(?:not|never|no|if|unless|may|might|could|would|should|possible|possibly|possibility|whether|consider|considering|avoid|prevent|without|in case|subject to)\b|\b(?:isn['’]t|wasn['’]t|won['’]t|hasn['’]t|don['’]t)\b/i;
  if(mentions.some(function(sentence){return uncertain.test(sentence);}))return 'uncertain';
  if(type==='cancel') {
    if(/\b(?:cancelled|canceled)\b/i.test(title) || /^(?:\[)?cancellation\s*(?:of|:|[-–—])/i.test(title))return 'confirmed';
    return /\b(?:meeting|session|presentation|ppt|briefing|seminar|webinar|workshop|event)\b[^\n.!?]{0,100}\b(?:(?:is|was|has been|will be|stands)\s+)?(?:cancelled|canceled)\b|\b(?:we|organizers?)\s+(?:have\s+)?(?:cancelled|canceled)\b|\bstatus\s*:\s*(?:cancelled|canceled)\b/i.test(body)?'confirmed':'uncertain';
  }
  if(/\b(?:rescheduled|postponed|new time|changed time|revised time)\b/i.test(title))return 'confirmed';
  return /\b(?:meeting|session|presentation|ppt|briefing|seminar|webinar|workshop|event)\b[^\n.!?]{0,100}\b(?:rescheduled|postponed)\b|\b(?:new|changed|revised) time\s*[:\-]/i.test(body)?'confirmed':'uncertain';
}
function isReschedule_(post) {return meetingChangeIntent_(post,'reschedule')==='confirmed';}
function meetingLike_(post) {
  var phrase=/\b(meeting|session|presentation|ppt|briefing|seminar|webinar|workshop|pre[- ]placement)\b/i;
  return phrase.test(post.title) || (phrase.test(post.text) && /\b(?:date|when)\s*[:\-]/i.test(post.text) && /\b(?:time|start time)\s*[:\-]/i.test(post.text));
}
function dateParts_(value, reference) {
  var names={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  var published=new Date(Date.parse(reference)+330*60000), year=published.getUTCFullYear(), month, day, match;
  value=String(value).toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g,'$1').trim();
  if (/^(today|tomorrow)\b/.test(value)) {
    if (/^tomorrow/.test(value)) published.setUTCDate(published.getUTCDate()+1);
    return [published.getUTCFullYear(),published.getUTCMonth()+1,published.getUTCDate()];
  }
  if ((match=value.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) return checkedDate_([Number(match[1]),Number(match[2]),Number(match[3])]);
  if ((match=value.match(/^(\d{1,2})\s+([a-z]+)\.?(?:\s*,?\s*(\d{4}))?/))) {day=Number(match[1]);month=names[match[2].slice(0,3)];if(match[3]) year=Number(match[3]);}
  else if ((match=value.match(/^([a-z]+)\.?\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/))) {month=names[match[1].slice(0,3)];day=Number(match[2]);if(match[3]) year=Number(match[3]);}
  else return null;
  if (!month) return null;
  var result=checkedDate_([year,month,day]);
  if (result && !match[3] && Date.UTC(year,month-1,day)<published.getTime()-180*86400000) result=checkedDate_([year+1,month,day]);
  return result;
}
function checkedDate_(parts) {
  var value=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
  return parts[0]>=2020 && parts[0]<=2100 && value.getUTCFullYear()===parts[0] && value.getUTCMonth()+1===parts[1] && value.getUTCDate()===parts[2] ? parts : null;
}
function timeParts_(value) {
  var match=String(value).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=$|[\s,;.\-–—])/i);
  if (!match) return null;
  var hour=Number(match[1]), minute=Number(match[2] || 0), suffix=(match[3] || '').toLowerCase().replace(/\./g,'');
  if (minute>59 || (suffix && (hour<1 || hour>12)) || (!suffix && (hour>23 || (!match[2] && hour!==0) || (hour>0 && hour<13)))) return null;
  if (suffix) hour=(hour%12)+(suffix==='pm'?12:0);
  return [hour,minute,match[0].length];
}
function istInstant_(date,time) { return new Date(Date.UTC(date[0],date[1]-1,date[2],time[0],time[1])-330*60000).toISOString(); }
function parseMeeting_(post) {
  var text=post.text, cancelIntent=meetingChangeIntent_(post,'cancel'), rescheduleIntent=meetingChangeIntent_(post,'reschedule');
  if(cancelIntent==='uncertain' || rescheduleIntent==='uncertain')return {kind:'ambiguous',message:'Meeting change wording is conditional, negated or unclear; no calendar event was changed.'};
  var cancel=cancelIntent==='confirmed';
  if (!meetingLike_(post) && !cancel) return {kind:'announcement'};
  var dateMatch=text.match(/\b(?:date|when)\s*[:\-]\s*(?:[a-z]+day\s*,?\s*)?([^\n]{1,80})/i) || text.match(/\b(?:scheduled for|held on|on)\s+((?:\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}\.?|[a-z]{3,9}\.?\s+\d{1,2})(?:\s*,?\s*\d{4})?)/i) || text.match(/\b(today|tomorrow)\b/i);
  var date=dateMatch ? dateParts_(dateMatch[1],post.published) : null;
  var timeMatch=text.match(/\b(?:time|start time)\s*[:\-]\s*([^\n]{1,100})/i) || text.match(/\b(?:starts? at|begins? at)\s+([^\n]{1,100})/i);
  var time=timeMatch ? timeParts_(timeMatch[1]) : null;
  var explicitZone=text.match(/\b(?:time|start time)\s*[:\-][^.\n]{0,70}\b(UTC|GMT|EST|EDT|PST|PDT|CET|BST|JST)\b/i);
  if (cancel) return {kind:'cancel',title:post.title,source:post};
  if (!date || !time || explicitZone) return {kind:'ambiguous',message:'Meeting date, start time or timezone is unclear; no calendar event was created.'};
  var start=istInstant_(date,time), end, provisional=true;
  var remaining=timeMatch[1].slice(time[2]);
  var endMatch=remaining.match(/^\s*(?:to|[-–—])\s*(.*)/i) || text.match(/\bend time\s*[:\-]\s*(.*)/i);
  if (endMatch) {
    var endTime=timeParts_(endMatch[1]);
    if (!endTime) return {kind:'ambiguous',message:'Meeting end time is unclear; no calendar event was created.'};
    end=istInstant_(date,endTime);if(Date.parse(end)<=Date.parse(start)) end=new Date(Date.parse(end)+86400000).toISOString();
    if(Date.parse(end)-Date.parse(start)>12*3600000) return {kind:'ambiguous',message:'Meeting time range is unclear; no calendar event was created.'};
    provisional=false;
  } else end=new Date(Date.parse(start)+3600000).toISOString();
  var joining=post.links.find(function(link){return /^https:\/\/(?:[^/]+\.)?(?:teams\.microsoft\.com|teams\.live\.com|zoom\.us|meet\.google\.com|webex\.com)\//i.test(link.url);});
  var venue=text.match(/\bvenue\s*[:\-]\s*(.{1,160}?)(?=\s+(?:date|time|join|link|meeting id|passcode)\s*[:\-]|$)/i);
  return {kind:'meeting',title:post.title,start:start,end:end,provisional_end:provisional,join_url:joining?joining.url:null,venue:venue?venue[1]:'',source:post};
}
function matchingMeeting_(state, post, meeting) {
  var keys=Object.keys(state.meetings), exact=keys.filter(function(key){return (state.meetings[key].source_post_ids || []).includes(post.id);});
  if (exact.length===1) return {key:exact[0],record:state.meetings[exact[0]]};
  if (exact.length>1) fail_('calendar_review_required');
  var rescheduled=isReschedule_(post);
  var candidates=keys.filter(function(key){
    var old=state.meetings[key];
    var sourceReference=post.links.some(function(link){return link.url===old.source_url;});
    var joiningReference=post.links.some(function(link){return old.join_url && link.url===old.join_url;});
    var sameTitle=canonicalTitle_(old.title)===canonicalTitle_(post.title);
    var sameOccurrence=Date.parse(old.start)===Date.parse(meeting.start);
    // Reused meeting rooms do not establish which occurrence an announcement updates.
    return (sourceReference && (meeting.kind==='cancel' || rescheduled || sameOccurrence)) ||
      (sameTitle && (meeting.kind==='cancel' || rescheduled || sameOccurrence)) ||
      (joiningReference && sameTitle && sameOccurrence);
  });
  if (candidates.length>1) fail_('calendar_review_required');
  return candidates.length ? {key:candidates[0],record:state.meetings[candidates[0]]} : null;
}
function assertOwnedMeetingEvent_(event,configuration,post,record,key,meeting) {
  var organizer=event && event.organizer;
  if(!organizer || !(organizer.self===true || String(organizer.email || '').toLowerCase()===configuration.recipient_email.toLowerCase()))fail_('calendar_review_required');
  if((event.attendees || []).some(function(a){return String(a.email || '').toLowerCase()!==configuration.recipient_email.toLowerCase();}))fail_('calendar_review_required');
  var marker=(event.extendedProperties || {}).private || {};
  var appProof=marker.placementKey===key || marker.placementSource===post.id;
  var source=record?record.source_url:post.url;
  var titleMatch=canonicalTitle_(event.summary || '')===canonicalTitle_(record?record.title:post.title) || canonicalTitle_(event.summary || '')===canonicalTitle_(post.title);
  var start=Date.parse(event.start && event.start.dateTime), expected=Date.parse(record?record.start:meeting.start);
  var timeMatch=start===expected || (record && start===Date.parse(meeting.start));
  var recordedProof=(!record || event.id===record.event_id) && (event.description || '').includes(source) && titleMatch && timeMatch;
  if(!appProof && !recordedProof)fail_('calendar_review_required');
}
function meetingCalendarResult_(state, configuration, post) {
  var meeting=parseMeeting_(post);
  if (meeting.kind==='announcement' || meeting.kind==='ambiguous') return meeting;
  var existing=matchingMeeting_(state,post,meeting);
  if(isReschedule_(post) && !existing)return {kind:'ambiguous',message:'Reschedule could not be matched safely to one saved occurrence; no new event was created.'};
  if (meeting.kind==='cancel') {
    if (!existing) return {kind:'ambiguous',message:'Cancellation could not be matched to one saved meeting; no event was changed.'};
    var beforeCancel=Calendar.Events.get(configuration.calendar_id,existing.record.event_id);
    assertOwnedMeetingEvent_(beforeCancel,configuration,post,existing.record,existing.key,meeting);
    var cancelledSummary='[Cancelled] ' + existing.record.title;
    var cancelled=Calendar.Events.patch({summary:cancelledSummary,transparency:'transparent',visibility:'private',attendees:[],conferenceData:null,reminders:{useDefault:false,overrides:[]}},configuration.calendar_id,existing.record.event_id,{sendUpdates:'none',conferenceDataVersion:1});
    if (!cancelled || cancelled.id!==existing.record.event_id) fail_('calendar_review_required');
    var cancelReadback=Calendar.Events.get(configuration.calendar_id,existing.record.event_id);
    if(!cancelReadback || cancelReadback.summary!==cancelledSummary || cancelReadback.transparency!=='transparent' || cancelReadback.visibility!=='private' || !cancelReadback.reminders || cancelReadback.reminders.useDefault!==false || (cancelReadback.reminders.overrides || []).length || (cancelReadback.attendees || []).length || cancelReadback.conferenceData || cancelReadback.hangoutLink)fail_('calendar_review_required');
    existing.record.status='cancelled';existing.record.source_post_ids=Array.from(new Set(existing.record.source_post_ids.concat([post.id])));
    saveState_(state);
    return {kind:'cancelled',message:'The saved meeting was marked cancelled and no longer blocks your calendar.'};
  }
  if (Date.parse(meeting.start)<=Date.now()) return {kind:'past',message:'The meeting time has passed; no new event was created.'};
  var key=existing?existing.key:'meeting-' + sha256_(canonicalTitle_(meeting.title) + '|' + meeting.start);
  var eventId=existing?existing.record.event_id:'iitb' + sha256_(key);
  var current=null;
  try { current=Calendar.Events.get(configuration.calendar_id,eventId); } catch (error) {if(!/404|not found/i.test(String(error.message))) throw error;}
  if (current && current.status==='cancelled') fail_('calendar_review_required');
  if (!current && !existing) {
    // Recover provider-side identity even after an uncertain state write and a later time change.
    var bySource=Calendar.Events.list(configuration.calendar_id,{privateExtendedProperty:'placementSource='+post.id,maxResults:200,showDeleted:false});
    if(bySource.nextPageToken || (bySource.items || []).length>1)fail_('calendar_review_required');
    if((bySource.items || []).length===1) {
      current=bySource.items[0];eventId=current.id;
      key=((current.extendedProperties || {}).private || {}).placementKey || key;
    }
  }
  if (!current && !existing) {
    var found=Calendar.Events.list(configuration.calendar_id,{timeMin:new Date(Date.parse(meeting.start)-86400000).toISOString(),timeMax:new Date(Date.parse(meeting.end)+86400000).toISOString(),maxResults:200,singleEvents:true,showDeleted:false});
    if (found.nextPageToken) fail_('calendar_review_required');
    var matches=(found.items || []).filter(function(event){return (event.extendedProperties && event.extendedProperties.private && event.extendedProperties.private.placementKey===key) || ((event.description || '').includes(post.url) && canonicalTitle_(event.summary || '')===canonicalTitle_(post.title) && Date.parse(event.start && event.start.dateTime)===Date.parse(meeting.start));});
    if(matches.length>1) fail_('calendar_review_required');
    if(matches.length===1){current=matches[0];eventId=current.id;}
  }
  if(current)assertOwnedMeetingEvent_(current,configuration,post,existing?existing.record:null,key,meeting);
  var description=post.text.slice(0,7000) + '\n\nSource: ' + post.url;
  if(meeting.join_url) description+='\nOriginal joining link: ' + meeting.join_url;
  if(meeting.provisional_end) description+='\nEnd time not published; provisional one-hour slot.';
  var availability=Calendar.Events.list(configuration.calendar_id,{timeMin:meeting.start,timeMax:meeting.end,maxResults:200,singleEvents:true,showDeleted:false});
  if(availability.nextPageToken)fail_('calendar_review_required');
  var hasClash=(availability.items || []).some(function(item){return item.id!==eventId && item.status!=='cancelled' && item.transparency!=='transparent';});
  var event={summary:meeting.title,description:description,location:meeting.join_url || meeting.venue || '',start:{dateTime:meeting.start,timeZone:'Asia/Kolkata'},end:{dateTime:meeting.end,timeZone:'Asia/Kolkata'},visibility:'private',transparency:'opaque',attendees:[],conferenceData:null,reminders:{useDefault:false,overrides:[{method:'email',minutes:60},{method:'popup',minutes:30}]},extendedProperties:{private:{placementKey:key,placementSource:post.id}}};
  var result=current ? Calendar.Events.patch(event,configuration.calendar_id,eventId,{sendUpdates:'none',conferenceDataVersion:1}) : Calendar.Events.insert(Object.assign({id:eventId},event),configuration.calendar_id,{sendUpdates:'none',conferenceDataVersion:1});
  if(!result || result.id!==eventId) fail_('calendar_review_required');
  // Verify immediately, before acknowledging. Deterministic ID recovers a failed state write.
  var verified=Calendar.Events.get(configuration.calendar_id,eventId);
  if(!verified || verified.id!==eventId || Date.parse(verified.start.dateTime)!==Date.parse(meeting.start) || Date.parse(verified.end.dateTime)!==Date.parse(meeting.end) || verified.visibility!=='private' || (verified.attendees || []).length || verified.hangoutLink || verified.conferenceData || verified.reminders.useDefault!==false || !verified.reminders.overrides.some(function(r){return r.method==='email' && r.minutes===60;}) || !verified.reminders.overrides.some(function(r){return r.method==='popup' && r.minutes===30;})) fail_('calendar_review_required');
  state.meetings[key]={event_id:eventId,calendar_id:configuration.calendar_id,source_post_ids:Array.from(new Set((existing?existing.record.source_post_ids:[]).concat([post.id]))),source_url:post.url,title:meeting.title,start:meeting.start,end:meeting.end,provisional_end:meeting.provisional_end,join_url:meeting.join_url,status:'scheduled'};
  state.posts[post.id].calendar_event_id=eventId;saveState_(state);
  return {kind:'scheduled',message:'Saved to Google Calendar' + (meeting.provisional_end?' with a provisional one-hour end.':'.') + (hasClash?' Another calendar event overlaps; the published meeting time was retained.':''),start:meeting.start,provisional_end:meeting.provisional_end};
}
