import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {test} from 'node:test';
import redirects from 'follow-redirects';
const {http}=redirects;

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function close(server){await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}

test('drops credentials and literal custom sensitive headers across origins',async()=>{
 let received;
 const target=createServer((request,response)=>{received=request.headers;response.end('ok');});
 let redirect;
 try{
  const targetPort=await listen(target);
  redirect=createServer((_request,response)=>{response.writeHead(302,{location:`http://127.0.0.1:${targetPort}/target`});response.end();});
  const port=await listen(redirect);
  const body=await new Promise((resolve,reject)=>{
   http.get(`http://127.0.0.1:${port}/`,{headers:{Authorization:'Bearer private',Cookie:'private=value','Proxy-Authorization':'private','X-Token|Secret':'private','X-Public':'public'},sensitiveHeaders:['X-Token|Secret']},response=>{let data='';response.on('data',chunk=>{data+=chunk;});response.on('end',()=>resolve(data));}).on('error',reject);
  });
  assert.equal(body,'ok');
  for(const key of ['authorization','cookie','proxy-authorization','x-token|secret'])assert.equal(received[key],undefined);
  assert.equal(received['x-public'],'public');
 }finally{if(redirect)await close(redirect);await close(target);}
});
