import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Exercise native workerd fetch validation, which Node's mocked fetch cannot cover.
test('AI adapters use workerd-compatible fetch and reject redirects without forwarding credentials', async t => {
  const script = await build({bundle:true,write:false,format:'esm',platform:'browser',stdin:{
    resolveDir:process.cwd(),contents:`
      import { createOpenAiEmbeddingProvider } from '${new URL('../src/embeddings.ts',import.meta.url).pathname}';
      import { createTextGenerationProvider } from '${new URL('../src/generation.ts',import.meta.url).pathname}';
      export default {async fetch(request) {
        const context={boundary:'request',correlation:{correlationId:'test'},signal:new AbortController().signal,request:{method:'POST',path:'/test'}};
        try {
          if(new URL(request.url).pathname==='/embedding') {
            const provider=createOpenAiEmbeddingProvider({fetch:globalThis.fetch.bind(globalThis),apiKey:'synthetic'});
            const result=await provider.embedQuery(context,{text:'A',model:{provider:'openai',model:'text-embedding-3-small'},expectedDimensions:1536});
            return Response.json({dimensions:result.values.length});
          }
          const provider=createTextGenerationProvider({fetch:globalThis.fetch.bind(globalThis),siloUrl:'https://silo.example.test/chat/completions',siloKey:'synthetic',allowedModels:[{provider:'silo',model:'synthetic'}]});
          await provider.generate(context,{model:{provider:'silo',model:'synthetic'},system:'System',prompt:'A',maxOutputTokens:8,context:[{sourceId:'S1',title:'A',canonicalUrl:'https://example.test',text:'A'}]});
          return Response.json({generated:true});
        }catch(error){return Response.json({code:error.code,retryable:error.retryable},{status:503});}
      }};`
  }});
  let redirect=false;
  const calls=[];
  const runtime=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-08-15',script:script.outputFiles[0].text,
    outboundService:async request=>{
      calls.push(request.url);
      assert.equal(request.headers.get('Authorization'),'Bearer synthetic');
      if(redirect)return new Response(null,{status:302,headers:{Location:'https://forbidden.example.test'}});
      return Response.json(request.url.includes('/embeddings')
        ? {model:'text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(0)}]}
        : {choices:[{message:{content:'A [S1]'}}]});
    }
  }));
  t.after(()=>runtime.dispose());
  for(const path of ['/embedding','/generation'])assert.equal((await runtime.dispatchFetch(`http://test${path}`)).status,200);
  redirect=true;
  for(const path of ['/embedding','/generation']) {
    const response=await runtime.dispatchFetch(`http://test${path}`);
    assert.equal(response.status,503);
    assert.deepEqual(await response.json(),{code:'dependency_unavailable',retryable:false});
  }
  assert.equal(calls.length,4);
  assert.ok(calls.every(url=>!url.includes('forbidden')));
});
