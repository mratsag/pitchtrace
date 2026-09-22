import '../helpers/setup-env.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { renderPage } from '../../src/audit/browser.js';

function listen(server:http.Server):Promise<string>{
  return new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>{
    const address=server.address(); if(!address||typeof address==='string') throw new Error('no address');
    resolve(`http://127.0.0.1:${address.port}`);
  }));
}
function close(server:http.Server):Promise<void>{return new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}

describe('alt kaynak redirect SSRF koruması',()=>{
  let fixture:http.Server; let target:http.Server; let origin=''; let targetOrigin=''; let targetHits=0; const fixtureHits:string[]=[];
  before(async()=>{
    target=http.createServer((_req,res)=>{targetHits+=1;res.end('must not be reached');});
    target.on('upgrade',(req,socket)=>{targetHits+=1;socket.destroy();});
    targetOrigin=await listen(target);
    fixture=http.createServer((req,res)=>{
      const path=new URL(req.url??'/','http://fixture').pathname;
      fixtureHits.push(path);
      const redirect=(location:string)=>{res.writeHead(302,{location});res.end();};
      if(path==='/attack.html'){
        res.writeHead(200,{'content-type':'text/html; charset=utf-8'});
        res.end(`<!doctype html><html><head><title>SSRF güvenlik fixture</title>
          <link rel="stylesheet" href="/r/css"><link rel="stylesheet" href="/r/public">
          <style>@font-face{font-family:x;src:url('http://[fd00::1]/font.woff2')}body{font-family:x}</style>
          <script src="/r/js"></script></head><body><h1>Güvenli içerik</h1>
          <img src="/r/image"><iframe src="http://169.254.169.254/latest/meta-data/"></iframe>
          <script>
            fetch('/r/fetch').catch(()=>{});
            new WebSocket('${targetOrigin.replace('http','ws')}/socket');
            window.open('${targetOrigin}/popup');
          </script></body></html>`); return;
      }
      if(path==='/safe.css'){res.writeHead(200,{'content-type':'text/css'});res.end('body{background:#fff}');return;}
      if(path==='/r/public'){redirect('/safe.css');return;}
      if(path==='/r/css'){redirect('http://169.254.169.254/latest/meta-data/');return;}
      if(path==='/r/js'){redirect(`${targetOrigin}/script.js`);return;}
      if(path==='/r/image'){redirect('http://10.23.45.67/private.png');return;}
      if(path==='/r/fetch'){redirect('/r/fetch-2');return;}
      if(path==='/r/fetch-2'){redirect('http://192.168.77.2/data');return;}
      res.writeHead(404);res.end();
    });
    origin=await listen(fixture);
  });
  after(async()=>{await close(fixture);await close(target);});

  it('CSS/JS/görsel/font/iframe/fetch/WebSocket/popup hedeflerini bağlantıdan önce engeller',async()=>{
    targetHits=0;
    const result=await renderPage({entryUrl:`${origin}/attack.html`,allowLoopback:true});
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(targetHits,0,'özel hedef sunucuya hiçbir HTTP/WebSocket isteği ulaşmamalı');
    const blocked=result.blockedResources;
    const diagnostic=JSON.stringify({blocked,subresources:result.subresourceUrls,fixtureHits});
    assert.ok(blocked.some(x=>x.url.includes('169.254.169.254')&&x.resourceType==='stylesheet'),diagnostic);
    assert.ok(blocked.some(x=>x.url.includes(targetOrigin)&&x.resourceType==='script'),JSON.stringify(blocked));
    assert.ok(blocked.some(x=>x.url.includes('10.23.45.67')&&x.resourceType==='image'),JSON.stringify(blocked));
    assert.ok(blocked.some(x=>x.url.includes('[fd00::1]')&&x.resourceType==='font'),JSON.stringify(blocked));
    assert.ok(blocked.some(x=>x.url.includes('169.254.169.254')&&x.resourceType==='document'),JSON.stringify(blocked));
    assert.ok(blocked.some(x=>x.url.includes('192.168.77.2')&&['fetch','xhr'].includes(x.resourceType)),JSON.stringify(blocked));
    assert.ok(result.subresourceUrls.some(x=>x.endsWith('/r/public')),'public → public redirect çalışmalı');
    assert.ok(result.screenshot.byteLength>1000,'güvenli sayfa screenshot üretmeli');
    assert.equal(result.observations.title,'SSRF güvenlik fixture');
  });
});
