#!/usr/bin/env node
// Node 22+: node tests/browser/run.mjs [http://127.0.0.1:<cdp-port>]
// No DSH server, credentials, dependencies, or existing browser pages are used.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const fixtureURL = new URL('./fixture.html', import.meta.url);
const clientURL = new URL('../../lib/client.js', import.meta.url);
const resultsURL = new URL('./results.json', import.meta.url);
const startedAt = new Date().toISOString();
const results = [], errors = [];
let pluginVersion = null, sourceSha256 = null, clientSource, fixtureSource;
let chrome, profile, socket, origin, targetId, chromeFailure;
let seq = 0, attempted = 0;
const pending = new Map();
const abort = new AbortController();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error?.stack || String(error);
const recordError = (phase, error) => {
  errors.push({ phase, message: errorText(error) });
  console.error('FAIL ' + phase + ': ' + errorText(error));
};
const save = status => writeFile(resultsURL, JSON.stringify({
  pluginVersion, sourceSha256, startedAt, finishedAt: status === 'running' ? null : new Date().toISOString(),
  status, attempted, passed: results, errors,
}, null, 2) + '\n');
function rejectPending(error) {
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
  pending.clear();
}
const interrupt = signal => { abort.abort(new Error('Interrupted by ' + signal)); rejectPending(abort.signal.reason); };
const onINT = () => interrupt('SIGINT');
const onTERM = () => interrupt('SIGTERM');
process.on('SIGINT', onINT);
process.on('SIGTERM', onTERM);
const deadline = setTimeout(() => interrupt('120-second suite deadline'), 120000);

