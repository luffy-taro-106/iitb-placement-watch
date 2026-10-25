import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,stat,realpath,rm,symlink,link,lstat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {installLocal,LOCAL_JOB_LABEL,LOCAL_SOURCE_FILES,launchAgentXml,validateStandaloneDependencies,inspectStandaloneNode} from '../install-local.mjs';

const syntheticBridge={url:'https://script.google.com/macros/s/fixture-deployment/exec',secret:'synthetic-installer-key-with-no-provider-access'};
const dependencies=['/usr/lib/libSystem.B.dylib'];
const mode=info=>info.mode&0o777;
async function fixture(t) {
  // macOS /var is an alias; use its canonical private path so path-safety tests
  // concern fixture-created links rather than the system's standard alias.
  const root=await mkdtemp(path.join(await realpath(tmpdir()),'placement-install-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const sourceRoot=path.join(root,'Desktop/project'),installRoot=path.join(root,'Library/Application Support/IITB Placement Watch'),launchAgentPath=path.join(root,'Library/LaunchAgents',LOCAL_JOB_LABEL+'.plist'),nodePath=path.join(root,'.cache/node');
  for(const relative of [...LOCAL_SOURCE_FILES,'private/bridge-admin.json'])await mkdir(path.dirname(path.join(sourceRoot,relative)),{recursive:true});
  for(const relative of LOCAL_SOURCE_FILES)await writeFile(path.join(sourceRoot,relative),'// synthetic '+relative+'\n');
  await writeFile(path.join(sourceRoot,'private/bridge-admin.json'),JSON.stringify(syntheticBridge),{mode:0o600});
  await mkdir(path.dirname(nodePath),{recursive:true});await writeFile(nodePath,'synthetic standalone executable\n',{mode:0o700});
  let inspections=0;const inspectNode=async filename=>{assert.equal(filename,nodePath);inspections++;return dependencies;};
  return {root,sourceRoot,installRoot,launchAgentPath,nodePath,inspectNode,options:{sourceRoot,installRoot,launchAgentPath,nodePath,inspectNode},inspections:()=>inspections};
}

test('Installer deploys a standalone owned runtime outside Desktop/cache with a single wake-aware five-minute job',async t=>{
  const f=await fixture(t),result=await installLocal(f.options);
  assert.equal(result.label,LOCAL_JOB_LABEL);assert.equal(result.launchd_reloaded,false);assert.equal(f.inspections(),1);
  assert.deepEqual(result.calendar_minutes,[0,5,10,15,20,25,30,35,40,45,50,55]);
  for(const relative of ['', 'checker','apps-script','bin','private'])assert.equal(mode(await stat(path.join(f.installRoot,relative))),0o700);
  for(const relative of LOCAL_SOURCE_FILES){const actual=await readFile(path.join(f.installRoot,relative));assert.equal(actual.toString(),'// synthetic '+relative+'\n');assert.equal(mode(await stat(path.join(f.installRoot,relative))),0o600);assert.equal(result.source_hashes[relative],createHash('sha256').update(actual).digest('hex'));}
  assert.equal(mode(await stat(path.join(f.installRoot,'bin/node'))),0o700);
  assert.equal(await readFile(path.join(f.installRoot,'bin/node'),'utf8'),'synthetic standalone executable\n');
  assert.equal(mode(await stat(path.join(f.installRoot,'private/bridge-admin.json'))),0o600);
  assert.equal(mode(await stat(f.launchAgentPath)),0o600);
  const plist=await readFile(f.launchAgentPath,'utf8');
  assert.match(plist,/<key>StartCalendarInterval<\/key>/);assert.doesNotMatch(plist,/StartInterval|KeepAlive|NetworkState/);
  assert.match(plist,/<key>RunAtLoad<\/key><true\/>/);assert.match(plist,/<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.ok(plist.includes(path.join(f.installRoot,'bin/node')));assert.ok(plist.includes(path.join(f.installRoot,'checker/local-check.mjs')));
  assert.ok(plist.includes(path.join(f.installRoot,'private/local-check.log')));assert.doesNotMatch(plist,/Desktop|\.cache/);
  assert.equal((plist.match(/<key>Minute<\/key>/g)||[]).length,12);
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes(syntheticBridge.secret));assert.ok(!serialized.includes(syntheticBridge.url));
});

test('Repeating installation updates generic code but preserves existing private configuration, status and history',async t=>{
  const f=await fixture(t);await installLocal(f.options);
  const privateRoot=path.join(f.installRoot,'private'),rotated=JSON.stringify({...syntheticBridge,secret:'synthetic-rotated-existing-key-that-must-be-preserved'});
  await writeFile(path.join(privateRoot,'bridge-admin.json'),rotated,{mode:0o600});
  await writeFile(path.join(privateRoot,'local-check-status.json'),'existing successful status\n');
  await writeFile(path.join(privateRoot,'history.json'),'existing private history\n');
  await writeFile(path.join(f.sourceRoot,'private/session-that-must-not-be-copied.json'),'synthetic excluded session');
  await writeFile(path.join(f.sourceRoot,'checker/local-check.mjs'),'// updated generic checker\n');
  const result=await installLocal(f.options);
  assert.equal(result.existing_bridge_preserved,true);
  assert.equal(await readFile(path.join(privateRoot,'bridge-admin.json'),'utf8'),rotated);
  assert.equal(await readFile(path.join(privateRoot,'local-check-status.json'),'utf8'),'existing successful status\n');
  assert.equal(await readFile(path.join(privateRoot,'history.json'),'utf8'),'existing private history\n');
  assert.equal(await readFile(path.join(f.installRoot,'checker/local-check.mjs'),'utf8'),'// updated generic checker\n');
  await assert.rejects(lstat(path.join(privateRoot,'session-that-must-not-be-copied.json')),e=>e.code==='ENOENT');
});

test('Standalone inspection rejects fragile package-manager and unresolved dynamic-library dependencies',()=>{
  assert.deepEqual(validateStandaloneDependencies('/fixture/node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n'),dependencies);
  for(const dep of ['/opt/homebrew/opt/icu4c/lib/libicu.dylib','@rpath/libnode.dylib','/Users/fixture/.cache/libnode.dylib','/usr/lib/../../unexpected.dylib'])assert.throws(()=>validateStandaloneDependencies('/fixture/node:\n\t'+dep+' (compatibility version 1.0.0, current version 1.0.0)\n'),/NODE_NOT_STANDALONE/);
  assert.throws(()=>validateStandaloneDependencies('/fixture/node:\n'),/NODE_NOT_STANDALONE/);
});

test('Unverified executable dependencies fail before any install tree or agent is created',async t=>{
  const f=await fixture(t);
  await assert.rejects(installLocal({...f.options,inspectNode:async()=>{throw new Error('NODE_NOT_STANDALONE');}}),/NODE_NOT_STANDALONE/);
  await assert.rejects(lstat(f.installRoot),e=>e.code==='ENOENT');await assert.rejects(lstat(f.launchAgentPath),e=>e.code==='ENOENT');
});

test('Installer refuses symlink roots, component paths, configuration and agent targets without touching link destinations',async t=>{
  for(const target of ['root','component','configuration','stdout','agent','source']) {
    const f=await fixture(t),outside=path.join(f.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'protected'),'keep unchanged');
    if(target==='root') {await mkdir(path.dirname(f.installRoot),{recursive:true});await symlink(outside,f.installRoot);}
    if(target==='component') {await mkdir(f.installRoot,{recursive:true});await symlink(outside,path.join(f.installRoot,'checker'));}
    if(target==='configuration') {await mkdir(path.join(f.installRoot,'private'),{recursive:true});await symlink(path.join(outside,'protected'),path.join(f.installRoot,'private/bridge-admin.json'));}
    if(target==='stdout') {await mkdir(path.join(f.installRoot,'private'),{recursive:true});await symlink(path.join(outside,'protected'),path.join(f.installRoot,'private/local-check.log'));}
    if(target==='agent') {await mkdir(path.dirname(f.launchAgentPath),{recursive:true});await symlink(path.join(outside,'protected'),f.launchAgentPath);}
    if(target==='source') {await rm(path.join(f.sourceRoot,'checker/bridge.mjs'));await symlink(path.join(outside,'protected'),path.join(f.sourceRoot,'checker/bridge.mjs'));}
    await assert.rejects(installLocal(f.options),/SYMLINK_INSTALL_PATH/,target);assert.equal(await readFile(path.join(outside,'protected'),'utf8'),'keep unchanged');
  }
});

test('Existing unrelated agents and hard-linked secret targets cannot be overwritten',async t=>{
  const f=await fixture(t);await mkdir(path.dirname(f.launchAgentPath),{recursive:true});
  const unrelated='<plist><dict><key>Label</key><string>some.other.agent</string></dict></plist>';
  await writeFile(f.launchAgentPath,unrelated);
  await assert.rejects(installLocal(f.options),/LAUNCH_AGENT_IDENTITY_MISMATCH/);assert.equal(await readFile(f.launchAgentPath,'utf8'),unrelated);
  await rm(f.launchAgentPath);await mkdir(path.join(f.installRoot,'private'),{recursive:true});
  const original=path.join(f.root,'original-config.json');await writeFile(original,JSON.stringify(syntheticBridge));await link(original,path.join(f.installRoot,'private/bridge-admin.json'));
  await assert.rejects(installLocal(f.options),/UNSAFE_INSTALL_FILE/);assert.deepEqual(JSON.parse(await readFile(original,'utf8')),syntheticBridge);
});

test('Installer rejects relative, overlapping, protected or cache destinations and escapes generated XML paths',async t=>{
  const f=await fixture(t);
  await assert.rejects(installLocal({...f.options,installRoot:'relative/path'}),/UNSAFE_INSTALL_PATH/);
  await assert.rejects(installLocal({...f.options,installRoot:path.join(f.sourceRoot,'installed')}),/UNSTABLE_INSTALL_PATH|OVERLAPPING_INSTALL_PATHS/);
  for(const installRoot of [path.join(f.root,'Desktop/Installed'),path.join(f.root,'.cache/Installed'),path.join(f.root,'Library/Caches/Installed')])await assert.rejects(installLocal({...f.options,installRoot}),/UNSTABLE_INSTALL_PATH/);
  await assert.rejects(installLocal({...f.options,launchAgentPath:path.join(f.root,'different.plist')}),/LAUNCH_AGENT_IDENTITY_MISMATCH/);
  assert.ok(launchAgentXml('/Users/fixture/Library/Application Support/A&B <Monitor>').includes('A&amp;B &lt;Monitor&gt;'));
});

test('The actual running macOS Node executable passes dependency inspection without running a job',{skip:process.platform!=='darwin'},async()=>{
  const actual=await inspectStandaloneNode(process.execPath);assert.ok(actual.length>0);assert.ok(actual.every(item=>item.startsWith('/System/Library/')||item.startsWith('/usr/lib/')));
});
