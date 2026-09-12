import {test} from 'node:test'
import assert from 'node:assert/strict'
import {run,resolveCommand} from './run.ts'
import {probe} from './health.ts'

test('secret redaction survives output chunk boundaries',async()=>{
  const lines:string[]=[]
  const result=await run(process.execPath,['-e',`process.stdout.write('FAKE_');setTimeout(()=>process.stdout.write('TOKEN_123\\n'),50)`],{secretValues:['FAKE_TOKEN_123'],timeoutMs:3000,onLine:(_,s)=>lines.push(s)})
  assert.doesNotMatch(result.stdout,/FAKE_TOKEN_123/)
  assert.doesNotMatch(lines.join(''),/FAKE_TOKEN_123/)
})
test('npx arguments bypass Windows shell expansion',()=>{
  if(process.platform!=='win32')return
  const result=resolveCommand('npx',['-y','some-package','C:\\demo%PATH%\\hello & bye'])
  assert.equal(result.shell,false)
  assert.ok(result.args.includes('C:\\demo%PATH%\\hello & bye'))
})
test('probe terminates an unresponsive process',async()=>{
  const result=await probe({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],timeoutMs:250})
  assert.equal(result.reachable,false)
  assert.match(result.error!,/timed out/)
})
test('probe does not accept malformed tool lists as healthy',async()=>{
  const script=`require('node:readline').createInterface({input:process.stdin}).on('line',l=>{let m=JSON.parse(l);if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}))})`
  const result=await probe({command:process.execPath,args:['-e',script],timeoutMs:3000})
  assert.equal(result.reachable,false)
})