async function http(path, options = {}, cleanup = false) {
  const response = await fetch(origin + path, {
    ...options,
    signal: cleanup ? AbortSignal.timeout(5000) : AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}: ${path}`);
  return response;
}
async function startChrome() {
  profile = await mkdtemp(join(tmpdir(), 'dsh-fonts-browser-'));
  const executable = process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : 'google-chrome');
  chrome = spawn(executable, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  chrome.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  chrome.on('error', error => { chromeFailure = error; });
  chrome.on('exit', (code, signal) => {
    chromeFailure ||= new Error(`Chrome exited (${code ?? signal})\n${stderr}`);
  });
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    if (chromeFailure) throw chromeFailure;
    let port;
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (/^\d+$/.test(port || '')) return `http://127.0.0.1:${port}`;
    await sleep(50);
  }
  throw new Error('Chrome startup timed out\n' + stderr);
}
async function connect(url) {
  socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params.exceptionDetails;
      recordError('page exception', new Error(detail.exception?.description || detail.text));
    }
  });
  socket.addEventListener('close', () => rejectPending(new Error('CDP socket closed')));
  socket.addEventListener('error', () => rejectPending(new Error('CDP socket error')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('CDP connection timed out')), 10000);
    const stop = () => finish(abort.signal.reason);
    const open = () => finish();
    const fail = () => finish(new Error('CDP connection failed'));
    function finish(error) {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', stop);
      socket.removeEventListener('open', open);
      socket.removeEventListener('error', fail);
      socket.removeEventListener('close', fail);
      error ? reject(error) : resolve();
    }
    socket.addEventListener('open', open, { once: true });
    socket.addEventListener('error', fail, { once: true });
    socket.addEventListener('close', fail, { once: true });
    abort.signal.addEventListener('abort', stop, { once: true });
    if (abort.signal.aborted) stop();
  });
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    abort.signal.throwIfAborted();
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('CDP is not connected');
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP request timed out: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}
const run = async code => {
  const response = await send('Runtime.evaluate', { expression: '(async()=>{' + code + '})()', awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
};
const step = code => run(code + ';await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); return {status:window.__dshAnthropicFonts.streamFadeStatus(),ranges:__ranges()}');
const test = async (name, fn) => {
  abort.signal.throwIfAborted();
  attempted++;
  try { await fn(); results.push(name); console.log('PASS ' + name); }
  catch (error) { recordError(name, error); }
};

try {
  // Truncate any previous success before reading metadata or starting Chrome.
  await save('running');
  pluginVersion = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  const source = await readFile(clientURL);
  sourceSha256 = createHash('sha256').update(source).digest('hex');
  clientSource = source.toString('utf8');
  fixtureSource = await readFile(fixtureURL, 'utf8');
  await save('running');
  if (process.argv.length > 3) throw new Error('Usage: node tests/browser/run.mjs [CDP HTTP origin]');
  if (process.argv[2]) {
    const supplied = new URL(process.argv[2]);
    if (!['http:', 'https:'].includes(supplied.protocol) || supplied.username || supplied.password || supplied.pathname !== '/' || supplied.search || supplied.hash) {
      throw new Error('Expected a CDP HTTP origin without credentials, path, query, or fragment');
    }
    origin = supplied.origin;
  } else origin = await startChrome();
  // Always create our own target. Never enumerate, reuse, or navigate existing pages.
  const page = await (await http('/json/new?about:blank', { method: 'PUT' })).json();
  targetId = page.id;
  if (!targetId || !page.webSocketDebuggerUrl) throw new Error('CDP did not return a new page target');
  await connect(page.webSocketDebuggerUrl);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const navigation = await send('Page.navigate', { url: fixtureURL.href });
  if (navigation.errorText) throw new Error(navigation.errorText);
  const readyUntil = Date.now() + 10000;
  while (!await run('return !!window.__dshAnthropicFonts')) {
    if (Date.now() >= readyUntil) throw new Error('Fixture initialization timed out');
    await sleep(25);
  }
  assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().version'), pluginVersion, 'fixture loaded a different plugin version');
await test('hydrate existing live text without replay',async()=>{assert.equal((await run('return __ranges()')).length,0)});
await test('fade an append, preserving stable prefix',async()=>{const r=await step('text.firstChild.appendData("第一批")');assert.equal(r.ranges.slice().sort((a,b)=>a.offset-b.offset).map(x=>x.text).join(''),'第一批');assert.equal(r.status.active,1)});
await test('replace the entire text node without losing older fades',async()=>{const r=await step('text.textContent += "第二批"');const joined20=r.ranges.slice().sort((a,b)=>a.offset-b.offset).map(x=>x.text).join('');assert.ok(joined20.includes('第一批')&&joined20.includes('第二批'),joined20);assert.ok(r.status.remapped>0)});
await test('a repaint resumes the fade instead of restarting it',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="resume"><div data-streaming="true" id="resumeBody"><p id="resumeP">起点</p></div></section>\')');await step('resumeP.firstChild.appendData("这一批文字正在淡入过程中会被宿主重渲染")');await new Promise(r=>setTimeout(r,60));const before=await run('return __ranges().filter(x=>x.text.includes("这一")).map(x=>Number((x.color.match(/ ([\\d.]+)%/)||[0,0])[1]))[0]');await step('resumeP.innerHTML=resumeP.innerHTML');const after=await run('return __ranges().filter(x=>x.text.includes("这一")).map(x=>Number((x.color.match(/ ([\\d.]+)%/)||[0,0])[1]))[0]');assert.ok(before>20,'fade should have advanced before the repaint: '+before);assert.ok(after>=before-6,'repaint must not restart the fade: '+before+" -> "+after)});
await test('batches longer than 48 characters still fade',async()=>{const r=await step('text.firstChild.appendData("长".repeat(120))');const total=r.ranges.filter(x=>/^长+$/.test(x.text)).reduce((s,x)=>s+x.text.length,0);assert.equal(total,120)});
await test('RAF commits are faded before their very first paint',async()=>{const r=await run('return await new Promise(resolve=>requestAnimationFrame(()=>{text.firstChild.appendData("首帧检查");queueMicrotask(()=>queueMicrotask(()=>resolve(__ranges())))}))');const chunk=r.find(x=>x.text.includes('首'));assert.ok(chunk,'new text was exposed at full color before paint');assert.ok(Number(chunk.color.match(/ ([\d.]+)%/)[1])<30)});
await test('replacing the streaming root keeps opacity moving forward',async()=>{const before=await run('return __ranges().find(x=>x.text.includes("首"))');const r=await step('body.outerHTML=body.outerHTML');const after=r.ranges.find(x=>x.text.includes('首'));assert.ok(after);assert.ok(Number(after.color.match(/ ([\d.]+)%/)[1])>=Number(before.color.match(/ ([\d.]+)%/)[1]))});
await test('reasoning and response never steal each other’s deltas',async()=>{await step('body.insertAdjacentHTML("beforeend",\'<div data-variant="think" data-state="running" data-expanded="true" id="think"><div data-disclosure-header>思考标题</div><p id="thought">现有思考</p></div>\')');const r=await step('thought.firstChild.appendData("新增思考");text.firstChild.appendData("新增正文")');assert.ok(r.ranges.some(x=>x.text.includes('思考')));assert.ok(r.ranges.some(x=>x.text.includes('正文')));assert.ok(r.ranges.every(x=>!x.text.includes('思考标题')))});
await test('code and controls stay outside prose highlights',async()=>{const r=await step('text.insertAdjacentHTML("beforeend",\'<span>新</span><code>excluded-code</code><a href="#">链接</a><button>excluded-button</button>\')');assert.ok(r.ranges.some(x=>x.parent==='CODE'),'inline code now fades with the sentence');assert.ok(r.ranges.some(x=>x.parent==='A'&&x.ink==='rgb(0, 100, 220)'));assert.ok(r.ranges.every(x=>x.parent!=='BUTTON'))});
await test('completed historical messages do not fade',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().seen');const r=await step('document.querySelector("main").insertAdjacentHTML("afterbegin",\'<section data-chat-flow-key="history" data-chat-flow-kind="assistant-step"><div data-message-bubble>历史内容</div></section>\')');assert.equal(r.status.seen,before)});
await test('collapsed reasoning preview transitions without title animation',async()=>{await step('think.removeAttribute("data-expanded");think.innerHTML=\'<div data-disclosure-header><span>思考</span><span data-streaming="true" id="summary">上一段预览</span><span aria-hidden="true">装饰副本</span></div>\'');const r=await step('summary.textContent="下一段预览"');assert.ok(r.ranges.some(x=>x.text.startsWith('下')));assert.ok(Number(r.ranges.find(x=>x.text.startsWith('下')).color.match(/ ([\d.]+)%/)[1])>=55);assert.ok(r.ranges.every(x=>!x.text.includes('装饰副本')))});
await test('new tool header enters once without changing height',async()=>{const r=await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="tool-1" data-chat-flow-kind="tool-call" id="toolSeat"><div data-variant="read" data-tool="read" data-state="running" id="tool"><div data-disclosure-header id="toolHeader">读取文件</div><pre>tool-output</pre></div></section>\')');assert.equal(r.status.rowsActive,1);const a=await run('return {h:toolHeader.getBoundingClientRect().height,frames:toolHeader.getAnimations()[0].effect.getKeyframes()}');assert.ok(a.frames.every(x=>!x.height));const moves=a.frames.map(x=>x.transform).filter(Boolean);assert.ok(moves.length>0);assert.ok(moves.every(t=>t==='none'||/^translateY\([1-6](?:\.\d+)?px\)$/.test(t)),'rise must stay at or under 6px: '+JSON.stringify(moves));await new Promise(r=>setTimeout(r,190));assert.ok(Math.abs((await run('return toolHeader.getBoundingClientRect().height'))-a.h)<0.6)});
await test('running-to-complete and row replacement never replay entry',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().rowsSeen');const r=await step('tool.dataset.state="ok";toolSeat.innerHTML=toolSeat.innerHTML');assert.equal(r.status.rowsSeen,before);assert.equal(r.status.rowsActive,0)});
await test('newly loaded completed tool history has no entry animation',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().rowsSeen');const r=await step('const scope=document.createElement("main");scope.dataset.conversationRegion="chat";scope.innerHTML=\'<section data-chat-flow-key="old-tool"><div data-variant="read" data-state="ok">历史工具</div></section>\';document.body.append(scope)');assert.equal(r.status.rowsSeen,before)});
await test('nested process groups do not double-animate output',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="group" id="processGroup"><section data-chat-flow-key="nested"><div data-streaming="true" id="nestedText">初始</div></section></section>\')');const before=await run('return __dshAnthropicFonts.streamFadeStatus().seen');const r=await step('nestedText.firstChild.appendData("只算一次")');assert.equal(r.status.seen,before+1);assert.equal(r.ranges.filter(x=>/^[只算一次]+$/.test(x.text)).reduce((n,x)=>n+x.text.length,0),4)});
await test('switching conversation location does not replay the current tail',async()=>{const r=await step('location.hash="next-conversation";nestedText.firstChild.appendData("切换后的旧内容")');assert.equal(r.ranges.length,0)});
await test('reduced motion clears running effects immediately',async()=>{await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await new Promise(r=>setTimeout(r,150));assert.equal((await run('return __ranges()')).length,0);assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().enabled'),false);await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})});
await test('live disable and re-enable do not replay content',async()=>{const r=await run('__dshAnthropicFonts.setStreamFadeEnabled(false);return {ranges:__ranges(),status:__dshAnthropicFonts.streamFadeStatus()}');assert.equal(r.ranges.length,0);assert.equal(r.status.enabled,false);await run('__dshAnthropicFonts.setStreamFadeEnabled(true)');assert.equal((await run('return __ranges()')).length,0)});
await test('final Markdown commit preserves the final batch fade',async()=>{await step('text.firstChild.appendData("最终批次")');const r=await step('body.removeAttribute("data-streaming");text.innerHTML=text.innerHTML');assert.ok(r.ranges.slice().sort((a,b)=>a.offset-b.offset).map(x=>x.text).join('').includes('最终批次'))});
await test('all highlights settle and leave no visual residue',async()=>{await new Promise(r=>setTimeout(r,720));assert.equal((await run('return __ranges()')).length,0)});
await test('disclosure setup matches host mount and unmount behavior',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="disclosure"><div data-variant="think" data-state="ok" id="dBox"><div id="dWrap"><div data-disclosure-header style="height:24px"><div role="button" tabindex="0" aria-expanded="false" id="dTrigger" style="height:24px;line-height:24px">展开思考</div></div></div></div></section>\');window.__dCalls=0;window.__toggleD=()=>{__dCalls++;const open=dTrigger.getAttribute("aria-expanded")!=="true";dTrigger.setAttribute("aria-expanded",String(open));dBox.toggleAttribute("data-expanded",open);dWrap.toggleAttribute("data-open",open);if(open){const content=document.createElement("div");content.id="dContent";content.style.height="240px";content.textContent="展开内容";dWrap.append(content)}else document.getElementById("dContent")?.remove()};dTrigger.onclick=__toggleD;dTrigger.onkeydown=e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();__toggleD()}}');await new Promise(r=>setTimeout(r,200))});
await test('opening reveals content through intermediate heights',async()=>{const r=await step('dTrigger.click()');const h=await run('return dBox.getBoundingClientRect().height');assert.equal(await run('return dTrigger.getAttribute("aria-expanded")'),'true');assert.ok(h>24&&h<264,{h});await new Promise(r=>setTimeout(r,250));assert.equal(await run('return dBox.getBoundingClientRect().height'),264);assert.equal(await run('return dBox.getAnimations().length'),0)});
await test('closing keeps content mounted until the smooth collapse finishes',async()=>{await run('dTrigger.click()');assert.equal(await run('return !!document.getElementById("dContent")'),true);await new Promise(r=>setTimeout(r,80));const h=await run('return dBox.getBoundingClientRect().height');assert.ok(h>24&&h<264,{h});await new Promise(r=>setTimeout(r,180));assert.equal(await run('return !!document.getElementById("dContent")'),false);assert.equal(await run('return dBox.getBoundingClientRect().height'),24)});
await test('keyboard disclosure uses the same animated lifecycle',async()=>{await step('dTrigger.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');assert.equal(await run('return dTrigger.getAttribute("aria-expanded")'),'true');await new Promise(r=>setTimeout(r,250));await run('dTrigger.dispatchEvent(new KeyboardEvent("keydown",{key:" ",bubbles:true,cancelable:true}))');assert.equal(await run('return !!document.getElementById("dContent")'),true);await new Promise(r=>setTimeout(r,250));assert.equal(await run('return !!document.getElementById("dContent")'),false)});
await test('reversing a collapse keeps the host open without delayed re-close',async()=>{await step('dTrigger.click()');await new Promise(r=>setTimeout(r,250));const count=await run('return __dCalls');await run('dTrigger.click()');await new Promise(r=>setTimeout(r,60));await run('dTrigger.click()');await new Promise(r=>setTimeout(r,260));assert.equal(await run('return __dCalls'),count);assert.equal(await run('return dBox.getBoundingClientRect().height'),264);assert.equal(await run('return !!document.getElementById("dContent")'),true)});
await test('same-frame collapse reversal releases its animation owner', async () => {
  const r=await run('dTrigger.click();dTrigger.click();return {open:dTrigger.getAttribute("aria-expanded"),active:__dshAnthropicFonts.streamFadeStatus().disclosuresActive}');
  assert.equal(r.open,'true');
  assert.equal(r.active,0,'an immediate reversal has no height to animate and must release its owner');
});
await test('native arrow buttons close once with Enter and Space', async () => {
  await run(`const seat=document.createElement('section');seat.dataset.chatFlowKey='native-disclosure';seat.innerHTML='<div data-variant="read" data-state="ok" id="nBox"><div id="nWrap"><div data-disclosure-header style="height:24px"><button id="nTrigger" aria-expanded="false">Read output</button></div></div></div>';document.querySelector('main').append(seat);window.__nCalls=0;nTrigger.onclick=()=>{__nCalls++;const open=nTrigger.getAttribute('aria-expanded')!=='true';nTrigger.setAttribute('aria-expanded',String(open));if(open){const c=document.createElement('div');c.id='nContent';c.style.height='160px';nWrap.append(c)}else document.getElementById('nContent')?.remove()}`);
  for (const key of ['Enter', ' ']) {
    await run('nTrigger.click();nTrigger.focus()');
    await new Promise(r=>setTimeout(r,250));
    const before=await run('return __nCalls');
    const code=key==='Enter'?'Enter':'Space';
    const vk=key==='Enter'?13:32;
    await send('Emulation.setFocusEmulationEnabled',{enabled:true});
    await send('Input.dispatchKeyEvent',{type:'rawKeyDown',key,code,windowsVirtualKeyCode:vk});
    await send('Input.dispatchKeyEvent',{type:'char',text:key==='Enter'?'\r':' '});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:vk});
    await new Promise(r=>setTimeout(r,300));
    assert.equal(await run('return nTrigger.getAttribute("aria-expanded")'),'false',code+' must close');
    assert.equal(await run('return __nCalls'),before+1,code+' must toggle exactly once');
    assert.equal(await run('return nBox.getAnimations().length'),0);
  }
  await run('nBox.closest("section").remove()');
});
await test('independent header actions are not intercepted as disclosure gestures', async () => {
  await run(`window.__accessoryCalls=0;const b=document.createElement('button');b.id='dAccessory';b.textContent='Copy';b.onclick=e=>{e.stopPropagation();__accessoryCalls++};dTrigger.append(b)`);
  const before=await run('return __dCalls');
  await run('dAccessory.click()');
  await new Promise(r=>setTimeout(r,260));
  assert.equal(await run('return __accessoryCalls'),1);
  assert.equal(await run('return __dCalls'),before);
  assert.equal(await run('return dTrigger.getAttribute("aria-expanded")'),'true');
  await run('dAccessory.remove()');
});
await test('reduced motion makes disclosure clicks immediate',async()=>{await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await run('dTrigger.click()');assert.equal(await run('return !!document.getElementById("dContent")'),false);assert.equal(await run('return dBox.getAnimations().length'),0);await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]})});
await test('sidebar drag freezes distant history and pauses optional paints',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="distant" id="distant" style="margin-top:4000px;width:600px"><p>\'+"很长的历史文字内容。".repeat(100)+\'</p></section>\');const handle=document.createElement("div");handle.id="resizeHandle";handle.dataset.side="rightbar";document.body.append(handle)');const before=await run('return distant.getBoundingClientRect().height');const r=await step('resizeHandle.dispatchEvent(new PointerEvent("pointerdown",{button:0,pointerId:7,bubbles:true}));distant.style.width="180px"');assert.equal(r.status.resizing,true);assert.equal(r.status.enabled,false);assert.ok(r.status.frozenHistory>0);assert.equal(await run('return distant.getBoundingClientRect().height'),before);assert.equal(await run('return getComputedStyle(distant).contentVisibility'),'hidden')});
await test('ending a drag restores full layout and motion',async()=>{const r=await step('resizeHandle.dispatchEvent(new PointerEvent("pointerup",{button:0,pointerId:7,bubbles:true}))');assert.equal(r.status.resizing,false);assert.equal(r.status.enabled,true);assert.equal(await run('return distant.hasAttribute("data-daf-resize-frozen")'),false);assert.equal(await run('return distant.style.getPropertyValue("--daf-resize-height")'),'');assert.equal(await run('return getComputedStyle(distant).contentVisibility'),'visible')});
await test('scroll and pointer cancellation never leave blank history',async()=>{await run('resizeHandle.dispatchEvent(new PointerEvent("pointerdown",{button:0,pointerId:8,bubbles:true}))');const frozenBefore=await run('return document.querySelectorAll("[data-daf-resize-frozen]").length');assert.ok(frozenBefore>0,'drag should freeze history outside the viewport');await run('document.querySelector("main").dispatchEvent(new Event("scroll"))');assert.equal(await run('return [...document.querySelectorAll("[data-daf-resize-frozen]")].filter(el=>{const r=el.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight}).length'),0);assert.equal(await run('return document.querySelectorAll("[data-daf-resize-frozen]").length'),frozenBefore);await step('resizeHandle.dispatchEvent(new PointerEvent("pointercancel",{pointerId:8,bubbles:true}))');assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().resizing'),false);assert.equal(await run('return document.querySelectorAll("[data-daf-resize-frozen]").length'),0)});
await test('removing a streaming message clears its fade and state',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="leak" id="leakSeat"><div data-streaming="true" id="leakText">开始</div></section>\')');await step('leakText.firstChild.appendData("泄漏测试")');assert.equal((await run('return __ranges().filter(r=>r.text.includes("泄漏")).length')),1);await step('leakSeat.remove()');await new Promise(r=>setTimeout(r,80));assert.equal((await run('return __ranges().filter(r=>r.text.includes("泄漏")).length')),0);assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().active'),0)});
await test('a host that commits a frame late still animates the open',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="deferred"><div data-variant="think" data-state="ok" id="pBox"><div id="pWrap"><div data-disclosure-header style="height:24px"><div role="button" tabindex="0" aria-expanded="false" id="pTrigger" style="height:24px">延迟提交</div></div></div></div></section>\')');await run('pTrigger.onclick=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(pTrigger.getAttribute("aria-expanded")==="true")return;pTrigger.setAttribute("aria-expanded","true");pBox.setAttribute("data-expanded","");pWrap.setAttribute("data-open","");const c=document.createElement("div");c.id="pContent";c.style.height="200px";c.textContent="延迟内容";pWrap.append(c)}))');const heights=await run('pTrigger.click();const seen=[];const start=performance.now();await new Promise(done=>{const sample=()=>{seen.push(pBox.getBoundingClientRect().height);if(performance.now()-start<420)requestAnimationFrame(sample);else done()};requestAnimationFrame(sample)});return seen');assert.equal(await run('return !!document.getElementById("pContent")'),true);assert.ok(heights.some(h=>h>40&&h<210),'open never passed through intermediate heights: '+JSON.stringify(heights));assert.equal(await run('return pBox.getAnimations().length'),0);assert.equal(await run('return pBox.getBoundingClientRect().height'),224)});
await test('settled history is never walked at install',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().seen');await step('const old=document.createElement("main");old.dataset.conversationRegion="chat";old.innerHTML=Array.from({length:40},(_,i)=>\'<section data-chat-flow-key="h\'+i+\'"><div data-message-bubble>历史段落内容</div></section>\').join("");document.body.append(old)');await new Promise(r=>setTimeout(r,80));assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().seen'),before)});
await test('selected text is never painted by the fade',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="select"><div data-streaming="true" id="selBody"><p id="selP">选中测试文本</p></div></section>\')');await step('selP.firstChild.appendData("新批")');assert.ok((await run('return __ranges().filter(r=>r.text.includes("新批")).length')>0));const selected=await run('const range=document.createRange();range.selectNodeContents(selP.firstChild);const s=getSelection();s.removeAllRanges();s.addRange(range);window.dispatchEvent(new Event("selectionchange"));document.dispatchEvent(new Event("selectionchange"));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return {ranges:__ranges().filter(r=>r.text.includes("新批")).length,selected:s.toString().length}');assert.ok(selected.selected>0);assert.equal(selected.ranges,0);const cleared=await run('getSelection().removeAllRanges();document.dispatchEvent(new Event("selectionchange"));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return __ranges().filter(r=>r.text.includes("新批")).length');assert.ok(cleared>0)});
await test('a later line never starts before the previous line is fully bright',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="order" data-chat-flow-kind="assistant-step"><div data-streaming="true" id="ordBody"><p id="ordP"></p></div></section>\')');const r=await run(`const p=document.getElementById('ordP');p.append(document.createTextNode(''));p.firstChild.appendData('第一行结束。'+String.fromCharCode(10,10)+'第二行开始，后面还有字。');const node=p.firstChild;await new Promise(r=>requestAnimationFrame(r));const levels=()=>{const lv=new Array(node.data.length).fill(100);for(const [name,hi] of CSS.highlights){const level=Number(name.slice('daf-fade-'.length));if(!Number.isFinite(level))continue;const pct=Math.round(level*100/15);for(const rg of hi){if(rg.startContainer!==node)continue;for(let i=rg.startOffset;i<rg.endOffset;i++)lv[i]=pct}}return lv};const t0=performance.now();while(performance.now()-t0<2000){const lv=levels();if(lv[8]>0)return {tail:lv[5],head:lv[8],ms:Math.round(performance.now()-t0)};await new Promise(r=>setTimeout(r,20))}return null`);assert.ok(r,'second line never started');assert.ok(r.tail>=93,'previous line was still dim when the next started: '+JSON.stringify(r))});
await test('a new rendered block waits for the previous block to finish fading',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="blockOrder" data-chat-flow-kind="assistant-step"><div data-streaming="true" id="boBody"><p id="boA"></p><p id="boB"></p></div></section>\')');const r=await run(`const sleep=ms=>new Promise(r=>setTimeout(r,ms));const a=document.getElementById('boA');const b=document.getElementById('boB');a.append(document.createTextNode(''));b.append(document.createTextNode(''));await sleep(80);const line1='第一行：前面还有一句话，that line.';const line2='Also need to double check P1 精编 says 14:37。';const levelsOf=el=>{const node=el.firstChild;const levels=new Array(node.data.length).fill(null);for(const [name,hi] of CSS.highlights){const level=Number(name.slice('daf-fade-'.length));if(!Number.isFinite(level))continue;const pct=Math.round(level*100/15);for(const rg of hi){if(rg.startContainer!==node)continue;for(let i=rg.startOffset;i<rg.endOffset;i++)levels[i]=pct}}return levels};a.firstChild.appendData(line1);await sleep(60);b.firstChild.appendData(line2);const t0=performance.now();while(performance.now()-t0<2500){const head=levelsOf(b)[0];if(head!==null&&head>0){const la=levelsOf(a);return {tail:la[line1.length-1]??100,head:head,ms:Math.round(performance.now()-t0)}}await sleep(20)}return null`);assert.ok(r,'second block never started');assert.ok(r.tail>=93,'previous block was still dim when the next started: '+JSON.stringify(r))});
await test('same-commit even-length paragraphs retain their boundary', async () => {
  await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="evenBlocks"><div data-streaming="true" id="evenBody"></div></section>\')');
  const r=await run(`evenBody.innerHTML='<p id="evenA">ABCD</p><p id="evenB">EFGH</p>';const level=(el,i)=>{for(const [name,hi] of CSS.highlights){if(!name.startsWith('daf-fade-'))continue;for(const r of hi){if(r.startContainer===el.firstChild&&r.startOffset<=i&&r.endOffset>i)return Number(name.slice(9))*100/15}}return 100};await new Promise(r=>requestAnimationFrame(r));const start=performance.now();while(performance.now()-start<2000){const head=level(evenB,0);if(head>0)return {head,tail:level(evenA,3)};await new Promise(r=>requestAnimationFrame(r))}return null`);
  assert.ok(r,'second paragraph must become visible');
  assert.equal(r.tail,100,'previous paragraph must finish: '+JSON.stringify(r));
  await run('evenBody.closest("section").remove()');
});
await test('a wholesale append releases already queued hidden characters', async () => {
  await new Promise(r=>setTimeout(r,1800));
  await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="wholesale"><div data-streaming="true" id="wholesaleBody"><p id="wholesaleText">seed</p></div></section>\')');
  const queued=await step('wholesaleText.firstChild.appendData("Q".repeat(120))');
  assert.ok(queued.ranges.some(r=>r.parentId==='wholesaleText'&&r.name==='daf-fade-0'),'setup must include unreleased characters');
  await step('wholesaleText.firstChild.appendData("X".repeat(513))');
  await step('wholesaleBody.removeAttribute("data-streaming")');
  await new Promise(r=>setTimeout(r,700));
  assert.equal(await run('return __ranges().filter(r=>r.parentId==="wholesaleText").length'),0,'no permanently hidden prefix');
  assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().active'),0,'RAF queue must settle');
  await run('wholesaleBody.closest("section").remove()');
});
await test('inline code fades with its sentence and never animates',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="chipSeat"><div data-streaming="true" id="chipBody"><p id="chipP">说明文字</p></div></section>\')');const r=await step('chipP.insertAdjacentHTML("beforeend",\'<code id="chip">queueMicrotask()</code>\')');const codeRanges=r.ranges.filter(x=>x.parentId==='chip');assert.equal(codeRanges.reduce((n,x)=>n+x.text.length,0),16,'code text should be ranged with the sentence');assert.equal(await run('return document.getElementById("chip").getAnimations().length'),0);const again=await step('chipP.innerHTML=chipP.innerHTML');assert.ok(again.ranges.some(x=>x.parentId==='chip'))});
await test('history code never animates or fades',async()=>{await run('document.querySelector("main").insertAdjacentHTML("afterbegin",\'<section data-chat-flow-key="chipOld"><div data-message-bubble><p>旧 <code id="oldChip">git status</code></p></div></section>\')');await new Promise(r=>setTimeout(r,60));assert.equal(await run('return document.querySelector(\'[data-chat-flow-key="chipOld"] code\').getAnimations().length'),0);assert.equal(await run('return __ranges().filter(x=>x.parentId==="oldChip").length'),0)});
await test('fade stays at 120 ms while cadence is tracked',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="cadence"><div data-streaming="true" id="cadText">起点</div></section>\')');for(let i=0;i<6;i+=1){await step('cadText.firstChild.appendData("慢速批次")');await new Promise(r=>setTimeout(r,200))}const s=await run('return __dshAnthropicFonts.streamFadeStatus()');assert.equal(s.duration,120);assert.ok(s.cadence>150,'cadence should still be tracked: '+s.cadence)});
await test('a long batch fades as one unit with no deferred tail',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="ordered"><div data-streaming="true" id="ordText"></div></section>\')');const r=await step('ordText.append("尾".repeat(120))');assert.equal(r.status.spread,0);const tail=r.ranges.filter(x=>/^尾+$/.test(x.text));assert.equal(tail.reduce((s,x)=>s+x.text.length,0),120);assert.ok(Number(tail[0].color.match(/ ([\d.]+)%/)[1])<90,'tail should already be fading on the first frame: '+tail[0].color)});
await test('host :has() rules are lifted while output is live',async()=>{await run(`const s=document.createElement('style');s.id='probeHas';s.textContent='#probeHasEl:has(.probeChild){color:rgb(1,2,3)}';document.head.append(s);const el=document.createElement('div');el.id='probeHasEl';el.innerHTML='<span class="probeChild">x</span>';document.body.append(el);return true`);await new Promise(r=>setTimeout(r,150));const v=await run(`let found=0;for(const sheet of document.styleSheets){let rs;try{rs=sheet.cssRules}catch{continue}for(const rule of rs)if((rule.cssText||'').includes(':has('))found++}return {found:found,marked:document.documentElement.hasAttribute('data-daf-has-freeze'),status:__dshAnthropicFonts.hasFreezeStatus(),color:getComputedStyle(document.getElementById('probeHasEl')).color}`);assert.equal(v.found,0);assert.equal(v.marked,true);assert.ok(v.status.active);assert.ok(v.status.saved>0);assert.notEqual(v.color,'rgb(1, 2, 3)');await run(`document.getElementById('probeHasEl')?.remove();document.getElementById('probeHas')?.remove();return true`)});
await test('settled history beyond the tail is culled with measured heights',async()=>{await run(`window.__cull=document.createElement('main');__cull.dataset.conversationRegion='chat';__cull.id='cullScope';__cull.innerHTML=Array.from({length:80},(_,i)=>'<section data-chat-flow-key="cull-'+i+'" style="display:flow-root"><p>第 '+i+' 行 '+('文字内容'.repeat(30))+'</p></section>').join('');document.body.append(__cull);__dshAnthropicFonts.setScrollCullEnabled(false);return true`);await new Promise(r=>setTimeout(r,300));const before=await run(`return {h:cullScope.getBoundingClientRect().height,rows:cullScope.querySelectorAll('[data-chat-flow-key]').length}`);await run('__dshAnthropicFonts.setScrollCullEnabled(true);return true');await new Promise(r=>setTimeout(r,900));const after=await run(`return (()=>{const rows=[...cullScope.querySelectorAll('[data-chat-flow-key]')];const live=document.querySelector('[data-streaming="true"]').closest('[data-chat-flow-key]');return {h:cullScope.getBoundingClientRect().height,applied:rows.filter(r=>r.hasAttribute('data-daf-cull')).length,tailCulled:rows.slice(-30).filter(r=>r.hasAttribute('data-daf-cull')).length,first:rows[0].hasAttribute('data-daf-cull'),liveCulled:live.hasAttribute('data-daf-cull')}})()`);const status=await run('return __dshAnthropicFonts.scrollCullStatus()');assert.ok(before.rows>=80);assert.ok(after.applied>=45,'expected distant rows culled, got '+JSON.stringify(after));assert.equal(after.tailCulled,0);assert.equal(after.first,true);assert.equal(after.liveCulled,false);assert.ok(Math.abs(after.h-before.h)<2,'scrollHeight moved: '+before.h+' -> '+after.h);assert.ok(status.applied>=45)});
await test('an active selection thaws every culled row and re-culls after clearing',async()=>{await run(`const p=cullScope.querySelector('[data-chat-flow-key] p');const range=document.createRange();range.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(range);document.dispatchEvent(new Event('selectionchange'));return true`);await new Promise(r=>setTimeout(r,500));assert.equal(await run('return __dshAnthropicFonts.scrollCullStatus().applied'),0);assert.equal(await run('return document.querySelectorAll("[data-daf-cull]").length'),0);await run('getSelection().removeAllRanges();document.dispatchEvent(new Event("selectionchange"));return true');await new Promise(r=>setTimeout(r,900));assert.ok((await run('return __dshAnthropicFonts.scrollCullStatus().applied'))>0)});
await test('disabling culling restores every row and leaves no style behind on dispose',async()=>{await run('__dshAnthropicFonts.setScrollCullEnabled(false);return true');assert.equal(await run('return document.querySelectorAll("[data-daf-cull]").length'),0);await run(`for(const row of cullScope.querySelectorAll('[data-chat-flow-key]')){if(row.style.getPropertyValue('--daf-cull-h')!=='')throw Error('height var left behind')};cullScope.remove();return true`);await new Promise(r=>setTimeout(r,500))});
await test('terminal commands and ordinary stdout stay neutral across interpreters', async () => {
  await run(`window.__termProbe=document.createElement('div');__termProbe.innerHTML=['grep -n tauri subtitles.srt','python3 - << EOF','node script.js','git diff'].map((cmd,i)=>'<div data-terminal id="terminalProbe'+i+'"><span data-command-text>'+cmd.replaceAll('<','&lt;')+'</span><div class="probe_line_x">done 947</div><div class="probe_line_x">3 Electron</div></div>').join('');document.body.append(__termProbe)`);
  await new Promise(r=>setTimeout(r,600));
  assert.equal(await run('return __termProbe.querySelectorAll("[data-daf-hl], [data-daf-hl-src], [data-command-text] span").length'),0);
  await run('__termProbe.firstElementChild.setAttribute("data-running","");__termProbe.querySelector(".probe_line_x").textContent="done 948";__termProbe.firstElementChild.removeAttribute("data-running")');
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await run('return __termProbe.querySelectorAll("[data-daf-hl]").length'),0);
  assert.equal(await run('return __termProbe.querySelector(".probe_line_x").textContent'),'done 948');
});
await test('legacy guessed colours are neutralised without touching ANSI or code', async () => {
  const r=await run(`__termProbe.insertAdjacentHTML('beforeend','<div data-terminal style="color:rgb(70,75,80)"><div data-daf-hl="python" id="legacyColour"><span style="color:rgb(0,100,255)">947</span></div><div class="probe_line_x"><span id="ansiColour" style="color:rgb(200,60,40)">error</span></div></div><pre class="shiki"><code><span id="codeColour" style="color:rgb(0,100,255)">const</span></code></pre>');return {legacy:getComputedStyle(legacyColour.firstElementChild).color,ansi:getComputedStyle(ansiColour).color,code:getComputedStyle(codeColour).color}`);
  assert.equal(r.legacy,'rgb(70, 75, 80)');
  assert.equal(r.ansi,'rgb(200, 60, 40)');
  assert.equal(r.code,'rgb(0, 100, 255)');
  await run('__termProbe.remove()');
});

