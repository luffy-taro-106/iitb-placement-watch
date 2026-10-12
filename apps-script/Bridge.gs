/* Google OAuth credentials stay inside Apps Script. Never log request bodies or secrets. */
var PLACEMENT_BLOG_ = 'https://campus.placements.iitb.ac.in/blog/placement/';
var BASELINE_CUTOFF_ = '2026-10-11T10:25:30+05:30';

function fail_(code) { throw new Error(code); }
function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
function sha256_(value) {
  return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}
function hex_(bytes) { return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join(''); }
function equalHex_(a, b) {
  if (typeof a !== 'string' || !/^[a-f0-9]{64}$/.test(a) || typeof b !== 'string' || b.length !== 64) return false;
  var difference = 0;
  for (var i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function requireObject_(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail_('invalid_payload'); return value; }
function validInstant_(value, recent) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !isFinite(Date.parse(value))) fail_('invalid_timestamp');
  if (recent && Math.abs(Date.now() - Date.parse(value)) > 10 * 60000) fail_('stale_snapshot');
  return value;
}
function verifyEnvelope_(body, properties, nowSeconds) {
  requireObject_(body);
  if (!['get_session', 'save_session', 'ingest_snapshot', 'status', 'install_monitor', 'connection_diagnostics', 'configure_notifications', 'resend_announcement'].includes(body.action) || !/^[a-f0-9]{32}$/.test(body.nonce || '') || !Number.isSafeInteger(body.issued_at)) fail_('invalid_request');
  if (nowSeconds - body.issued_at > 300 || body.issued_at - nowSeconds > 60) fail_('expired_request');
  requireObject_(body.payload);
  var secret = properties.getProperty('BRIDGE_SECRET');
  if (!secret || secret.length < 32) fail_('setup_required');
  var canonical = JSON.stringify([body.action, body.nonce, body.issued_at, body.payload]);
  var expected = hex_(Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8));
  if (!equalHex_(body.signature, expected)) fail_('authentication_failed');
  var nonceKey = 'NONCE_' + body.nonce;
  if (properties.getProperty(nonceKey)) fail_('replayed_request');
  var values = properties.getProperties();
  Object.keys(values).forEach(function (key) {
    if (key.indexOf('NONCE_') === 0 && Number(values[key]) < nowSeconds) properties.deleteProperty(key);
  });
  // Persist before action execution: a failed action must be retried with a new nonce.
  properties.setProperty(nonceKey, String(nowSeconds + 600));
}
function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOutput_({ok:false, error:'busy'});
  try {
    var raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 1500000) fail_('invalid_request');
    var request;
    try { request = JSON.parse(raw); } catch (_) { fail_('invalid_request'); }
    var properties = PropertiesService.getScriptProperties();
    verifyEnvelope_(request, properties, Math.floor(Date.now() / 1000));
    var configuration = loadConfiguration_();
    if (request.action === 'get_session') return jsonOutput_({ok:true, session:loadSession_(), last_successful_check:loadState_().last_successful_check || null});
    if (request.action === 'save_session') {
      if (request.payload.source_url !== PLACEMENT_BLOG_) fail_('invalid_source');
      saveSession_(request.payload.session, validInstant_(request.payload.verified_at, true));
      return jsonOutput_({ok:true, connected:true});
    }
    if (request.action === 'status') return jsonOutput_(status_(configuration));
    if (request.action === 'connection_diagnostics') {
      if (Object.keys(request.payload).length) fail_('invalid_payload');
      requireExecutionOwner_(configuration);
      return jsonOutput_(connectionDiagnostics_(properties));
    }
    if (request.action === 'configure_notifications') {
      requireExecutionOwner_(configuration);
      if (Object.keys(request.payload).some(function(key){return key!=='announcement_recipients';})) fail_('invalid_payload');
      var updated=Object.assign({},configuration,{announcement_recipients:validateAnnouncementRecipients_(request.payload.announcement_recipients,configuration.recipient_email)});
      checkConfiguration_(updated,configuration.recipient_email.toLowerCase());
      privateWrite_('CONFIG_FILE_ID',updated);
      return jsonOutput_({ok:true,announcement_recipients:updated.announcement_recipients});
    }
    if (request.action === 'resend_announcement') {
      requireExecutionOwner_(configuration);
      if (Object.keys(request.payload).some(function(key){return !['post_id','request_id'].includes(key);})) fail_('invalid_payload');
      return jsonOutput_(resendAnnouncement_(configuration,request.payload));
    }
    if (request.action === 'install_monitor') {
      if (Object.keys(request.payload).length) fail_('invalid_payload');
      // The verified HMAC authorizes the caller. Effective user identifies only this deployment.
      requireExecutionOwner_(configuration);
      return jsonOutput_(installMonitorUnlocked_(configuration));
    }
    return jsonOutput_(ingestSnapshot_(request.payload, configuration));
  } catch (error) {
    var allowed = ['busy','invalid_request','invalid_payload','expired_request','replayed_request','authentication_failed','setup_required','invalid_source','invalid_session','invalid_timestamp','stale_snapshot','invalid_snapshot','wrong_account','private_storage_required','uncertain_email_delivery','calendar_review_required','source_connection_required','delivery_needs_review','duplicate_monitor_triggers','monitor_verification_required'];
    return jsonOutput_({ok:false, error:allowed.includes(error.message) ? error.message : 'operation_failed'});
  } finally { lock.releaseLock(); }
}
function doGet() {
  // ContentService deliberately supplies no HtmlService google.script.run RPC surface.
  return ContentService.createTextOutput('Placement Watch\nThis endpoint accepts signed requests only. Setup is managed privately by its owner in Google Apps Script.\nEnter IITB credentials and phone OTP only on IITB\u2019s official sign-in page. This service has no login form.').setMimeType(ContentService.MimeType.TEXT);
}

