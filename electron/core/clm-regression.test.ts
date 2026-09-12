import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deactivate, activate, runtimeState } from './clm/state.ts'
import { applyProfile, currentProfile } from './clm/profiles.ts'
import * as dormant from './clm/dormant.ts'
function seed() { const h=mkdtempSync(join(tmpdir(),'agentpack-clm-'));process.env.AGENTPACK_HOME=h;return h }
test('Claude remote entry survives dormancy including credentials and custom fields',()=>{
 const h=seed();const entry={type:'http',url:'https://example.com/mcp',headers:{Authorization:'fake-token'},custom:true};
 writeFileSync(join(h,'.claude.json'),JSON.stringify({mcpServers:{github:entry}}));
 assert.equal(deactivate('github','claude').success,true);assert.equal(activate('github','claude').success,true);
 assert.deepEqual(JSON.parse(readFileSync(join(h,'.claude.json'),'utf8')).mcpServers.github,entry)
})
test('Codex native dormancy preserves disabled flag and custom values',()=>{
 const h=seed();mkdirSync(join(h,'.codex'));const p=join(h,'.codex','config.toml');
 writeFileSync(p,'[mcp_servers.playwright]\ncommand="npx"\nargs=[]\nenabled=false\nstartup_timeout_sec=45\n');
 assert.equal(runtimeState('playwright','codex'),'dormant');assert.equal(activate('playwright','codex').success,true);assert.equal(deactivate('playwright','codex').success,true);
 assert.match(readFileSync(p,'utf8'),/startup_timeout_sec=45/);assert.equal(dormant.get('playwright','codex'),null)
})
test('Logging failure cannot roll back activation after dropping credentials',()=>{
 const h=seed();writeFileSync(join(h,'.claude.json'),JSON.stringify({mcpServers:{github:{command:'npx',args:[],env:{TOKEN:'fake'}}}}));
 assert.equal(deactivate('github','claude').success,true);const p=join(h,'.agentpack','mutations.json');unlinkSync(p);mkdirSync(p);
 assert.equal(activate('github','claude').success,true);assert.equal(runtimeState('github','claude'),'active')
})
test('Profile cannot succeed when requested capabilities are missing',()=>{
 const h=seed();writeFileSync(join(h,'.claude.json'),'{}');assert.equal(applyProfile('frontend',['claude']).status,'failed')
})
test('Mixed agent states cannot match a profile',()=>{
 const h=seed();writeFileSync(join(h,'.claude.json'),JSON.stringify({mcpServers:{playwright:{command:'npx',args:[]}}}));mkdirSync(join(h,'.config','opencode'),{recursive:true});writeFileSync(join(h,'.config','opencode','opencode.json'),JSON.stringify({mcp:{playwright:{type:'local',command:['npx'],enabled:false}}}));
 assert.equal(currentProfile(['claude','opencode']),null)
})
test('Corrupt dormant store is preserved and blocks stash mutation',()=>{
 const h=seed();mkdirSync(join(h,'.agentpack'));const p=join(h,'.agentpack','dormant.json');writeFileSync(p,'{broken');
 assert.throws(()=>dormant.stash('github','claude',{command:'npx',args:[],env:{}}));assert.equal(readFileSync(p,'utf8'),'{broken')
})

import { getCapability } from './capabilities/registry.ts'
import { measureCost, cachedCost, estimateCost, costPath } from './clm/cost.ts'
import { clmView } from './clm/view.ts'
test('Concurrent measurements merge cache and redact server error credentials',async()=>{
 seed()
 const script=`require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(!m.id)return;setTimeout(()=>console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'fixture_tool',description:'test',inputSchema:{type:'object'}}]}})),30)})`
 const a={...getCapability('playwright'),install:{command:process.execPath,args:['-e',script]}}
 const b={...a,id:'second-fixture'}
 const [ca,cb]=await Promise.all([measureCost(a),measureCost(b)])
 assert.equal(ca.source,'measured');assert.equal(cb.source,'measured');assert.equal(cachedCost(a)?.source,'measured');assert.equal(cachedCost(b)?.source,'measured')
 const failing={...a,id:'retry-fixture',install:{command:process.execPath,args:['-e',`console.error(process.env.FAKE_SECRET);process.exit(1)`]}}
 const failed=await measureCost(failing,{secrets:{FAKE_SECRET:'fake-sensitive'}})
 assert.equal(failed.source,'unavailable');assert.ok(!readFileSync(costPath(),'utf8').includes('fake-sensitive'))
})
test('Cached uninstalled schemas do not inflate installed baseline',()=>{
 const h=seed();writeFileSync(join(h,'.claude.json'),'{}');mkdirSync(join(h,'.agentpack'),{recursive:true})
 const cap=getCapability('playwright');const key=createHash('sha256').update(JSON.stringify([cap.id,cap.install!.command,cap.install!.args])).digest('hex');writeFileSync(costPath(),JSON.stringify({[key]:estimateCost([{name:'fake',inputSchema:{type:'object'}}])}))
 assert.equal(clmView(['claude']).summary.allTokens,0)
})
import { adapters } from './agents/index.ts'
test('Failed dormancy rolls back its entry while preserving an intervening unrelated edit',()=>{
 const h=seed();const p=join(h,'.config','opencode','opencode.json');mkdirSync(join(h,'.config','opencode'),{recursive:true});writeFileSync(p,JSON.stringify({mcp:{playwright:{type:'local',command:['npx'],enabled:true}}}));
 const validate=adapters.opencode.validate;let injected=false
 adapters.opencode.validate=function(){const cfg=JSON.parse(readFileSync(p,'utf8'));if(!injected && cfg.mcp.playwright.enabled===false){injected=true;cfg.theme='user-change';writeFileSync(p,JSON.stringify(cfg));return {ok:false,error:'injected post-write validation failure'}}return validate.call(this)}
 try { assert.equal(deactivate('playwright','opencode').success,false);const cfg=JSON.parse(readFileSync(p,'utf8'));assert.equal(cfg.mcp.playwright.enabled,true);assert.equal(cfg.theme,'user-change') } finally {adapters.opencode.validate=validate}
})