// Use same-origin, independent fixtures so disposing does not reset the original
// suite's live DOM, observers, disposer history, or HMR assertions.
await run(`window.__withIsolatedFixture = async callback => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px';
  const loaded = new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('Isolated fixture load timed out')), 3000);
    frame.onload = () => {clearTimeout(timer);resolve()};
  });
  frame.srcdoc = ${JSON.stringify(fixtureSource.replace(/<script src="\.\.\/\.\.\/lib\/client\.js"><\/script>/, ''))};
  document.body.append(frame);
  try {
    await loaded;
    const w = frame.contentWindow;
    const script = w.document.createElement('script');
    script.textContent = ${JSON.stringify(clientSource)};
    w.document.body.append(script);
    if (!w.__dshAnthropicFonts) throw Error('Isolated plugin did not initialize');
    return await callback(w);
  } finally {
    try { for (const dispose of frame.contentWindow.__disposers || []) dispose?.(); }
    finally { frame.remove(); }
  }
}`);
await test('disposing an open font menu restores input ARIA', async () => {
  const r = await run(`return __withIsolatedFixture(async w => {
    const input = w.document.createElement('input');
    input.setAttribute('aria-label', 'Text font');
    w.document.body.append(input);
    const attributes = ['aria-autocomplete','aria-expanded','aria-controls','aria-activedescendant'];
    const snapshot = () => Object.fromEntries(attributes.map(name => [name,input.getAttribute(name)]));
    const before = snapshot();
    // The font picker opens on pointerdown or ArrowDown, not focus alone.
    input.dispatchEvent(new w.KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true,cancelable:true}));
    const open = snapshot();
    const menuVisible = !!w.document.querySelector('.daf-panel:not([hidden])');
    w.__disposers.at(-1)();
    return {before,open,menuVisible,after:snapshot(),panelPresent:!!w.document.querySelector('.daf-panel')};
  })`);
  assert.equal(r.menuVisible, true, 'font menu must actually open');
  assert.equal(r.open['aria-expanded'], 'true');
  assert.equal(r.panelPresent, false);
  assert.deepEqual(r.after, r.before, 'font ARIA after disposal: ' + JSON.stringify(r));
});
await test('localized wrap toggles never receive copy feedback', async () => {
  const r = await run(`return __withIsolatedFixture(async w => {
    const button = w.document.createElement('button');
    button.className = '_action_1mqf1_probe';
    button.setAttribute('aria-label', 'Wrap code');
    button.setAttribute('aria-pressed', 'false');
    w.document.body.append(button);
    button.click();
    return button.classList.contains('dsh-copied');
  })`);
  assert.equal(r, false);
});
await test('repeated copy clicks and disposal leave no copy-done classes', async () => {
  const r = await run(`return __withIsolatedFixture(async w => {
    const a = w.document.createElement('button');
    const b = w.document.createElement('button');
    a.className = '_copyButton_15hvo_132'; b.className = '_action_1mqf1_probe';
    a.textContent = b.textContent = '复制';
    w.document.body.append(a,b);
    const marked = () => [a,b].map(button => [...button.classList].filter(name => name === 'daf-copy-done' || name === 'dsh-copied'));
    a.click(); const first = marked();
    a.click(); b.click(); const repeated = marked();
    await new Promise(resolve => w.setTimeout(resolve,1400));
    const settled = marked();
    a.click(); a.click(); b.click();
    const beforeDispose = marked();
    w.__disposers.at(-1)();
    const disposed = marked();
    await new Promise(resolve => w.setTimeout(resolve,1400));
    return {first,repeated,settled,beforeDispose,disposed,later:marked()};
  })`);
  assert.ok(r.first[0].length > 0, 'copy feedback must actually activate');
  assert.ok(r.repeated[1].length > 0, 'second button must receive feedback');
  assert.ok(r.beforeDispose.some(classes => classes.length > 0), 'dispose must occur during feedback');
  assert.deepEqual({settled:r.settled,disposed:r.disposed,later:r.later},
    {settled:[[],[]],disposed:[[],[]],later:[[],[]]}, 'copy feedback lifecycle: ' + JSON.stringify(r));
});