function connectionDiagnostics_(properties) {
  var trace;
  try {trace=JSON.parse(properties.getProperty('SOURCE_CONNECTION_TRACE') || 'null');} catch (_) {trace=null;}
  if (!trace || typeof trace.observed_at !== 'string' || !isFinite(Date.parse(trace.observed_at)) || !Array.isArray(trace.steps)) return {ok:true,observed_at:null,steps:[]};
  var stages=['sso','placement_renewal','placement_blog','campus_home','blog_chooser','campus_callback','http_redirect','unsupported_redirect'];
  var steps=trace.steps.slice(-32).filter(function(step) {return step && stages.includes(step.stage) && Number.isInteger(step.status) && step.status>=100 && step.status<=599 && typeof step.cookie_present==='boolean';})
    .map(function(step) {return {stage:step.stage,status:step.status,cookie_present:step.cookie_present};});
  return {ok:true,observed_at:new Date(trace.observed_at).toISOString(),steps:steps};
}

function googleIdentity_() {
  var profile = Gmail.Users.getProfile('me');
  if (!profile || !profile.emailAddress) fail_('wrong_account');
  return profile.emailAddress.toLowerCase();
}
function requireOwner_() {
  var active=Session.getActiveUser().getEmail();
  if(!active || active.toLowerCase()!==googleIdentity_())fail_('wrong_account');
}
function requireExecutionOwner_(configuration) {
  var effective=Session.getEffectiveUser().getEmail();
  if (!effective || effective.toLowerCase()!==configuration.recipient_email.toLowerCase()) fail_('wrong_account');
}
function assertPrivateFile_(id, owner) {
  var file = Drive.Files.get(id, {fields:'id,driveId,owners(emailAddress),shared'});
  if (file.driveId || file.shared || !file.owners || file.owners.length !== 1 || String(file.owners[0].emailAddress).toLowerCase() !== owner) fail_('private_storage_required');
  var permissions = Drive.Permissions.list(id, {fields:'permissions(type,role,emailAddress),nextPageToken',pageSize:100});
  if (permissions.nextPageToken || !permissions.permissions || permissions.permissions.length !== 1 || permissions.permissions[0].type !== 'user' || permissions.permissions[0].role !== 'owner' || String(permissions.permissions[0].emailAddress).toLowerCase() !== owner) fail_('private_storage_required');
}
function privateRead_(propertyName) {
  var id = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!id) fail_('setup_required');
  assertPrivateFile_(id, googleIdentity_());
  var response = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media', {
    headers:{Authorization:'Bearer ' + ScriptApp.getOAuthToken()}, muteHttpExceptions:true
  });
  if (response.getResponseCode() !== 200) fail_('private_storage_required');
  return JSON.parse(response.getContentText());
}
function privateWrite_(propertyName, value) {
  var id = PropertiesService.getScriptProperties().getProperty(propertyName);
  if (!id) fail_('setup_required');
  assertPrivateFile_(id, googleIdentity_());
  Drive.Files.update({}, id, Utilities.newBlob(JSON.stringify(value), 'application/json'), {fields:'id'});
}
function createPrivateFile_(name, value, owner) {
  var result = Drive.Files.create({name:name, mimeType:'application/json'}, Utilities.newBlob(JSON.stringify(value), 'application/json', name), {fields:'id'});
  assertPrivateFile_(result.id, owner);
  return result.id;
}
function checkConfiguration_(configuration, owner) {
  requireObject_(configuration);
  if (typeof configuration.recipient_email !== 'string' || configuration.recipient_email.toLowerCase() !== owner || typeof configuration.calendar_id !== 'string' || configuration.calendar_id.toLowerCase() !== owner || configuration.timezone !== 'Asia/Kolkata' || configuration.baseline_cutoff !== BASELINE_CUTOFF_) fail_('wrong_account');
  if (configuration.announcement_recipients!==undefined) validateAnnouncementRecipients_(configuration.announcement_recipients,owner);
  var primary = Calendar.CalendarList.get('primary');
  if (!primary || String(primary.id).toLowerCase() !== configuration.calendar_id.toLowerCase() || !['owner','writer'].includes(primary.accessRole)) fail_('wrong_account');
  return configuration;
}
function loadConfiguration_() { return checkConfiguration_(privateRead_('CONFIG_FILE_ID'), googleIdentity_()); }
function loadState_() { return privateRead_('STATE_FILE_ID'); }
function saveState_(state) { privateWrite_('STATE_FILE_ID', state); }
function getLastPlacementCheck_() { return loadState_().last_successful_check || null; }
function loadSession_() { return privateRead_('SESSION_FILE_ID').session || null; }
function sessionConnected_(session) {
  return !!(session && Array.isArray(session.cookies) && session.cookies.some(function(cookie){return cookie.expires === -1 || cookie.expires > Date.now()/1000;}));
}
function validateSession_(session) {
  requireObject_(session);
  if (!Array.isArray(session.cookies) || !session.cookies.length || session.cookies.length > 128 || !Array.isArray(session.origins) || session.origins.length) fail_('invalid_session');
  var allowedDomains = ['campus.placements.iitb.ac.in','sso.iitb.ac.in','iitb.ac.in'];
  var cookies = session.cookies.map(function (cookie) {
    requireObject_(cookie);
    if (typeof cookie.name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]{1,256}$/.test(cookie.name) || typeof cookie.value !== 'string' || cookie.value.length > 8192 || /[\r\n;]/.test(cookie.value) || typeof cookie.domain !== 'string' || !allowedDomains.includes(cookie.domain.toLowerCase().replace(/^\./,'')) || cookie.domain.toLowerCase()==='iitb.ac.in' || typeof cookie.path !== 'string' || cookie.path[0] !== '/' || cookie.path.length > 1024 || typeof cookie.expires!=='number' || !isFinite(cookie.expires) || cookie.expires < -1 || typeof cookie.httpOnly !== 'boolean' || cookie.secure !== true || !['Strict','Lax','None'].includes(cookie.sameSite)) fail_('invalid_session');
    return {name:cookie.name,value:cookie.value,domain:cookie.domain.toLowerCase(),path:cookie.path,expires:Number(cookie.expires),httpOnly:cookie.httpOnly,secure:true,sameSite:cookie.sameSite};
  });
  return {cookies:cookies, origins:[]};
}
function saveSession_(session, verifiedAt) {
  // Browser transfer/manual ingestion is not evidence of access from Google's servers.
  privateWrite_('SESSION_FILE_ID', {session:validateSession_(session), verified_at:verifiedAt || new Date().toISOString(), cloud_source_verification:null});
}
function saveCloudSession_(session, verifiedAt) {
  // Called only after the official source reader has completed every required page.
  validInstant_(verifiedAt,true);
  privateWrite_('SESSION_FILE_ID', {session:validateSession_(session), verified_at:verifiedAt, cloud_source_verification:{source_url:PLACEMENT_BLOG_,complete:true,observed_at:verifiedAt,verifier:'apps_script_https'}});
}
function cloudSourceVerifiedAt_(stored) {
  var proof=stored && stored.cloud_source_verification;
  return proof && proof.source_url===PLACEMENT_BLOG_ && proof.complete===true && proof.verifier==='apps_script_https' && typeof proof.observed_at==='string' && isFinite(Date.parse(proof.observed_at)) ? proof.observed_at : null;
}
function adminSetup() {
  requireOwner_();
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var properties = PropertiesService.getScriptProperties(), owner = googleIdentity_();
    if (['CONFIG_FILE_ID','STATE_FILE_ID','SESSION_FILE_ID'].every(function(key){return !!properties.getProperty(key);})) {
      loadConfiguration_();loadState_();loadSession_();
      if(!properties.getProperty('BRIDGE_SECRET')) properties.setProperty('BRIDGE_SECRET',sha256_(Utilities.getUuid()+Utilities.getUuid()));
      return {ok:true, initialized:true, secret_property:'BRIDGE_SECRET'};
    }
    var configuration, migration;
    try { configuration=JSON.parse(properties.getProperty('INIT_CONFIG_JSON')); migration=JSON.parse(properties.getProperty('INIT_MIGRATION_JSON')); } catch (_) { fail_('setup_required'); }
    checkConfiguration_(configuration, owner); requireObject_(migration);
    if (migration.baseline_cutoff !== BASELINE_CUTOFF_ || !migration.posts || !migration.meetings || !Array.isArray(migration.deliveries)) fail_('invalid_snapshot');
    var state=migrationState_(migration,configuration);
    var created={
      CONFIG_FILE_ID:createPrivateFile_('placement-watch-config.json',configuration,owner),
      STATE_FILE_ID:createPrivateFile_('placement-watch-state.json',state,owner),
      SESSION_FILE_ID:createPrivateFile_('placement-watch-session.json',{session:null,verified_at:null},owner)
    };
    // Publish identifiers together only after every private file was successfully created.
    properties.setProperties(created);
    if (!properties.getProperty('BRIDGE_SECRET')) properties.setProperty('BRIDGE_SECRET', sha256_(Utilities.getUuid() + Utilities.getUuid()));
    properties.deleteProperty('INIT_CONFIG_JSON'); properties.deleteProperty('INIT_MIGRATION_JSON');
    return {ok:true, initialized:true, secret_property:'BRIDGE_SECRET'};
  } finally { lock.releaseLock(); }
}
function inspectMonitor_(configuration) {
  var triggers=ScriptApp.getProjectTriggers().filter(function(t){return t.getHandlerFunction()==='runCheck';}), installation=null;
  try { installation=JSON.parse(PropertiesService.getScriptProperties().getProperty('MONITOR_INSTALLATION_JSON')); } catch (_) {}
  var known=triggers.length===1 && installation && installation.version===1 && installation.handler==='runCheck' && installation.interval_minutes===30 && installation.owner===configuration.recipient_email.toLowerCase() && typeof installation.trigger_id==='string' && installation.trigger_id===triggers[0].getUniqueId() && triggers[0].getEventType()===ScriptApp.EventType.CLOCK && triggers[0].getTriggerSource()===ScriptApp.TriggerSource.CLOCK;
  return {triggers:triggers,installed:!!known,error:triggers.length>1?'duplicate_monitor_triggers':triggers.length===1 && !known?'monitor_verification_required':null};
}
function status_(configuration) {
  var state=loadState_(),stored=privateRead_('SESSION_FILE_ID'),session=stored.session || null;
  var monitor=inspectMonitor_(configuration || loadConfiguration_()),connected=sessionConnected_(session),proof=cloudSourceVerifiedAt_(stored);
  var error=state.last_error ? ['source_check_failed','delivery_needs_review','calendar_needs_review','operation_failed'].includes(state.last_error)?state.last_error:'operation_failed' : null;
  return {ok:true,connected:connected,session_status:!session?'missing':!connected?'expired':proof && error!=='source_check_failed'?'cloud_verified':'saved_not_live_verified',session_verified_at:stored.verified_at || null,cloud_source_verified_at:proof,last_cloud_source_check:proof,last_successful_check:state.last_successful_check || null,last_error:error,post_count:Object.keys(state.posts).length,pending_count:state.pending.length,meeting_count:Object.keys(state.meetings).length,delivery_count:state.deliveries.length,monitor_installed:monitor.installed,interval_minutes:monitor.installed?30:null,monitor_interval_minutes:monitor.installed?30:null,needs_attention:!!state.email_attempt || !!state.replay_attempt || !!error || !!monitor.error || state.pending.some(function(p){return p.calendar_complete===false;})};
}
function runCheck() {
  var lock=LockService.getScriptLock(); if (!lock.tryLock(1000)) return {ok:false,error:'busy'};
  try {return runCheckUnlocked_();} finally {lock.releaseLock();}
}
function runCheckUnlocked_() {
  var configuration, phase='account';
  try {
    configuration=loadConfiguration_();phase='source';
    var snapshot=readPlacementSource_();
    phase='delivery';
    var result=ingestSnapshot_(snapshot, configuration);
    var state=loadState_();state.failure=null;saveState_(state);
    return result;
  } catch (_) {
    if(configuration) {
      try {
        var state=loadState_();state.last_error=phase==='source'?'source_check_failed':'delivery_needs_review';saveState_(state);
        if(phase==='source') notifyFailureOnce_(state,configuration);
      } catch (_) {}
    }
    return {ok:false,error:'check_failed',failure_phase:phase};
  }
}
function migrationState_(migration,configuration) {
  var state={version:3,baseline_cutoff:BASELINE_CUTOFF_,last_successful_check:migration.last_successful_check || null,last_error:null,posts:{},meetings:{},deliveries:[],pending:[],lease:null};
  Object.keys(migration.posts).forEach(function(id){
    var old=migration.posts[id];
    if(!/^post-\d+$/.test(id) || !old || !/^(?:[a-f0-9]{8}|[a-f0-9]{64})$/.test(old.fingerprint || '') || old.url!==PLACEMENT_BLOG_+'?p='+id.slice(5)) fail_('invalid_snapshot');
    validInstant_(old.published,false);
    state.posts[id]={fingerprint:old.fingerprint,published:old.published,title:String(old.title || '').slice(0,1000),url:old.url};
    if(old.notified_email_id)state.posts[id].notified_email_id=String(old.notified_email_id).slice(0,256);
    if(old.calendar_event_id)state.posts[id].calendar_event_id=String(old.calendar_event_id).slice(0,1024);
    if(old.text)state.posts[id].text=String(old.text).slice(0,64000);
    if(old.links)state.posts[id].links=old.links;
  });
  Object.keys(migration.meetings).forEach(function(key){
    var old=migration.meetings[key];
    if(!old || old.calendar_id!==configuration.calendar_id || !/^[a-z0-9]{5,1024}$/.test(old.event_id || '') || !Array.isArray(old.source_post_ids) || old.source_post_ids.some(function(id){return !state.posts[id];}))fail_('wrong_account');
    state.meetings[key]={event_id:old.event_id,calendar_id:configuration.calendar_id,source_post_ids:old.source_post_ids.slice(),source_url:old.source_url,title:String(old.title || '').slice(0,1000),start:validInstant_(old.start,false),end:validInstant_(old.end,false),provisional_end:old.provisional_end===true,join_url:old.join_url || null,status:old.status || 'scheduled'};
  });
  migration.deliveries.forEach(function(old){if(!old || typeof old.email_id!=='string')fail_('invalid_snapshot');state.deliveries.push({email_id:old.email_id.slice(0,256),post_ids:(old.post_ids || []).filter(function(id){return !!state.posts[id];}),at:old.at || null});});
  return state;
}
function installMonitor() {
  requireOwner_();
  var lock=LockService.getScriptLock();lock.waitLock(10000);
  try {return installMonitorUnlocked_(loadConfiguration_());} finally {lock.releaseLock();}
}
function installMonitorUnlocked_(configuration) {
  // Both callers already hold ScriptLock; never acquire it again here or in the source reader.
  var monitor=inspectMonitor_(configuration);
  if(monitor.error) fail_(monitor.error);
  var verificationStartedAt=Date.now(),result=runCheckUnlocked_();
  if(!result.ok) {
    if(result.failure_phase==='account') fail_('operation_failed');
    var failure=loadState_().last_error;
    if(failure==='source_check_failed') fail_('source_connection_required');
    if(['delivery_needs_review','calendar_needs_review'].includes(failure)) fail_('delivery_needs_review');
    fail_('operation_failed');
  }
  var checked=status_(configuration);
  if(result.needs_attention || checked.needs_attention) fail_('delivery_needs_review');
  if(!checked.connected || !checked.cloud_source_verified_at || Date.parse(checked.cloud_source_verified_at)<verificationStartedAt || Math.abs(Date.now()-Date.parse(checked.cloud_source_verified_at))>10*60000) fail_('source_connection_required');
  // Refuse an unrecognized schedule rather than guessing its interval from its handler name.
  monitor=inspectMonitor_(configuration);
  if(monitor.error) fail_(monitor.error);
  if(!monitor.installed) {
    var trigger=null,properties=PropertiesService.getScriptProperties();
    try {
      trigger=ScriptApp.newTrigger('runCheck').timeBased().everyMinutes(30).create();
      properties.setProperty('MONITOR_INSTALLATION_JSON',JSON.stringify({version:1,trigger_id:trigger.getUniqueId(),handler:'runCheck',interval_minutes:30,owner:configuration.recipient_email.toLowerCase()}));
      if(!inspectMonitor_(configuration).installed) fail_('monitor_verification_required');
    } catch(error) {
      // Roll back only the trigger this attempt created, never an existing owner's schedule.
      if(trigger) {
        try {ScriptApp.deleteTrigger(trigger);} catch(_) {}
        try {
          var saved=JSON.parse(properties.getProperty('MONITOR_INSTALLATION_JSON'));
          if(saved && saved.trigger_id===trigger.getUniqueId()) properties.deleteProperty('MONITOR_INSTALLATION_JSON');
        } catch(_) {}
      }
      throw error;
    }
  }
  if(!inspectMonitor_(configuration).installed) fail_('monitor_verification_required');
  return {ok:true,installed:true,interval_minutes:30,cloud_source_verified_at:checked.cloud_source_verified_at,last_cloud_source_check:checked.last_cloud_source_check};
}
