// Real Edge layout check. The server must use isolated synthetic runtime data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const output = resolve('outputs/dialog-storage-smoke-20261011');
await mkdir(output, {recursive:true});
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=9238',
   '--user-data-dir='+resolve('.tmp-ui-check/dialog-storage-20261011'),'about:blank'],
  {windowsHide:true,stdio:'ignore'});
const delay = ms => new Promise(r=>setTimeout(r,ms));
let ws;
try {
  let targets;
  for (let i=0;i<40;i++) {
    try { targets = await (await fetch('http://127.0.0.1:9238/json/list')).json(); if(targets.some(t=>t.type==='page'))break; } catch {}
    await delay(250);
  }
  assert(targets);
  ws = new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
  let id=0;
  const pending=new Map();
  ws.addEventListener('message',event=>{
    const reply=JSON.parse(event.data), item=pending.get(reply.id);
    if(item){pending.delete(reply.id);clearTimeout(item.timer);reply.error?item.reject(new Error(JSON.stringify(reply.error))):item.resolve(reply.result);}
  });
  function call(method,params={}) {
    return new Promise((resolve,reject)=>{
      const key=++id;
      const timer=setTimeout(()=>{pending.delete(key);reject(new Error('CDP timeout: '+method));},15000);
      pending.set(key,{resolve,reject,timer});ws.send(JSON.stringify({id:key,method,params}));
    });
  }
  async function run(expression){
    const r=await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.pywebview={api:{get_installation_info:async()=>({applicationDirectory:'D:/Edge Office',modelsDirectory:'E:/Models'}),choose_model_directory:async(id)=>{window.chosenModel=id;return {cancelled:true}}}};`});
  await call('Page.navigate',{url:'http://127.0.0.1:18173/'});
  for(let i=0;i<60;i++){if(await run(`!!document.querySelector('#source-scope-button') && !!document.querySelector('[data-model-directory]')`))break;await delay(200);}
  assert(await run(`!!document.querySelector('[data-model-directory]')`),'Native download directory control missing');
  for(let i=0;i<60;i++){
    if(await run(`!document.querySelector('#app-splash') || document.querySelector('#app-splash').classList.contains('hidden')`))break;
    await delay(100);
  }
  const results=[];
  for(const [width,height] of [[1440,920],[390,667]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await run(`document.querySelector('.onboarding-header button')?.click(); document.querySelector('#open-settings').click(); document.querySelectorAll('#settings-layer details').forEach(el=>el.open=true);`);
    await delay(350);
    const settings=await run(`(() => {
      const body=document.querySelector('#settings-layer .dialog-body'), close=document.querySelector('#close-settings');
      const before=close.getBoundingClientRect();body.scrollTop=body.scrollHeight;
      const after=close.getBoundingClientRect(),center=document.elementFromPoint(after.x+after.width/2,after.y+after.height/2);
      return {before:before.y,after:after.y,visible:after.y>=0 && after.bottom<innerHeight,clickable:center===close || close.contains(center),hit:center?.outerHTML?.slice(0,200),scrolled:body.scrollTop};
    })()`);
    await writeFile(resolve(output,`settings-${width}.png`),Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
    assert(settings.scrolled>0);assert(Math.abs(settings.before-settings.after)<1);assert(settings.visible&&settings.clickable,JSON.stringify({width,height,settings}));
    await run(`document.querySelector('#close-settings').click()`);
    assert(await run(`document.querySelector('#settings-layer').classList.contains('hidden')`));
    await run(`document.querySelector('#source-scope-button').click();for(let i=0;i<40;i++){const p=document.createElement('p');p.textContent='测试长提示内容 '+i;document.querySelector('.experience-dialog .dialog-body').append(p);}`);
    const prompt=await run(`(() => {
      const el=document.querySelector('.experience-dialog'),body=el.querySelector('.dialog-body'),close=el.querySelector('.dialog-heading button');
      const before=close.getBoundingClientRect().y;body.scrollTop=body.scrollHeight;const after=close.getBoundingClientRect();
      const top=document.elementFromPoint(after.x+after.width/2,after.y+after.height/2);
      return {before,after:after.y,visible:after.y>=0&&after.bottom<innerHeight,clickable:top===close||close.contains(top),scrolled:body.scrollTop};
    })()`);
    assert(prompt.scrolled>0);assert(Math.abs(prompt.before-prompt.after)<1);assert(prompt.visible&&prompt.clickable);
    await run(`document.querySelector('.experience-dialog .dialog-heading button').click()`);
    await delay(100);
    assert(await run(`!document.querySelector('.experience-dialog')`));
    await run(`document.querySelector('#open-settings').click();document.querySelector('#restart-onboarding').click()`);
    const onboarding=await run(`(() => {const close=document.querySelector('.onboarding-header button'),body=document.querySelector('.onboarding-step.active');const y=close.getBoundingClientRect().y;body.scrollTop=body.scrollHeight;const b=close.getBoundingClientRect();return {before:y,after:b.y,visible:b.y>=0&&b.bottom<innerHeight};})()`);
    assert(Math.abs(onboarding.before-onboarding.after)<1);assert(onboarding.visible);
    await run(`document.querySelector('.onboarding-header button').click()`);
    await delay(100);
    assert(await run(`document.querySelector('#onboarding-layer').classList.contains('hidden')`));
    results.push({width,height,settings,prompt,onboarding});
  }
  await run(`document.querySelector('#open-settings').click();document.querySelector('[data-model-directory="qwen3.5-4b-office"]').click()`);
  await delay(200);
  assert.equal(await run(`window.chosenModel`),'qwen3.5-4b-office');
  await writeFile(resolve(output,'report.json'),JSON.stringify({passed:true,results,native_picker_cancel:true},null,2));
  console.log(JSON.stringify({passed:true,viewports:results.map(r=>[r.width,r.height]),output}));
  await call('Browser.close');
} finally {
  ws?.close();edge.kill();
}
