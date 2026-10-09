import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {responseCache} from '../src/lib/cache.ts';

test('anonymous no-store status responses cannot retain a revoked positive result; ordinary aggregates still cache',async()=>{
  const app=express();let eligible=true,paperReads=0,boardReads=0;
  app.use(responseCache([/^\/projects\/cache-policy-fixture\/(papers|board)$/]));
  app.get('/projects/cache-policy-fixture/papers',(_req,res)=>{paperReads++;res.set('Cache-Control','no-store').json({highest:eligible});});
  app.get('/projects/cache-policy-fixture/board',(_req,res)=>{boardReads++;res.json({reads:boardReads});});
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/projects/cache-policy-fixture`;
  try {
    const first=await fetch(base+'/papers');assert.equal(first.headers.get('cache-control'),'no-store');assert.deepEqual(await first.json(),{highest:true});
    eligible=false;
    const second=await fetch(base+'/papers');assert.equal(second.headers.get('x-cache'),null);assert.equal(second.headers.get('cache-control'),'no-store');assert.deepEqual(await second.json(),{highest:false});assert.equal(paperReads,2);
    const board=await fetch(base+'/board');assert.deepEqual(await board.json(),{reads:1});
    const cached=await fetch(base+'/board');assert.equal(cached.headers.get('x-cache'),'hit');assert.deepEqual(await cached.json(),{reads:1});assert.equal(boardReads,1);
  }finally {await new Promise(resolve=>server.close(resolve));}
});
