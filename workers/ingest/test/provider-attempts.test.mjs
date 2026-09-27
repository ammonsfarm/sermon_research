import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderAttempts } from '../src/provider-attempts.ts';
import { AudioTransportError, parseRetryAfter } from '../src/audio-transport.ts';

function harness(code, retryAfterSeconds, proofAt = -1) {
  const outputs=[], delays=[], names=[], policies=[]; let calls=0, checks=0;
  const step={async do(name,config,callback) {
    names.push(name); policies.push(config);
    // Simulate native serialization: returned plain data survives; Error prototypes do not.
    try { const result=await callback(); const saved=JSON.parse(JSON.stringify(result));outputs.push(saved);return saved; }
    catch(error) { throw new Error(error.message); }
  },async sleep(name,duration) { names.push(name);delays.push(duration); }};
  return {outputs,delays,names,policies,get calls(){return calls;},get checks(){return checks;},
    run:()=>runProviderAttempts(step,{name:'provider',submit:async()=>{calls++;throw new AudioTransportError(code,'unsafe X-Amz-Signature=secret',true,retryAfterSeconds);},
      classify:e=>e instanceof AudioTransportError?{code:e.code,...(e.retryAfterSeconds===undefined?{}:{retryAfterSeconds:e.retryAfterSeconds})}:null,
      reconcile:async()=>++checks===proofAt?{artifactKey:'d1:synthetic',artifactDigest:'a'.repeat(64)}:null})};
}
for (const [code,count,delays] of [
  ['transient_dependency',5,[5,10,20,40]],['throttled',8,[15,30,60,120,240,480,600]],
  ['provider_timeout_unknown',1,[30,60,120]],['authentication',1,[]],['configuration',1,[]],['invalid_input',1,[]],
]) test(`serialized ${code}: exact ${count} submissions and frozen waits`,async()=>{
  const h=harness(code);assert.deepEqual(await h.run(),{ok:false,failure:{code}});
  assert.equal(h.calls,count);assert.deepEqual(h.delays,delays.map(n=>`${n} seconds`));
  assert.equal(new Set(h.names).size,h.names.length);assert.ok(h.policies.every(c=>c.retries.limit===0&&c.timeout==='10 minutes'));
  assert.doesNotMatch(JSON.stringify(h.outputs),/X-Amz|secret/);
  assert.equal(h.checks,code==='provider_timeout_unknown'?3:0);
});
test('valid bounded Retry-After controls all seven throttle waits',async()=>{
  const h=harness('throttled',2);await h.run();assert.equal(h.calls,8);assert.deepEqual(h.delays,Array(7).fill('2 seconds'));
});
test('exact persisted evidence resumes unknown without another submission',async()=>{
  const h=harness('provider_timeout_unknown',undefined,2);assert.equal((await h.run()).ok,true);
  assert.equal(h.calls,1);assert.equal(h.checks,2);assert.deepEqual(h.delays,['30 seconds','60 seconds']);
});
test('Retry-After accepts bounded seconds and HTTP-date, discarding malformed raw values',()=>{
  const now=Date.parse('Wed, 23 Sep 2026 12:00:00 GMT');
  assert.equal(parseRetryAfter('12',now),12);assert.equal(parseRetryAfter('9999999999',now),600);
  assert.equal(parseRetryAfter('Wed, 23 Sep 2026 12:00:30 GMT',now),30);
  assert.equal(parseRetryAfter('Wed, 23 Sep 2026 13:00:00 GMT',now),600);
  assert.equal(parseRetryAfter('Wed, 23 Sep 2026 11:00:00 GMT',now),0);
  for(const raw of [null,'','-1','1.5','1e2','tomorrow','Wed, 23 Sep 2026 12:00:30 GMT secret','1\r\nsecret','1'.repeat(65)]) assert.equal(parseRetryAfter(raw,now),undefined);
});
test('malformed Retry-After falls back to frozen throttle waits',async()=>{
  const h=harness('throttled',parseRetryAfter('invalid secret'));await h.run();assert.deepEqual(h.delays,[15,30,60,120,240,480,600].map(n=>`${n} seconds`));
});
