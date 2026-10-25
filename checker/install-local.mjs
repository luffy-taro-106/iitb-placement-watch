import {constants,createReadStream} from 'node:fs';
import {chmod,copyFile,lstat,mkdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {bridgeConfig} from './bridge.mjs';

export const LOCAL_JOB_LABEL='in.ac.iitb.placement-watch';
export const LOCAL_SOURCE_FILES=Object.freeze([
  'checker/local-check.mjs','checker/http-source.mjs','checker/bridge.mjs',
  'checker/policy.mjs','apps-script/Source.gs'
]);
const runFile=promisify(execFile);
const ownUid=process.getuid?.();
const fail=code=>{throw new Error(code);};

function absolute(value) {
  if(typeof value!=='string' || !path.isAbsolute(value) || value.includes('\0') || path.normalize(value)!==value)fail('UNSAFE_INSTALL_PATH');
  return value;
}
async function existing(value) {try{return await lstat(value);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function noSymlinks(value) {
  absolute(value);
  const parsed=path.parse(value);let current=parsed.root;
  for(const component of value.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,component);const info=await existing(current);
    if(info?.isSymbolicLink())fail('SYMLINK_INSTALL_PATH');
    if(info && current!==value && !info.isDirectory())fail('UNSAFE_INSTALL_PATH');
  }
}
function requireOwner(info) {if(ownUid!==undefined && info.uid!==ownUid)fail('INSTALL_PATH_NOT_OWNED');}
async function regularOwned(value,{required=false,executable=false}={}) {
  await noSymlinks(value);const info=await existing(value);
  if(!info){if(required)fail('INSTALL_SOURCE_MISSING');return null;}
  if(!info.isFile() || info.nlink!==1)fail('UNSAFE_INSTALL_FILE');
  requireOwner(info);
  if(executable && !(info.mode&0o111))fail('NODE_NOT_EXECUTABLE');
  return info;
}
async function privateDirectory(value) {
  await noSymlinks(value);const before=await existing(value);
  if(before){if(!before.isDirectory())fail('UNSAFE_INSTALL_PATH');requireOwner(before);}
  await mkdir(value,{recursive:true,mode:0o700});await chmod(value,0o700);
}
async function atomicWrite(destination,contents,mode=0o600) {
  await regularOwned(destination);
  const temporary=destination+'.install-'+randomUUID();
  try {
    await writeFile(temporary,contents,{flag:'wx',mode});
    await chmod(temporary,mode);await regularOwned(destination);await rename(temporary,destination);
  } finally {await rm(temporary,{force:true});}
}
async function atomicCopy(source,destination,mode) {
  await regularOwned(destination);
  const temporary=destination+'.install-'+randomUUID();
  try {
    await copyFile(source,temporary,constants.COPYFILE_EXCL);await chmod(temporary,mode);
    await regularOwned(destination);await rename(temporary,destination);
  } finally {await rm(temporary,{force:true});}
}
async function fileHash(filename) {
  const hash=createHash('sha256');for await(const chunk of createReadStream(filename))hash.update(chunk);return hash.digest('hex');
}

// A copied Node must not depend on Homebrew Cellar paths, @rpath libraries or the
// Codex cache. The system libraries remain available at their signed OS locations.
export function validateStandaloneDependencies(output) {
  if(typeof output!=='string')fail('NODE_DEPENDENCIES_UNVERIFIED');
  const lines=output.trim().split(/\r?\n/).slice(1).filter(line=>line.trim());
  const dependencies=lines.map(line=>line.trim().match(/^(\S+)\s+\(compatibility version /)?.[1]);
  if(!dependencies.length || dependencies.some(item=>!item || item.split('/').includes('..') || !['/System/Library/','/usr/lib/'].some(prefix=>item.startsWith(prefix))))fail('NODE_NOT_STANDALONE');
  return dependencies;
}
export async function inspectStandaloneNode(nodePath) {
  const {stdout}=await runFile('/usr/bin/otool',['-L',nodePath],{encoding:'utf8',timeout:10000,maxBuffer:1000000});
  return validateStandaloneDependencies(stdout);
}
function xml(value) {return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
export function launchAgentXml(installRoot) {
  absolute(installRoot);
  const minutes=Array.from({length:12},(_,i)=>i*5);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'+
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'+
    '<plist version="1.0"><dict>\n'+
    '<key>Label</key><string>'+LOCAL_JOB_LABEL+'</string>\n'+
    '<key>ProgramArguments</key><array><string>'+xml(path.join(installRoot,'bin/node'))+'</string><string>'+xml(path.join(installRoot,'checker/local-check.mjs'))+'</string></array>\n'+
    '<key>WorkingDirectory</key><string>'+xml(installRoot)+'</string>\n'+
    '<key>RunAtLoad</key><true/>\n<key>ThrottleInterval</key><integer>30</integer>\n'+
    '<key>StartCalendarInterval</key><array>'+minutes.map(minute=>'<dict><key>Minute</key><integer>'+minute+'</integer></dict>').join('')+'</array>\n'+
    '<key>StandardOutPath</key><string>'+xml(path.join(installRoot,'private/local-check.log'))+'</string>\n'+
    '<key>StandardErrorPath</key><string>'+xml(path.join(installRoot,'private/local-check-error.log'))+'</string>\n'+
    '<key>ProcessType</key><string>Background</string>\n<key>Umask</key><integer>63</integer>\n'+
    '<key>ExitTimeOut</key><integer>30</integer>\n</dict></plist>\n';
}
function validateBridgeBytes(bytes) {
  if(bytes.length>16384)fail('INVALID_PRIVATE_BRIDGE_CONFIGURATION');
  let config;try{config=JSON.parse(bytes.toString('utf8'));}catch{fail('INVALID_PRIVATE_BRIDGE_CONFIGURATION');}
  if(!config || typeof config!=='object' || Array.isArray(config))fail('INVALID_PRIVATE_BRIDGE_CONFIGURATION');
  // Validation is local only; never contact a provider or expose the key in a receipt.
  try{bridgeConfig({IITB_BRIDGE_URL:config.url,IITB_HMAC_SECRET:config.secret});}catch{fail('INVALID_PRIVATE_BRIDGE_CONFIGURATION');}
}

export async function installLocal({
  sourceRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,''),
  installRoot=path.join(homedir(),'Library/Application Support/IITB Placement Watch'),
  launchAgentPath=path.join(homedir(),'Library/LaunchAgents',LOCAL_JOB_LABEL+'.plist'),
  nodePath=process.execPath,inspectNode=inspectStandaloneNode
}={}) {
  [sourceRoot,installRoot,launchAgentPath,nodePath].forEach(absolute);
  if([installRoot,launchAgentPath].some(value=>value.split(path.sep).some(part=>part==='Desktop' || part==='.cache') || value.includes(path.sep+'Library'+path.sep+'Caches'+path.sep)))fail('UNSTABLE_INSTALL_PATH');
  if(path.basename(launchAgentPath)!==LOCAL_JOB_LABEL+'.plist')fail('LAUNCH_AGENT_IDENTITY_MISMATCH');
  if(sourceRoot===installRoot || installRoot.startsWith(sourceRoot+path.sep) || sourceRoot.startsWith(installRoot+path.sep))fail('OVERLAPPING_INSTALL_PATHS');
  await noSymlinks(sourceRoot);const sourceDirectory=await existing(sourceRoot);
  if(!sourceDirectory?.isDirectory())fail('INSTALL_SOURCE_MISSING');requireOwner(sourceDirectory);
  await noSymlinks(installRoot);await noSymlinks(path.dirname(launchAgentPath));
  for(const relative of LOCAL_SOURCE_FILES)await regularOwned(path.join(sourceRoot,relative),{required:true});
  await regularOwned(nodePath,{required:true,executable:true});
  const dependencies=await inspectNode(nodePath);
  if(!Array.isArray(dependencies) || !dependencies.length)fail('NODE_DEPENDENCIES_UNVERIFIED');
  // Preflight every overwritten target before changing any installed component.
  for(const relative of [...LOCAL_SOURCE_FILES,'bin/node','private/bridge-admin.json','private/install-receipt.json','private/local-check-status.json','private/local-check.log','private/local-check-error.log'])await regularOwned(path.join(installRoot,relative));
  const currentAgent=await regularOwned(launchAgentPath);
  if(currentAgent){const text=await readFile(launchAgentPath,'utf8');if(!new RegExp('<key>Label</key>\\s*<string>'+LOCAL_JOB_LABEL.replace(/\./g,'\\.')+'</string>').test(text))fail('LAUNCH_AGENT_IDENTITY_MISMATCH');}
  const bridgeTarget=path.join(installRoot,'private/bridge-admin.json'),preserveBridge=!!await existing(bridgeTarget);
  const bridgeSource=preserveBridge?bridgeTarget:path.join(sourceRoot,'private/bridge-admin.json');
  await regularOwned(bridgeSource,{required:true});const bridgeBytes=await readFile(bridgeSource);validateBridgeBytes(bridgeBytes);
  for(const relative of ['', 'checker','apps-script','bin','private'])await privateDirectory(path.join(installRoot,relative));
  const agentDirectory=path.dirname(launchAgentPath),agentDirectoryExists=await existing(agentDirectory);
  if(!agentDirectoryExists)await privateDirectory(agentDirectory);
  else {if(!agentDirectoryExists.isDirectory())fail('UNSAFE_INSTALL_PATH');requireOwner(agentDirectoryExists);}
  const hashes={};
  for(const relative of LOCAL_SOURCE_FILES){const destination=path.join(installRoot,relative);await atomicCopy(path.join(sourceRoot,relative),destination,0o600);hashes[relative]=await fileHash(destination);}
  const deployedNode=path.join(installRoot,'bin/node');await atomicCopy(nodePath,deployedNode,0o700);hashes['bin/node']=await fileHash(deployedNode);
  if(!preserveBridge)await atomicWrite(bridgeTarget,bridgeBytes);else await chmod(bridgeTarget,0o600);
  await atomicWrite(launchAgentPath,launchAgentXml(installRoot));
  const receipt={installed_at:new Date().toISOString(),label:LOCAL_JOB_LABEL,install_root:installRoot,launch_agent_path:launchAgentPath,calendar_minutes:Array.from({length:12},(_,i)=>i*5),run_at_load:true,node_dependencies:dependencies,source_hashes:hashes,existing_bridge_preserved:preserveBridge,requires_awake_network_connected_mac:true,launchd_reloaded:false};
  await atomicWrite(path.join(installRoot,'private/install-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  if(args.includes('--help'))console.log('node checker/install-local.mjs [--source PATH] [--install-root PATH] [--launch-agent PATH] [--node PATH]\nWrites the owner-only installation and existing-label LaunchAgent. Reload that agent separately. No network or power changes.');
  else {
    const names={'--source':'sourceRoot','--install-root':'installRoot','--launch-agent':'launchAgentPath','--node':'nodePath'},options={};
    try {
      for(let i=0;i<args.length;i+=2){if(!names[args[i]] || !args[i+1] || Object.hasOwn(options,names[args[i]]))fail('INVALID_INSTALL_ARGUMENTS');options[names[args[i]]]=args[i+1];}
      const result=await installLocal(options);console.log(JSON.stringify({installed:true,label:result.label,install_root:result.install_root,launch_agent_path:result.launch_agent_path,launchd_reloaded:false}));
    }catch(error){console.error(/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_INSTALL_FAILED');process.exitCode=1;}
  }
}