await test('hot replacement disposes previous rules and observers',async()=>{await step('dTrigger.click()');await new Promise(r=>setTimeout(r,250));await run('dTrigger.click()');await step('summary.textContent="替换前预览"');const r=await step('window.__ModuleLoader__.load=module=>{window.__plugin=module.factory(()=>{throw Error("unused")});__plugin.apply({effect(callback){__disposers.push(callback())}})};const s=document.createElement("script");s.src='+JSON.stringify(new URL('../../lib/client.js?hmr=1', import.meta.url).href)+';document.body.append(s);await new Promise((resolve,reject)=>{s.onload=resolve;s.onerror=()=>reject(Error("HMR client load failed"))})');assert.equal(r.ranges.length,0);assert.equal(r.status.rules,16);await run('__disposers[0]()');assert.equal(await run('return !!window.__dshAnthropicFonts && document.querySelectorAll("style[data-plugin-css=dsh-anthropic-fonts]").length===1'),true);assert.equal(await run('return !!document.getElementById("dContent")'),false)});
await test('dispose removes all owned highlights',async()=>{await step('summary.textContent="清理之前"');await run('resizeHandle.dispatchEvent(new PointerEvent("pointerdown",{button:0,pointerId:99,bubbles:true}));__disposers.at(-1)()');assert.equal(await run('return document.querySelectorAll("[data-daf-resize-frozen]").length'),0);assert.equal(await run('return document.documentElement.hasAttribute("data-daf-resizing")'),false);assert.equal(await run('return document.querySelectorAll("style[data-plugin-css^=dsh-anthropic-fonts]").length'),0);assert.equal((await run('return [...CSS.highlights.keys()].filter(k=>k.startsWith("daf-fade-")||k.startsWith("daf-sum-")).length')),0)});

  assert.equal(createHash('sha256').update(await readFile(clientURL)).digest('hex'), sourceSha256, 'client changed during the suite; rerun against one build');
  assert.equal(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).version, pluginVersion, 'version changed during the suite');
} catch (error) {
  recordError('runner', error);
} finally {
  // Cleanup also runs after launch, connection, navigation, or assertion failures.
  if (targetId) {
    try { await http('/json/close/' + encodeURIComponent(targetId), {}, true); }
    catch (error) { recordError('close owned target', error); }
  }
  rejectPending(new Error('Suite finished'));
  socket?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null && chrome.pid) {
    try {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill('SIGTERM');
      const force = setTimeout(() => chrome.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(force); }
    } catch (error) { recordError('stop Chrome', error); }
  }
  if (profile) {
    try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (error) { recordError('remove temporary profile', error); }
  }
  clearTimeout(deadline);
  process.removeListener('SIGINT', onINT);
  process.removeListener('SIGTERM', onTERM);
  try { await save(errors.length ? 'failed' : 'passed'); }
  catch (error) { recordError('write results', error); }
  process.exitCode = errors.length ? 1 : 0;
  console.log(`${results.length}/${attempted} passed; ${errors.length} errors. Results: ${resultsURL.pathname}`);
}
