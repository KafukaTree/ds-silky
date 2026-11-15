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
const clientURL = process.env.DSH_TEST_CLIENT || new URL('../../lib/client.js', import.meta.url);
const testFilter = process.env.DSH_TEST_FILTER ? new RegExp(process.env.DSH_TEST_FILTER) : null;
const resultsURL = new URL('./results.json', import.meta.url);
const startedAt = new Date().toISOString();
const results = [], errors = [];
let pluginVersion = null, sourceSha256 = null, clientSource, fixtureSource, hostSnapshots;
let hostSnapshotSha256 = null, hostRendererMode = null;
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
  pluginVersion, sourceSha256, hostSnapshotSha256, hostRendererMode, startedAt, finishedAt: status === 'running' ? null : new Date().toISOString(),
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
  if (testFilter && !testFilter.test(name)) return;
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
  const snapshots = await readFile(new URL('./host-markdown-snapshots.json', import.meta.url));
  hostSnapshots = JSON.parse(snapshots);
  hostSnapshotSha256 = createHash('sha256').update(snapshots).digest('hex');
  hostRendererMode = hostSnapshots.provenance.rendererMode;
  assert.equal(hostRendererMode, 'actual-incremental-parser-and-react-ssr');
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
await test('a repaint resumes the fade instead of restarting it',async()=>{
  await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="resume"><div data-streaming="true" id="resumeBody"><p id="resumeP">起点</p></div></section>\')');
  await step('resumeP.firstChild.appendData("这一批文字正在淡入过程中会被宿主重渲染")');
  const result=await run(`const level=()=>{for(const [name,h] of CSS.highlights)for(const r of h)if(r.startContainer===resumeP.firstChild&&r.startOffset<=2&&r.endOffset>2)return Number(name.slice(9));return 15};const until=performance.now()+2500;while(performance.now()<until){const before=level();if(before>3&&before<15){resumeP.innerHTML=resumeP.innerHTML;await new Promise(r=>queueMicrotask(()=>queueMicrotask(r)));return {before,after:level()}}await new Promise(requestAnimationFrame)}throw Error('No intermediate repaint frame observed')`);
  assert.ok(result.before>3&&result.before<15);assert.ok(result.after>=result.before,'repaint must not restart the fade');assert.ok(result.after<15,'repaint must not flash fully bright');
});
await test('in-place Text rewrites never expose queued text before a later DOM replacement', async () => {
  const cases = await run(`
    const flush = () => new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
    const results = [];
    for (const mode of ['data', 'nodeValue', 'textContent', 'replaceData', 'sameValue']) {
      const seat = document.createElement('section');
      seat.dataset.chatFlowKey = 'in-place-' + mode;
      seat.innerHTML = '<div data-streaming="true"><p>seed</p></div>';
      document.querySelector('main').append(seat);
      await flush();
      const p = seat.querySelector('p'), node = p.firstChild;
      const levels = () => {
        const values = new Array(p.textContent.length).fill(15);
        for (const [name, highlight] of CSS.highlights) {
          if (!name.startsWith('daf-fade-')) continue;
          for (const range of highlight) {
            if (range.startContainer !== p.firstChild) continue;
            for (let i = range.startOffset; i < range.endOffset; i++) values[i] = Number(name.slice(9));
          }
        }
        return values;
      };
      try {
        node.appendData('尚未显示的长批次内容'.repeat(8));
        await flush();
        const before = levels();
        const next = node.data + (mode === 'sameValue' ? '' : '追加');
        if (mode === 'replaceData') node.replaceData(0, node.length, next);
        else if (mode === 'sameValue') node.data = node.data;
        else node[mode] = next;
        await flush();
        const rewritten = levels();
        p.innerHTML = p.innerHTML;
        await flush();
        results.push({mode, before, rewritten, replaced: levels()});
      } finally { seat.remove(); await flush(); }
    }
    return results;
  `);
  for (const {mode,before,rewritten,replaced} of cases) {
    assert.ok(before.slice(4).every(level => level === 0), mode + ': setup must queue text');
    assert.deepEqual(rewritten.slice(0,before.length), before, mode + ': same-node write exposed queued text');
    assert.deepEqual(replaced, rewritten, mode + ': node replacement hid previously exposed text');
  }
});
await test('text splits, normalization and partial writes preserve queued coverage', async () => {
  const cases = await run(`
    const flush = () => new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
    const results = [];
    for (const mode of ['split', 'normalize', 'partialReplace', 'insertDelete']) {
      const seat = document.createElement('section');
      seat.dataset.chatFlowKey = 'topology-' + mode;
      seat.innerHTML = '<div data-streaming="true"><p>seed</p></div>';
      document.querySelector('main').append(seat);
      await flush();
      const p = seat.querySelector('p');
      const levels = () => {
        const values = new Array(p.textContent.length).fill(15);
        let offset = 0;
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          for (const [name, highlight] of CSS.highlights) {
            if (!name.startsWith('daf-fade-')) continue;
            for (const range of highlight) {
              for (let i = 0; i < node.length; i++) {
                // comparePoint handles a Range spanning two text nodes after splitText.
                if (range.comparePoint(node, i) === 0 && range.comparePoint(node, i+1) === 0 &&
                    !(range.endContainer === node && range.endOffset === i)) values[offset+i] = Number(name.slice(9));
              }
            }
          }
          offset += node.length;
        }
        return values;
      };
      try {
        const a = document.createTextNode('尚未显示的长批次内容'.repeat(4));
        const b = document.createTextNode('等待后续淡入的文本'.repeat(4));
        p.append(a,b);
        await flush();
        const before = levels();
        if (mode === 'split') a.splitText(5);
        if (mode === 'normalize') p.normalize();
        if (mode === 'partialReplace') a.replaceData(3, 5, a.data.slice(3,8));
        if (mode === 'insertDelete') { a.insertData(5,'临时'); a.deleteData(5,2); }
        await flush();
        results.push({mode,before,after:levels()});
      } finally { seat.remove(); await flush(); }
    }
    return results;
  `);
  for (const {mode,before,after} of cases) {
    assert.ok(before.slice(4).every(level => level === 0), mode + ': setup must queue text');
    assert.deepEqual(after,before,mode + ': mutation changed opacity without a frame');
  }
});
await test('repeated same-node writes retain an in-progress fade without full-bright flashes', async () => {
  const r = await run(`
    const flush = () => new Promise(resolve => queueMicrotask(() => queueMicrotask(resolve)));
    const seat = document.createElement('section');
    seat.dataset.chatFlowKey = 'in-progress-write';
    seat.innerHTML = '<div data-streaming="true"><p>seed</p></div>';
    document.querySelector('main').append(seat);
    await flush();
    const p = seat.querySelector('p');
    const levels = () => {
      const values = new Array(p.textContent.length).fill(15);
      for (const [name, highlight] of CSS.highlights) {
        if (!name.startsWith('daf-fade-')) continue;
        for (const range of highlight) if (range.startContainer === p.firstChild) {
          for (let i = range.startOffset; i < range.endOffset; i++) values[i] = Number(name.slice(9));
        }
      }
      return values;
    };
    try {
      p.firstChild.appendData('渐进淡入的文字'.repeat(10));
      const start = performance.now();
      while (performance.now()-start < 800) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const before = levels();
        if (!before.some(level => level > 0 && level < 10)) continue;
        p.firstChild.data += '续'; await flush();
        const afterWrite = levels();
        p.firstChild.data = p.firstChild.data; await flush();
        const afterSame = levels();
        p.innerHTML = p.innerHTML; await flush();
        const afterReplace = levels();
        return {before,afterWrite,afterSame,afterReplace};
      }
      throw Error('No intermediate fade frame was observed');
    } finally { seat.remove(); await flush(); }
  `);
  for (const name of ['afterWrite','afterSame','afterReplace']) {
    r.before.forEach((level,i) => {
      assert.ok(r[name][i] >= level, name + ': fade restarted at ' + i);
      if (level < 10) assert.ok(r[name][i] < 15, name + ': unfinished text flashed fully bright at ' + i);
    });
  }
});
await test('batches longer than 48 characters still fade',async()=>{const r=await step('text.firstChild.appendData("长".repeat(120))');const total=r.ranges.filter(x=>/^长+$/.test(x.text)).reduce((s,x)=>s+x.text.length,0);assert.equal(total,120)});
await test('RAF commits are faded before their very first paint',async()=>{const r=await run('return await new Promise(resolve=>requestAnimationFrame(()=>{text.firstChild.appendData("首帧检查");queueMicrotask(()=>queueMicrotask(()=>resolve(__ranges())))}))');const chunk=r.find(x=>x.text.includes('首'));assert.ok(chunk,'new text was exposed at full color before paint');assert.ok(Number(chunk.color.match(/ ([\d.]+)%/)[1])<30)});
await test('replacing the streaming root keeps opacity moving forward',async()=>{const r=await run('const before=__ranges().find(x=>x.text.includes("首"));body.outerHTML=body.outerHTML;await new Promise(r=>queueMicrotask(()=>queueMicrotask(r)));return {before,after:__ranges().find(x=>x.text.includes("首"))}');const level=x=>x?Number(x.color.match(/ ([\d.]+)%/)[1]):100;assert.ok(level(r.after)>=level(r.before));if(level(r.before)<100)assert.ok(r.after,'same-frame replacement must retain unfinished text ranges')});
await test('reasoning and response never steal each other’s deltas',async()=>{await step('body.insertAdjacentHTML("beforeend",\'<div data-variant="think" data-state="running" data-expanded="true" id="think"><div data-disclosure-header>思考标题</div><p id="thought">现有思考</p></div>\')');const r=await step('thought.firstChild.appendData("新增思考");text.firstChild.appendData("新增正文")');assert.ok(r.ranges.some(x=>x.text.includes('思考')));assert.ok(r.ranges.some(x=>x.text.includes('正文')));assert.ok(r.ranges.every(x=>!x.text.includes('思考标题')))});
await test('code and controls stay outside prose highlights',async()=>{const r=await step('text.insertAdjacentHTML("beforeend",\'<span>新</span><code>excluded-code</code><a href="#">链接</a><button>excluded-button</button>\')');assert.ok(r.ranges.some(x=>x.parent==='CODE'),'inline code now fades with the sentence');assert.ok(r.ranges.some(x=>x.parent==='A'&&x.ink==='rgb(0, 100, 220)'));assert.ok(r.ranges.every(x=>x.parent!=='BUTTON'))});
await test('completed historical messages do not fade',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().seen');const r=await step('document.querySelector("main").insertAdjacentHTML("afterbegin",\'<section data-chat-flow-key="history" data-chat-flow-kind="assistant-step"><div data-message-bubble>历史内容</div></section>\')');assert.equal(r.status.seen,before)});
await test('collapsed reasoning preview transitions without title animation',async()=>{await step('think.removeAttribute("data-expanded");think.innerHTML=\'<div data-disclosure-header><span>思考</span><span data-streaming="true" id="summary">上一段预览</span><span aria-hidden="true">装饰副本</span></div>\'');const r=await step('summary.textContent="下一段预览"');assert.ok(r.ranges.some(x=>x.text.startsWith('下')));assert.ok(Number(r.ranges.find(x=>x.text.startsWith('下')).color.match(/ ([\d.]+)%/)[1])<100);assert.ok(r.ranges.every(x=>!x.text.includes('装饰副本')&&!x.text.includes('思考')));assert.ok(await run('const until=performance.now()+2500;while(performance.now()<until){const range=__ranges().find(x=>x.text.startsWith("下"));if(!range||Number(range.color.match(/ ([\\d.]+)%/)[1])>=55)return true;await new Promise(requestAnimationFrame)}return false'))});
await test('new tool header enters once without changing height',async()=>{await run('const until=performance.now()+3000;while(__dshAnthropicFonts.streamFadeStatus().active&&performance.now()<until)await new Promise(requestAnimationFrame)');const r=await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="tool-1" data-chat-flow-kind="tool-call" id="toolSeat"><div data-variant="read" data-tool="read" data-state="running" id="tool"><div data-disclosure-header id="toolHeader">读取文件</div><pre>tool-output</pre></div></section>\')');assert.equal(r.status.rowsActive,1);const a=await run('return {h:toolHeader.getBoundingClientRect().height,frames:toolHeader.getAnimations()[0].effect.getKeyframes()}');assert.ok(a.frames.every(x=>!x.height));const moves=a.frames.map(x=>x.transform).filter(Boolean);assert.ok(moves.length>0);assert.ok(moves.every(t=>t==='none'||/^translateY\([1-6](?:\.\d+)?px\)$/.test(t)),'rise must stay at or under 6px: '+JSON.stringify(moves));await new Promise(r=>setTimeout(r,190));assert.ok(Math.abs((await run('return toolHeader.getBoundingClientRect().height'))-a.h)<0.6)});
await test('running-to-complete and row replacement never replay entry',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().rowsSeen');const r=await step('tool.dataset.state="ok";toolSeat.innerHTML=toolSeat.innerHTML');assert.equal(r.status.rowsSeen,before);assert.equal(r.status.rowsActive,0)});
await test('newly loaded completed tool history has no entry animation',async()=>{const before=await run('return __dshAnthropicFonts.streamFadeStatus().rowsSeen');const r=await step('const scope=document.createElement("main");scope.dataset.conversationRegion="chat";scope.innerHTML=\'<section data-chat-flow-key="old-tool"><div data-variant="read" data-state="ok">历史工具</div></section>\';document.body.append(scope)');assert.equal(r.status.rowsSeen,before)});
await test('nested process groups do not double-animate output',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="group" id="processGroup"><section data-chat-flow-key="nested"><div data-streaming="true" id="nestedText">初始</div></section></section>\')');const before=await run('return __dshAnthropicFonts.streamFadeStatus().seen');const r=await step('nestedText.firstChild.appendData("只算一次")');assert.equal(r.status.seen,before+1);assert.equal(r.ranges.filter(x=>/^[只算一次]+$/.test(x.text)).reduce((n,x)=>n+x.text.length,0),4)});
await test('switching conversation location does not replay the current tail',async()=>{const r=await step('location.hash="next-conversation";nestedText.firstChild.appendData("切换后的旧内容")');assert.equal(r.ranges.length,0)});
await test('reduced motion clears running effects and empty markers immediately',async()=>{
  assert.equal(await run('nestedText.insertAdjacentHTML("beforeend", "<ul id=motionList><li></li></ul>");await new Promise(r=>queueMicrotask(()=>queueMicrotask(r)));return motionList.firstChild.hasAttribute("data-daf-stream-marker")'),true);
  try {
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await new Promise(r=>setTimeout(r,150));
    assert.equal((await run('return __ranges()')).length,0);
    assert.equal(await run('return __dshAnthropicFonts.streamFadeStatus().enabled'),false);
    assert.deepEqual(await run('const li=motionList.firstChild;return [li.hasAttribute("data-daf-stream-marker"),li.style.getPropertyValue("--daf-marker-alpha"),li.style.getPropertyValue("--daf-marker-ink")]'),[false,'','']);
  } finally {
    await run('motionList.remove()');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  }
});
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
await test('inline code text stays ranged through surface replacement',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="chipSeat"><div data-streaming="true" id="chipBody"><p id="chipP">说明文字</p></div></section>\')');const r=await step('chipP.insertAdjacentHTML("beforeend",\'<code id="chip">queueMicrotask()</code>\')');const codeRanges=r.ranges.filter(x=>x.parentId==='chip');assert.equal(codeRanges.reduce((n,x)=>n+x.text.length,0),16,'code text should be ranged with the sentence');assert.equal(await run('return getComputedStyle(document.getElementById("chip")).visibility'),'hidden');const again=await step('chipP.innerHTML=chipP.innerHTML');assert.ok(again.ranges.some(x=>x.parentId==='chip'))});
await test('history code never animates or fades',async()=>{await run('document.querySelector("main").insertAdjacentHTML("afterbegin",\'<section data-chat-flow-key="chipOld"><div data-message-bubble><p>旧 <code id="oldChip">git status</code></p></div></section>\')');await new Promise(r=>setTimeout(r,60));assert.equal(await run('return document.querySelector(\'[data-chat-flow-key="chipOld"] code\').getAnimations().length'),0);assert.equal(await run('return __ranges().filter(x=>x.parentId==="oldChip").length'),0)});
await test('fade stays short while upstream cadence is tracked',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="cadence"><div data-streaming="true" id="cadText">起点</div></section>\')');for(let i=0;i<6;i+=1){await step('cadText.firstChild.appendData("慢速批次")');await new Promise(r=>setTimeout(r,200))}const s=await run('return __dshAnthropicFonts.streamFadeStatus()');assert.equal(s.duration,64);assert.ok(s.cadence>150,'cadence should still be tracked: '+s.cadence)});
await test('a long batch is fully covered by queued highlight ranges',async()=>{await step('document.querySelector("main").insertAdjacentHTML("beforeend",\'<section data-chat-flow-key="ordered"><div data-streaming="true" id="ordText"></div></section>\')');const r=await step('ordText.append("尾".repeat(120))');assert.equal(r.status.spread,0);const tail=r.ranges.filter(x=>/^尾+$/.test(x.text));assert.equal(tail.reduce((s,x)=>s+x.text.length,0),120);assert.ok(Number(tail[0].color.match(/ ([\d.]+)%/)[1])<90,'tail should already be fading on the first frame: '+tail[0].color)});
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
await run(`window.__withIsolatedFixture = async (callback, html) => {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px';
  const loaded = new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(Error('Isolated fixture load timed out')), 3000);
    frame.onload = () => {clearTimeout(timer);resolve()};
  });
  frame.srcdoc = html ?? ${JSON.stringify(fixtureSource.replace(/<script src="\.\.\/\.\.\/lib\/client\.js"><\/script>/, ''))};
  document.body.append(frame);
  try {
    await loaded;
    const w = frame.contentWindow;
    // aria-hidden makes the host globe decorative, not display:none. The
    // legacy fixture's blanket rule would make icon regressions vacuous.
    const iconStyle = w.document.createElement('style');
    iconStyle.textContent = 'svg[aria-hidden="true"]{display:inline-block;vertical-align:middle}';
    w.document.head.append(iconStyle);
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
await test('a blank session still animates its first newly generated process chain', async () => {
  const r=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const host=d.createElement('main');host.dataset.conversationRegion='chat';host.dataset.conversationSession='new-blank-session';host.dataset.contentPhase='hero';host.innerHTML='<div data-slot="conversation.chat.flow"></div>';d.body.append(host);await flush();
    host.dataset.contentPhase='active';host.firstChild.innerHTML='<section data-chat-flow-key="new-thinking"><div data-variant="think" data-state="running" data-expanded="true"><div data-disclosure-header>思考</div><p>这是新请求产生的思考</p></div></section>';await flush();
    const levels=[...w.CSS.highlights].filter(([name])=>name.startsWith('daf-fade-')).flatMap(([name,h])=>[...h].filter(r=>host.contains(r.startContainer)).map(()=>Number(name.slice(9))));
    return {levels,status:w.__dshAnthropicFonts.streamFadeStatus()};
  })`);
  assert.ok(r.levels.includes(0),'first new thought must retain its streaming fade');
});

await test('history loading spans multiple commits and ends before fresh output', async () => {
  const r=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const host=d.createElement('main');host.dataset.conversationRegion='chat';host.dataset.conversationSession='batched-history';
    host.innerHTML='<div data-chat-flow><div class="fixture_hint">Loading history…</div><div data-slot="conversation.chat.flow"></div></div>';d.body.append(host);await flush();
    const column=host.firstChild,flow=column.lastChild, samples=[];
    function sample(){return {pending:w.__dshAnthropicFonts.streamFadeStatus().rowsPending,effects:[...flow.querySelectorAll('*')].flatMap(e=>e.getAnimations()).length,dim:[...w.CSS.highlights].filter(([name])=>name.startsWith('daf-fade-')&&Number(name.slice(9))<15).some(([,h])=>[...h].some(r=>flow.contains(r.startContainer)))}}
    for(let i=0;i<3;i++){
      flow.insertAdjacentHTML('beforeend','<section data-chat-flow-key="batch-'+i+'"><div data-variant="think" data-state="running"><div data-disclosure-header>思考 · <span data-streaming="true">历史思考摘要</span></div></div><div data-variant="read" data-state="ok"><div data-disclosure-header>历史工具</div></div><div data-streaming="true"><p>历史正文</p></div></section>');
      if(i===2)column.firstChild.remove();
      await flush();samples.push(sample());await new Promise(w.requestAnimationFrame);
    }
    flow.lastChild.querySelector('p').firstChild.appendData('新追加正文');await flush();const fresh=sample();
    const hint=d.createElement('div');hint.className='fixture_hint';column.prepend(hint);await flush();
    flow.lastChild.querySelector('p').firstChild.appendData('重新同步历史');await flush();samples.push(sample());
    hint.remove();await flush();flow.lastChild.querySelector('p').firstChild.appendData('加载结束后新增');await flush();
    return {samples,fresh,after:sample()};
  })`);
  for(const s of r.samples){assert.equal(s.pending,0);assert.equal(s.effects,0);assert.equal(s.dim,false)}
  assert.equal(r.fresh.dim,true,'new output after the final history commit must fade');
  assert.equal(r.after.dim,true,'loader-only removal must close hydration');
});

await test('first session history mount never replays reasoning and completed tool rows', async () => {
  const r=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const host=d.createElement('main');host.dataset.conversationRegion='chat';host.dataset.conversationSession='first-unseen-history';host.dataset.contentPhase='active';
    host.innerHTML='<div data-slot="conversation.chat.flow"></div>';d.body.append(host);await flush();await new Promise(w.requestAnimationFrame);
    const flow=host.firstChild, before=w.__dshAnthropicFonts.streamFadeStatus();
    flow.innerHTML='<section data-chat-flow-key="past-think"><div data-variant="think" data-state="ok"><div data-disclosure-header>思考 · 之前的思考摘要</div></div></section>'+Array.from({length:12},(_,i)=>'<section data-chat-flow-key="past-tool-'+i+'"><div data-variant="read" data-state="ok"><div data-disclosure-header>读取图片 · /tmp/c'+i+'.png</div></div></section>').join('')+'<section data-chat-flow-key="current-think"><div data-variant="think" data-state="running" data-expanded="true"><div data-disclosure-header>思考</div><p>已经存在的思考正文</p></div></section><section data-chat-flow-key="current-body"><div data-streaming="true"><p>已经存在的正文</p></div></section>';
    await flush();
    const glyphs=()=>[...w.CSS.highlights].filter(([name])=>name.startsWith('daf-fade-')).flatMap(([name,h])=>[...h].filter(r=>flow.contains(r.startContainer)).map(r=>({level:Number(name.slice(9)),text:r.toString()})));
    const initial={status:w.__dshAnthropicFonts.streamFadeStatus(),glyphs:glyphs(),effects:[...flow.querySelectorAll('*')].flatMap(e=>e.getAnimations()).length};
    const text=flow.querySelector('[data-expanded] p').firstChild;text.appendData('真正新增的思考');await flush();const freshGlyphs=glyphs();
    flow.insertAdjacentHTML('beforeend','<section data-chat-flow-key="new-tool"><div data-variant="read" data-state="running"><div data-disclosure-header>新的工具调用</div></div></section>');await flush();
    return {before,initial,freshGlyphs,after:w.__dshAnthropicFonts.streamFadeStatus()};
  })`);
  assert.equal(r.initial.status.rowsSeen,r.before.rowsSeen,'historical rows must not enter again');
  assert.equal(r.initial.status.rowsPending,0,'history must not be held in a replay queue');
  assert.equal(r.initial.effects,0,'history must have no fade/entry effects');
  assert.ok(r.initial.glyphs.every(x=>x.level===15),'existing thinking/body must be fully visible');
  assert.ok(r.freshGlyphs.some(x=>x.level===0&&x.text.includes('真')),'new thinking must still fade');
  assert.ok(r.after.rowsPending>0,'new tool must still wait for pending thinking');
});

await test('returning to a session hydrates a previously seen live body mounted after its empty scope', async () => {
  const r=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const main=d.createElement('main');main.dataset.conversationRegion='chat';main.dataset.conversationSession='session-a';
    main.innerHTML='<div data-slot="conversation.chat.flow"><section data-chat-flow-key="same-turn"><div data-streaming="true"><p>已读正文</p></div></section></div>';
    d.body.append(main);await flush();main.remove();await flush();await new Promise(w.requestAnimationFrame);
    const back=d.createElement('main');back.dataset.conversationRegion='chat';back.dataset.conversationSession='session-a';back.innerHTML='<div data-slot="conversation.chat.flow"></div>';d.body.append(back);await flush();
    const flow=back.firstChild;flow.innerHTML='<section data-chat-flow-key="same-turn"><div data-streaming="true"><p>已读正文和离开期间恢复的内容</p></div></section>';await flush();
    function levels(el){const n=el.firstChild,a=Array(n.length).fill(15);for(const [name,h]of w.CSS.highlights)if(name.startsWith('daf-fade-'))for(const r of h)if(r.startContainer===n)for(let i=r.startOffset;i<r.endOffset;i++)a[i]=Number(name.slice(9));return a}
    const p=flow.querySelector('p'),restored=levels(p);p.firstChild.appendData('新到达');await flush();const append=levels(p).slice(-3);
    flow.insertAdjacentHTML('beforeend','<section data-chat-flow-key="fresh-turn"><div data-streaming="true"><p>新一轮正文</p></div></section>');await flush();const fresh=levels(flow.lastChild.querySelector('p'));
    flow.innerHTML='';await flush();await new Promise(w.requestAnimationFrame);
    flow.innerHTML='<section data-chat-flow-key="same-turn"><div data-streaming="true"><p>重试后完全不同的正文</p></div></section>';await flush();const retry=levels(flow.querySelector('p'));
    flow.innerHTML='';back.dataset.conversationSession='session-b';await flush();
    flow.innerHTML='<section data-chat-flow-key="new-user" data-chat-flow-kind="user">新请求</section>';await flush();
    flow.innerHTML='<section data-chat-flow-key="same-turn"><div data-streaming="true"><p>另一个会话的新正文</p></div></section>';await flush();const other=levels(flow.querySelector('p'));
    return {restored,append,fresh,retry,other};
  })`);
  assert.ok(r.restored.every(x=>x===15),'returning history must not start streaming from zero');
  for(const key of ['append','fresh','retry','other'])assert.ok(r[key].every(x=>x===0),key+': new output must still be queued');
});

await test('final local file link conversion retains the response while the final tail fades', async () => {
  const fixture = JSON.parse(await readFile(new URL('./host-completion-snapshots.json', import.meta.url), 'utf8'));
  for (const item of fixture.cases) for (const phase of ['settled', 'partial']) {
    const result = await run(`return __withIsolatedFixture(async w => {
      const d=w.document, item=${JSON.stringify(item)}, phase=${JSON.stringify(phase)};
      const flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
      scope.innerHTML='<section data-chat-flow-key="completion"><div data-streaming="true"></div></section>';
      d.body.append(scope);await flush();const root=scope.querySelector('[data-streaming]');
      if(phase==='settled')w.__dshAnthropicFonts.setStreamFadeEnabled(false);
      root.innerHTML=item.before;await flush();
      if(phase==='settled'){w.__dshAnthropicFonts.setStreamFadeEnabled(true);await flush()}
      function read(){
        const walker=d.createTreeWalker(root,w.NodeFilter.SHOW_TEXT);let n,text='',levels=[];
        while(n=walker.nextNode()){
          if(n.parentElement.closest('button,pre,svg,[aria-hidden="true"]'))continue;
          const a=Array(n.length).fill(15);
          for(const [name,h] of w.CSS.highlights){if(!name.startsWith('daf-fade-'))continue;for(const r of h)if(r.startContainer===n)for(let i=r.startOffset;i<r.endOffset;i++)a[i]=Number(name.slice(9))}
          text+=n.data;levels.push(...a);
        }return {text,levels};
      }
      if(phase==='partial'){
        const until=w.performance.now()+4000;
        while(w.performance.now()<until){const r=read();if(r.levels[50]>0&&r.levels[50]<15&&r.levels.at(-1)===0)break;await new Promise(w.requestAnimationFrame)}
      }
      const before=read();root.innerHTML=item.after;root.removeAttribute('data-streaming');await flush();
      const after=read(),frames=[after];
      const until=w.performance.now()+5000;
      while(w.performance.now()<until&&frames.at(-1).levels.some(x=>x<15)){await new Promise(w.requestAnimationFrame);frames.push(read())}
      return {before,after,frames};
    })`);
    assert.equal(result.before.text,item.beforeText);
    assert.equal(result.after.text,item.afterText);
    const removed='π0.7 模型结构：多模态上下文 → 50 步动作块';
    const at=item.beforeText.indexOf(removed);
    assert.equal(at,7);
    const retained=result.before.levels.filter((_,i)=>i<at||i>=at+removed.length);
    assert.ok(result.after.levels.slice(0,retained.length).every((x,i)=>x>=retained[i]),item.id+' '+phase+': retained text replayed');
    assert.ok(result.after.levels.slice(0,retained.length).every((x,i)=>retained[i]!==0||x<15),'queued text must not flash fully visible');
    if(phase==='partial')assert.ok(retained.some(x=>x>0&&x<15)&&retained.includes(0),'must observe real partial and queued text');
    if(item.id!=='full-control')assert.ok(result.after.levels.slice(retained.length).every(x=>x===0),'final tail must start queued');
    for(let f=1;f<result.frames.length;f++)assert.ok(result.frames[f].levels.every((x,i)=>x>=result.frames[f-1].levels[i]),'brightness must never go backwards');
    assert.ok(result.frames.at(-1).levels.every(x=>x===15),'final queue must drain');
  }
});

await test('fresh body text cannot overtake thinking or a held tool', async () => {
  for (const mode of ['body','tool-body','final-body','large-body','body-card','code-only']) {
    const result = await run(`return __withIsolatedFixture(async w => {
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
      scope.innerHTML='<section data-chat-flow-key="thinking"><div data-variant="think" data-state="running" data-expanded="true"><div data-disclosure-header>思考</div><p>seed</p></div></section>';
      d.body.append(scope);await flush();const think=scope.querySelector('[data-variant="think"]'),tail=think.querySelector('p').firstChild;
      tail.appendData('尚未完全显示的思考尾部'.repeat(4));
      const mode=${JSON.stringify(mode)};
      if(mode==='final-body')think.dataset.state='ok';
      const seat=d.createElement('section');seat.dataset.chatFlowKey='answer';
      seat.innerHTML=(mode==='tool-body'?'<div data-variant="command" data-state="running"><div data-disclosure-header>运行命令</div><pre>output</pre></div>':'')+'<div data-streaming="true"><p>'+ '后续正文'.repeat(mode==='large-body'?150:12)+'</p>'+(['body-card','code-only'].includes(mode)?'<pre><code>const answer = 42;</code></pre>':'')+'</div>';
      if(mode==='code-only')seat.querySelector('p').remove();
      scope.append(seat);await flush();
      const body=seat.querySelector('[data-streaming] p, [data-streaming] code').firstChild,tool=seat.querySelector('[data-variant]');
      function levels(node,start=0){const v=Array(node.length-start).fill(15);for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===node)for(let i=Math.max(start,r.startOffset);i<r.endOffset;i++)v[i-start]=Number(name.slice(9));return v}
      function hidden(node){for(let el=node.nodeType===3?node.parentElement:node;el;el=el.parentElement){const s=w.getComputedStyle(el);if(s.visibility==='hidden'||Number(s.opacity)===0)return true}return false}
      const samples=[],start=w.performance.now();let firstBody=null,settled=false;
      while(w.performance.now()-start<2200){
        const thinkingPending=Math.min(...levels(tail,4))<15;
        const bodyVisible=!hidden(body)&&Math.max(...levels(body))>0;
        const toolHidden=tool?hidden(tool)||Number(w.getComputedStyle(tool.firstChild).opacity)===0:false;
        if(bodyVisible&&firstBody===null)firstBody=w.performance.now()-start;
        const card=seat.querySelector('[data-streaming] pre');
        samples.push({thinkingPending,bodyVisible,toolHidden,cardVisible:card?!hidden(card):false});
        if(!thinkingPending&&!hidden(body)&&Math.min(...levels(body))===15){settled=true;break}
        await new Promise(w.requestAnimationFrame);
      }
      return {samples,settled,firstBody,elapsed:w.performance.now()-start};
    })`);
    assert.ok(result.samples[0].thinkingPending,mode+': pending thinking setup');
    for(const sample of result.samples){
      if(sample.thinkingPending)assert.equal(sample.bodyVisible,false,mode+': body overtook thinking '+JSON.stringify(sample));
      if(sample.toolHidden)assert.equal(sample.bodyVisible,false,mode+': body overtook held tool');
      if(sample.thinkingPending)assert.equal(sample.cardVisible,false,mode+': code card overtook thinking');
    }
    assert.ok(result.settled,mode+': ordered chain must drain');
    console.log('  synthetic complete chain '+mode+': first body '+Math.round(result.firstBody)+'ms, drain '+Math.round(result.elapsed)+'ms');
  }
});
for (const replay of hostSnapshots.cases) await test('actual host Markdown replay: ' + replay.id, async () => {
  const result = await run(`return __withIsolatedFixture(async w => {
    const replay=${JSON.stringify(replay)},d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.style.cssText='width:280px;font:16px/24px sans-serif;overflow-wrap:anywhere';
    scope.innerHTML='<section data-chat-flow-key="host-replay"><div data-streaming="true" style="display:flow-root"></div><div>footer</div></section>';d.body.append(scope);await flush();
    const body=scope.querySelector('[data-streaming]'),footer=body.nextSibling,samples=[];let oldEffects=0;
    const level=(node,index)=>{for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===node&&r.startOffset<=index&&r.endOffset>index)return Number(name.slice(9));return 15};
    const sample=(frame,index)=>{
      const expected=body.cloneNode(true);expected.removeAttribute('data-streaming');expected.style.cssText='display:flow-root;position:absolute;visibility:hidden;width:280px';
      // The parser strips an escaped opening bracket, making its provisional
      // DOM indistinguishable. It may compact while live, but must restore.
      const compact=frame.streaming&&(replay.kind==='citation'||replay.kind==='malformed'||replay.kind==='icon'||(replay.id.startsWith('escaped-label')&&!frame.accumulatedSource.endsWith(')')));
      let raw=0;
      if(compact)for(const a of expected.querySelectorAll('a'))if(a.textContent===a.getAttribute('href')){a.remove();raw++}
      scope.firstChild.append(expected);const expectedHeight=expected.getBoundingClientRect().height;expected.remove();
      const icons=[];
      for(const a of body.querySelectorAll('a')){
        const icon=a.querySelector(':scope > svg');if(!icon)continue;
        const walker=d.createTreeWalker(a,w.NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('svg')?w.NodeFilter.FILTER_REJECT:w.NodeFilter.FILTER_ACCEPT});const first=walker.nextNode();
        let prior=15;for(const [name,h] of w.CSS.highlights)for(const r of h)if(body.contains(r.startContainer)&&!a.contains(r.startContainer)&&(r.startContainer.compareDocumentPosition(a)&4))prior=Math.min(prior,Number(name.slice(9)));
        let opacity=1,visible=true;for(let el=icon;el&&body.contains(el);el=el.parentElement){const style=w.getComputedStyle(el);opacity*=Number(style.opacity);if(style.visibility==='hidden'||style.display==='none')visible=false}
        icons.push({prior,own:first?level(first,0):15,opacity,visible,width:a.getBoundingClientRect().width,raw:a.textContent===a.getAttribute('href')});
      }
      samples.push({index,raw,height:body.getBoundingClientRect().height,expectedHeight,footer:footer.getBoundingClientRect().top-body.getBoundingClientRect().top,icons});
    };
    for(let index=0;index<replay.frames.length;index++){
      const frame=replay.frames[index],previous=[...body.querySelectorAll('a,svg')];body.innerHTML=frame.html;
      if(!frame.streaming)body.removeAttribute('data-streaming');await flush();oldEffects+=previous.reduce((sum,el)=>sum+el.getAnimations().length,0);sample(frame,index);
      const ticks=replay.schedule==='boundaries'?3:1;
      for(let i=0;i<ticks;i++){await new Promise(w.requestAnimationFrame);sample(frame,index)}
    }
    const last=replay.frames.at(-1),until=w.performance.now()+2000;
    while(w.__dshAnthropicFonts.streamFadeStatus().active&&w.performance.now()<until){await new Promise(w.requestAnimationFrame);sample(last,replay.frames.length-1)}
    const reference=d.createElement('div');reference.innerHTML=last.html;
    return {samples,oldEffects,text:body.textContent,expectedText:reference.textContent,links:[...body.querySelectorAll('a')].map(a=>({href:a.getAttribute('href'),target:a.target,rel:a.rel,width:a.getBoundingClientRect().width,effects:a.getAnimations({subtree:true}).length})),expectedLinks:[...reference.querySelectorAll('a')].map(a=>a.getAttribute('href')),status:w.__dshAnthropicFonts.streamFadeStatus()};
  })`);
  assert.equal(result.oldEffects,0,'replacement must cancel detached effects');
  assert.equal(result.text,result.expectedText,'host final text preserved');assert.equal(result.status.active,0,'finite drain');
  assert.deepEqual(result.links.map(a=>a.href),result.expectedLinks);
  for(const a of result.links){assert.ok(a.width>0,'final link restored');assert.equal(a.effects,0);assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer')}
  for(const s of result.samples){
    assert.ok(Math.abs(s.height-s.expectedHeight)<1,replay.id+': provisional layout differs from compact reference '+JSON.stringify(s));
    assert.ok(Math.abs(s.footer-s.height)<1,replay.id+': footer must track paragraph geometry');
    for(const icon of s.icons){if(icon.prior<15||icon.own===0)assert.ok(!icon.visible||icon.opacity===0,replay.id+': globe led text '+JSON.stringify(icon));if(icon.visible&&icon.width>0&&icon.prior===15)assert.ok(icon.opacity<=icon.own/15+.002,replay.id+': globe opacity led label '+JSON.stringify(icon))}
  }
  if(replay.kind==='citation')assert.ok(result.samples.some(s=>s.raw>0),replay.id+': test must exercise unfinished autolink');
});
await test('unfinished citation URL stays compact on every frame and restores malformed final text', async () => {
  for (const mode of ['append','replace','cross-node','malformed']) {
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r))),mode=${JSON.stringify(mode)};
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="citation"><div data-streaming="true"><p style="width:280px;font:16px/24px sans-serif;margin:0;overflow-wrap:anywhere">seed</p></div><div id="footer">footer</div></section>';d.body.append(scope);await flush();
      const body=scope.querySelector('[data-streaming]'),p=body.firstChild,footer=body.nextSibling;
      const url='https://apnews.com/article/'+ 'very-long-destination-'.repeat(20);
      const svg='<svg aria-hidden="true" width="14" height="14" style="opacity:.8"><circle cx="7" cy="7" r="6"/></svg>';
      const prefix='source [AP](';
      p.innerHTML=mode==='cross-node'?'source <em>[A</em><span>P](</span>':prefix;
      const a=d.createElement('a');a.setAttribute('href',url.slice(0,30));a.setAttribute('aria-label','host link');a.setAttribute('style','color:blue;opacity:.9');a.innerHTML=svg+url.slice(0,30);p.append(a);await flush();
      const samples=[],oldLinks=[];let link=a;
      const sample=()=>{const box=p.getBoundingClientRect();samples.push({height:box.height,footer:footer.getBoundingClientRect().top,width:link.getBoundingClientRect().width,hidden:w.getComputedStyle(link).visibility==='hidden'})};
      sample();
      for(let end=45;end<url.length+30;end+=30){
        const value=url.slice(0,end);link.setAttribute('href',value);link.lastChild.data=value;
        if(mode==='replace'){oldLinks.push(link);p.innerHTML=p.innerHTML;link=p.querySelector('a')}
        await flush();await new Promise(w.requestAnimationFrame);sample();
      }
      const raw=p.textContent,originalStyle=link.getAttribute('style'),originalHref=link.getAttribute('href');
      const until=w.performance.now()+1500;while(w.__dshAnthropicFonts.streamFadeStatus().active&&w.performance.now()<until)await new Promise(w.requestAnimationFrame);
      const status=w.__dshAnthropicFonts.streamFadeStatus();
      if(mode==='malformed')body.removeAttribute('data-streaming');else p.innerHTML='source <a href="'+url+'">'+svg+'AP</a>';
      await flush();await new Promise(w.requestAnimationFrame);
      const finalHeight=p.getBoundingClientRect().height;
      return {samples,raw,finalHeight,status,oldEffects:oldLinks.map(el=>el.getAnimations().length),restored:mode!=='malformed'||(p.textContent===raw&&link.style.color==='blue'&&link.style.opacity==='0.9'&&link.getAttribute('aria-label')==='host link'&&link.getAttribute('href')===originalHref&&link.getAnimations().length===0&&w.getComputedStyle(link).visibility==='visible')};
    })`);
    assert.ok(r.samples.length>10,mode);
    for(const s of r.samples){assert.ok(s.height<=25,mode+': provisional URL created extra lines '+JSON.stringify(s));assert.equal(s.width,0,mode);assert.ok(s.hidden,mode);assert.equal(s.footer,r.samples[0].footer,mode+': footer jumped')}
    assert.ok(r.oldEffects.every(n=>n===0),mode);assert.equal(r.status.active,0,mode+': unpainted destination cannot keep backlog active');assert.equal(r.status.buffer,0,mode);
    assert.ok(r.restored,mode);
    if(mode==='malformed')assert.ok(r.finalHeight>100,'malformed final Markdown is fully restored');else assert.ok(Math.abs(r.finalHeight-r.samples[0].height)<=1,mode+': closing bracket caused paragraph shrink');
  }
});
await test('malformed URL restoration queues behind prose without another upstream arrival', async () => {
  for(const mode of ['settle','space']){
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r))),mode=${JSON.stringify(mode)};
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="restore"><div data-streaming="true"><p>seed</p></div></section>';d.body.append(scope);await flush();
      const body=scope.querySelector('[data-streaming]'),p=body.firstChild,prose='待完成前文'.repeat(60),url='https://apnews.com/'+ 'destination-'.repeat(12);
      p.textContent=prose+'[AP](https:';await flush();
      p.innerHTML=prose+'[AP](<a href="'+url+'"><svg aria-hidden="true" width="14" height="14"><circle cx="7" cy="7" r="6"/></svg>'+url+'</a>';await flush();
      const a=p.querySelector('a'),node=a.lastChild,icon=a.firstChild,before=w.__dshAnthropicFonts.streamFadeStatus();
      if(mode==='settle')body.removeAttribute('data-streaming');else p.append(' ');await flush();
      const ranges=[...w.CSS.highlights].flatMap(([name,h])=>[...h].filter(r=>r.startContainer===node).map(r=>({start:r.startOffset,end:r.endOffset,level:Number(name.slice(9))})));
      const levels=Array.from({length:node.length},()=>[]);for(const r of ranges)for(let i=r.start;i<r.end;i++)levels[i].push(r.level);
      return {before,after:w.__dshAnthropicFonts.streamFadeStatus(),levels,hidden:w.getComputedStyle(icon).visibility==='hidden',restored:a.getAnimations().length===0};
    })`);
    assert.ok(r.before.active>0,mode);assert.ok(r.restored,mode);assert.ok(r.hidden,mode+': icon must still wait');
    assert.ok(r.levels.every(levels=>levels.length===1&&levels[0]===0),mode+': restored URL must be covered once, with no conflicting spans');
    if(mode==='settle')assert.equal(r.after.arrival,r.before.arrival,'restoration is not new transport input');
  }
});
await test('citation globe waits for preceding paint and follows only its own label opacity', async () => {
  const r=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="icon"><div data-streaming="true"><p>seed</p></div></section>';d.body.append(scope);await flush();
    const p=scope.querySelector('p');p.firstChild.appendData('尚未亮起的前文'.repeat(12));p.insertAdjacentHTML('beforeend','<a href="https://apnews.com" style="opacity:.9"><svg aria-hidden="true" width="14" height="14" style="opacity:.8"><circle cx="7" cy="7" r="6"/></svg>AP label</a>');await flush();
    const level=(node,index)=>{for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===node&&r.startOffset<=index&&r.endOffset>index)return Number(name.slice(9));return 15};
    const samples=[],start=w.performance.now();let replaced=false,oldEffects=null;
    while(w.performance.now()-start<2500){const a=p.querySelector('a'),icon=a.firstChild,style=w.getComputedStyle(icon),own=level(a.lastChild,0);samples.push({prior:level(p.firstChild,p.firstChild.length-1),own,opacity:Number(style.opacity),visible:style.visibility!=='hidden',anchor:Number(w.getComputedStyle(a).opacity)});
      if(own>0&&own<15&&!replaced){p.innerHTML=p.innerHTML;await flush();oldEffects=icon.getAnimations().length;replaced=true}
      if(own===15&&icon.getAnimations().length===0)break;await new Promise(w.requestAnimationFrame)
    }
    return {samples,replaced,oldEffects};
  })`);
  assert.ok(r.samples.some(s=>s.prior<15));assert.ok(r.samples.some(s=>s.own>0&&s.own<15));assert.ok(r.replaced);assert.equal(r.oldEffects,0);
  for(const s of r.samples){assert.equal(s.anchor,.9,'anchor text must not get a second opacity effect');if(s.prior<15||s.own===0)assert.ok(!s.visible||s.opacity===0,'globe overtook prose '+JSON.stringify(s));else {assert.ok(s.visible,'no extra release delay');assert.ok(Math.abs(s.opacity-.8*s.own/15)<.002,JSON.stringify(s))}}
});
await test('provisional link cleanup preserves host DOM for disable dispose removal and hydration', async () => {
  for(const mode of ['disable','dispose','remove','hidden','disclosure','hydrate','settled','bare','escaped','code']){
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r))),mode=${JSON.stringify(mode)};
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="cleanup-link"><div data-streaming="true"><p>seed</p></div></section>';
      const body=scope.querySelector('[data-streaming]'),p=body.firstChild,url='https://apnews.com/'+ 'long-'.repeat(60);
      if(mode==='disclosure'){body.removeAttribute('data-streaming');body.dataset.variant='think';body.dataset.state='running';body.dataset.expanded='true'}
      const markup=(mode==='bare'?'':mode==='escaped'?'&#92;[AP](':'[AP](')+'<a href="'+url+'" style="opacity:.7" aria-label="original">'+url+'</a>';
      if(mode==='hydrate'){p.innerHTML=markup;d.body.append(scope);await flush()}else{d.body.append(scope);await flush();if(mode==='settled')body.removeAttribute('data-streaming');p.innerHTML=mode==='code'?'<code>'+markup+'</code>':markup;await flush()}
      const a=p.querySelector('a'),before=a.outerHTML,held=a.getAnimations().length;
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(false);if(mode==='dispose')w.__disposers.at(-1)();if(mode==='remove')a.remove();if(mode==='hidden'){Object.defineProperty(d,'hidden',{value:true});d.dispatchEvent(new w.Event('visibilitychange'))}if(mode==='disclosure'){body.dataset.expanded='false';p.remove()}await flush();
      const result={held,effects:a.getAnimations().length,before,after:a.outerHTML,width:a.getBoundingClientRect().width};
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(true);return result;
    })`);
    if(['disable','dispose','remove','hidden','disclosure'].includes(mode)){assert.ok(r.held,mode);assert.equal(r.effects,0,mode);assert.equal(r.before.replace(/;?\\s*--daf-ink:[^;]+;?/g,''),r.after.replace(/;?\\s*--daf-ink:[^;]+;?/g,''),mode)}else{assert.equal(r.held,0,mode);assert.ok(r.width>0,mode)}
  }
});
await test('same-body inline and block surfaces follow actual paint with no release delay', async () => {
  for (const mode of ['inline','pre','wrapper']) {
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="decor"><div data-streaming="true"><p>seed</p></div></section>';d.body.append(scope);await flush();
      const body=scope.querySelector('[data-streaming]'),p=body.firstChild;const mode=${JSON.stringify(mode)};
      p.firstChild.appendData('尚未完成的前文'.repeat(8));
      const markup=mode==='inline'?'<code id="dec" style="display:inline-flex;background:rgb(230,230,230);border:1px solid gray;padding:0 5px">hl_test.png.annotated.png</code>':mode==='pre'?'<pre id="dec" style="background:rgb(230,230,230)"><code>answer</code></pre>':'<div id="dec" class="md-code-block" style="background:rgb(230,230,230)"><div data-code-block-banner><button>Copy</button></div><div data-code-block-content><pre><code>answer</code></pre></div></div>';
      (mode==='inline'?p:body).insertAdjacentHTML('beforeend',markup);await flush();
      let el=scope.querySelector('#dec');const before=el.getAttribute('style'),old=el,held=w.getComputedStyle(el).visibility==='hidden';
      body.innerHTML=body.innerHTML;await flush();el=scope.querySelector('#dec');
      const replaced=w.getComputedStyle(el).visibility==='hidden',oldEffects=old.getAnimations().length;
      const level=(node,index)=>{for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===node&&r.startOffset<=index&&r.endOffset>index)return Number(name.slice(9));return 15};
      const samples=[],start=w.performance.now();let released=false;
      while(w.performance.now()-start<2500){const prose=body.querySelector('p').firstChild;const prior=level(prose,prose.length-1);const own=mode==='inline'?level(el.firstChild,0):15;const visible=w.getComputedStyle(el).visibility!=='hidden';samples.push({prior,own,visible,opacity:Number(w.getComputedStyle(el).opacity)});if(visible){released=true;break}await new Promise(w.requestAnimationFrame)}
      const progress=Number(w.getComputedStyle(el).opacity);const fading=el;body.innerHTML=body.innerHTML;await flush();el=scope.querySelector('#dec');const remountProgress=Number(w.getComputedStyle(el).opacity),fadingOldEffects=fading.getAnimations().length;
      while(el.getAnimations().length&&w.performance.now()-start<2500)await new Promise(w.requestAnimationFrame);
      body.innerHTML=body.innerHTML;await flush();const settled=scope.querySelector('#dec');
      return {held,replaced,oldEffects,released,samples,progress,remountProgress,fadingOldEffects,style:settled.getAttribute('style'),before,replayed:settled.getAnimations().length};
    })`);
    assert.ok(r.held,mode);assert.ok(r.replaced,mode);assert.equal(r.oldEffects,0,mode);assert.ok(r.released,mode);
    for(const s of r.samples){if(s.prior<15||s.own===0)assert.equal(s.visible,false,mode+JSON.stringify(s));if(s.prior===15&&s.own>0)assert.equal(s.visible,true,'no extra frame/timer '+mode+JSON.stringify(s))}
    if(mode==='inline'){const first=r.samples.at(-1);assert.ok(Math.abs(first.opacity-first.own/15)<0.01,'surface opacity follows first glyph without a separate timer')}
    assert.equal(r.fadingOldEffects,0,mode);assert.ok(r.remountProgress>=r.progress,mode+': remount cannot restart fade');
    assert.equal(r.replayed,0,mode);assert.equal(r.style.replace(/;?\s*--daf-ink:[^;]+;?/g,''),r.before.replace(/;?\s*--daf-ink:[^;]+;?/g,''),mode);
  }
});
await test('inserted and reordered code cannot inherit settled positional ownership', async () => {
  for(const mode of ['inline','pre','wrapper']){
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r))),mode=${JSON.stringify(mode)};
      const markup=mode==='inline'?'<code>same</code>':mode==='pre'?'<pre><code>same</code></pre>':'<div class="md-code-block"><div data-code-block-banner>same</div><div data-code-block-content><pre><code>same</code></pre></div></div>';
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="identity"><div data-streaming="true"><p>seed</p>'+markup+'</div></section>';d.body.append(scope);await flush();
      const body=scope.querySelector('[data-streaming]'),old=body.lastElementChild,history=w.getComputedStyle(old).visibility;
      body.innerHTML='<p>seed'+ '尚未完成的文字'.repeat(15)+'</p>'+markup+markup;await flush();
      const owners=[body.children[1],body.children[2]],inserted=owners.map(el=>w.getComputedStyle(el).visibility);
      const until=w.performance.now()+2500;while(owners.some(el=>el.getAnimations().length)&&w.performance.now()<until)await new Promise(w.requestAnimationFrame);
      const settled=owners.map(el=>w.getComputedStyle(el).visibility);
      // Move an existing, settled owner behind newly queued prose as well.
      body.firstChild.firstChild.appendData('重排前文'.repeat(15));body.append(owners[0]);await flush();
      return {history,inserted,settled,reordered:w.getComputedStyle(owners[0]).visibility};
    })`);
    assert.equal(r.history,'visible',mode);assert.deepEqual(r.inserted,['hidden','hidden'],mode);assert.deepEqual(r.settled,['visible','visible'],mode);assert.equal(r.reordered,'hidden',mode);
  }
});
await test('same-body decoration cleanup cancels holds without changing host styles', async () => {
  for(const mode of ['remove','disable','dispose']){
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="cleanup"><div data-streaming="true"><p>seed</p></div></section>';d.body.append(scope);await flush();
      const body=scope.querySelector('[data-streaming]');body.firstChild.firstChild.appendData('等待'.repeat(80));body.insertAdjacentHTML('beforeend','<pre style="opacity:.8;background:gray" aria-label="host"><code>answer</code></pre>');await flush();const el=body.lastChild,before=el.outerHTML,held=el.getAnimations().length;
      const mode=${JSON.stringify(mode)};if(mode==='remove')el.remove();if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(false);if(mode==='dispose')w.__disposers.at(-1)();await flush();const result={held,effects:el.getAnimations().length,before,after:el.outerHTML};if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(true);return result;
    })`);
    assert.ok(r.held,mode);assert.equal(r.effects,0,mode);assert.equal(r.before,r.after,mode);
  }
});
await test('held code-only body replacement and cleanup preserve host attributes', async () => {
  for(const mode of ['release','remove','disable','dispose']){
    const r=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';scope.innerHTML='<section data-chat-flow-key="a"><div data-streaming="true"><p>seed</p></div></section>';d.body.append(scope);await flush();scope.querySelector('p').firstChild.appendData('尚未完成'.repeat(25));
      const seat=d.createElement('section');seat.dataset.chatFlowKey='b';seat.innerHTML='<div data-streaming="true" style="opacity:.8" aria-label="answer"><pre><code>answer</code></pre></div>';scope.append(seat);await flush();
      const old=seat.firstChild,before=[...old.attributes].map(a=>[a.name,a.value]);const held=w.getComputedStyle(old).opacity==='0';seat.innerHTML=seat.innerHTML;await flush();const body=seat.firstChild,replaced=w.getComputedStyle(body).opacity==='0',oldEffects=old.getAnimations().length;
      const mode=${JSON.stringify(mode)};
      if(mode==='remove'){seat.remove();await flush()}
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(false);
      if(mode==='dispose')w.__disposers.at(-1)();
      const until=w.performance.now()+2000;while(body.getAnimations().length&&w.performance.now()<until)await new Promise(w.requestAnimationFrame);
      const result={held,replaced,oldEffects,before,after:[...body.attributes].map(a=>[a.name,a.value]),effects:body.getAnimations().length};
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(true);
      return result;
    })`);
    assert.ok(r.held,mode);assert.ok(r.replaced,mode);assert.equal(r.oldEffects,0,mode);assert.equal(r.effects,0,mode);assert.deepEqual(r.after,r.before,mode);
  }
});
await test('process rows wait for preceding thinking across commits and seats', async () => {
  for (const mode of ['same-seat','same-commit','sibling-seat','final-commit','replacement','final-replacement']) {
    const result = await run(`return __withIsolatedFixture(async w => {
      const d=w.document, flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
      scope.innerHTML='<section data-chat-flow-key="thinking"><div data-variant="think" data-state="running" data-expanded="true"><div data-disclosure-header>思考</div><p>seed</p></div></section>';
      d.body.append(scope);await flush();
      const seat=scope.firstChild,think=seat.firstChild,p=think.querySelector('p');
      const mode=${JSON.stringify(mode)};
      p.firstChild.appendData('尚未完全亮起的思考尾部'.repeat(5));
      if(mode!=='same-commit'&&mode!=='final-commit')await flush();
      if(mode==='final-commit'||mode==='final-replacement')think.dataset.state='ok';
      if(mode==='final-replacement')seat.innerHTML=seat.innerHTML;
      const host=mode==='sibling-seat'?d.createElement('section'):seat;
      if(host!==seat){host.dataset.chatFlowKey='tool';scope.append(host)}
      host.insertAdjacentHTML('beforeend','<div data-variant="command" data-state="running" style="opacity:.8" aria-label="host tool"><div data-disclosure-header>运行命令</div><div><button>expanded action</button><pre>expanded output</pre></div></div><div data-streaming="true"><p>later body</p></div>');
      await flush();
      let row=host.querySelector('[data-variant="command"]');
      const originalStyle=row.getAttribute('style'),originalAria=row.getAttribute('aria-label');
      if(mode==='replacement'){host.innerHTML=host.innerHTML;await flush();row=host.querySelector('[data-variant="command"]')}
      const levels=()=>{const p=scope.querySelector('[data-variant="think"] p');const values=Array(p.textContent.length-4).fill(15);for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===p.firstChild)for(let i=Math.max(4,r.startOffset);i<r.endOffset;i++)values[i-4]=Number(name.slice(9));return values};
      const samples=[];let visible=false,bodyAppends=0;const start=w.performance.now();
      while(w.performance.now()-start<3000){
        const style=w.getComputedStyle(row),header=w.getComputedStyle(row.firstChild);
        const hidden=style.visibility==='hidden'||Number(style.opacity)===0;
        samples.push({min:Math.min(...levels()),hidden,opacity:style.opacity,headerOpacity:header.opacity,height:row.getBoundingClientRect().height});
        if(!hidden){visible=true;break}
        host.querySelector('[data-streaming] p').firstChild.appendData('后续正文');bodyAppends++;
        await new Promise(w.requestAnimationFrame);
      }
      const activeAtRelease=w.__dshAnthropicFonts.streamFadeStatus().active;
      await new Promise(r=>w.setTimeout(r,220));
      return {mode,samples,visible,bodyAppends,activeAtRelease,style:row.getAttribute('style'),aria:row.getAttribute('aria-label'),originalStyle,originalAria};
    })`);
    assert.ok(result.samples[0].min<15, mode+': setup must contain pending thinking');
    assert.equal(result.samples[0].hidden,true,mode+': first paint must hide the whole row');
    for(const sample of result.samples)if(sample.min<15)assert.equal(sample.hidden,true,mode+': tool leaked before preceding text: '+JSON.stringify(sample));
    assert.ok(result.visible,mode+': later body must not deadlock release');
    assert.ok(result.activeAtRelease>0,mode+': later text must still be fading when the tool releases');
    assert.ok(result.samples.every(s=>s.height>0),mode+': retain layout');
    assert.equal(result.style,result.originalStyle);assert.equal(result.aria,result.originalAria);
    console.log('  synthetic ordering '+mode+': '+result.samples.length+' frames, '+result.bodyAppends+' subsequent body appends');
  }
});
await test('pending process replacement and cancellation restore host state exactly', async () => {
  for(const mode of ['release','remove','remove-source','disable','dispose','reduced-motion']) {
    const result=await run(`return __withIsolatedFixture(async w=>{
      const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
      const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
      scope.innerHTML='<section data-chat-flow-key="outer"><section data-chat-flow-key="thinking"><div data-variant="think" data-state="running" data-expanded="true"><p>seed</p></div></section></section>';
      d.body.append(scope);await flush();const group=scope.firstChild,think=group.firstChild;
      think.querySelector('p').firstChild.appendData('排队等待的思考'.repeat(10));await flush();
      const seat=d.createElement('section');seat.dataset.chatFlowKey='pending-tool';
      seat.innerHTML='<div data-variant="command" data-tool="shell" data-state="running" style="opacity: .7; visibility: visible; color: red" aria-hidden="false" aria-label="Run" tabindex="-1"><div data-disclosure-header>运行命令</div><button style="visibility:visible">expanded control</button></div>';
      const old=seat.firstChild,before={style:old.getAttribute('style'),attrs:[...old.attributes].map(a=>[a.name,a.value])};
      group.append(seat);await flush();const held=w.__dshAnthropicFonts.streamFadeStatus().rowsPending;
      seat.innerHTML=seat.innerHTML;await flush();const row=seat.firstChild;
      const replaced={oldAnimations:old.getAnimations().length,opacity:w.getComputedStyle(row).opacity,pending:w.__dshAnthropicFonts.streamFadeStatus().rowsPending};
      const mode=${JSON.stringify(mode)};
      if(mode==='remove')seat.remove();
      if(mode==='remove-source')think.remove();
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(false);
      if(mode==='dispose')w.__disposers.at(-1)();
      if(mode==='reduced-motion'){
        const native=w.matchMedia.bind(w);w.matchMedia=q=>q.includes('prefers-reduced-motion')?{matches:true}:native(q);
        d.dispatchEvent(new w.Event('visibilitychange'));
      }
      await flush();const until=w.performance.now()+2500;
      while((row.getAnimations({subtree:true}).length||w.__dshAnthropicFonts?.streamFadeStatus().active)&&w.performance.now()<until)await new Promise(w.requestAnimationFrame);
      const after={style:row.getAttribute('style'),attrs:[...row.attributes].map(a=>[a.name,a.value])};
      const animations=row.getAnimations({subtree:true}).length;
      const pending=w.__dshAnthropicFonts?.streamFadeStatus().rowsPending??0;
      if(mode==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(true);
      return {mode,before,after,held,replaced,animations,pending};
    })`);
    assert.equal(result.held,1,result.mode);
    assert.deepEqual(result.replaced,{oldAnimations:0,opacity:'0',pending:1},result.mode);
    assert.deepEqual(result.after,result.before,result.mode+': styles/accessibility must be unchanged');
    assert.equal(result.animations,0,result.mode);assert.equal(result.pending,0,result.mode);
  }
});
await test('process barriers ignore other conversations, later text and own body', async () => {
  const result=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
    scope.innerHTML='<section data-chat-flow-key="ancestor"><div data-streaming="true"><p>prefix</p></div></section>';
    d.body.append(scope);await flush();const root=scope.querySelector('[data-streaming]');
    root.insertAdjacentHTML('beforeend','<div data-variant="command" data-state="running"><div data-disclosure-header>运行命令</div><p>own streamed body</p></div><p>'+ 'later output'.repeat(20)+'</p>');await flush();
    const row=root.querySelector('[data-variant]');const ownPending=w.__dshAnthropicFonts.streamFadeStatus().rowsPending;
    const other=d.createElement('main');other.dataset.conversationRegion='chat';other.innerHTML='<section data-chat-flow-key="other"><div data-streaming="true">seed</div></section>';d.body.append(other);await flush();other.querySelector('[data-streaming]').firstChild.appendData('other conversation'.repeat(20));await flush();
    const seat=d.createElement('section');seat.dataset.chatFlowKey='independent';seat.innerHTML='<div data-variant="read" data-state="running"><div data-disclosure-header>read</div></div>';scope.prepend(seat);await flush();
    return {ownPending,pending:w.__dshAnthropicFonts.streamFadeStatus().rowsPending,visibility:w.getComputedStyle(row).visibility,active:w.__dshAnthropicFonts.streamFadeStatus().active};
  })`);
  assert.ok(result.active>0);assert.equal(result.ownPending,0);assert.equal(result.pending,0);assert.equal(result.visibility,'visible');
});
await test('list bullets and numbers never lead their queued first character', async () => {
  const rows = await run(`return __withIsolatedFixture(async w => {
    const d = w.document, flush = () => new Promise(r => w.queueMicrotask(() => w.queueMicrotask(r)));
    const canvas = d.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', {willReadFrequently:true});
    const alpha = li => {ctx.clearRect(0,0,1,1); ctx.fillStyle = w.getComputedStyle(li,'::marker').color; ctx.fillRect(0,0,1,1); return ctx.getImageData(0,0,1,1).data[3] / 255};
    const firstLevel = li => {
      const walker = d.createTreeWalker(li, w.NodeFilter.SHOW_TEXT);
      let n; while ((n=walker.nextNode()) && !n.data.trim()) {}
      if (!n) return 0;
      const offset = n.data.search(/\\S/);
      for (const [name,h] of w.CSS.highlights) for (const r of h)
        if (r.startContainer === n && r.startOffset <= offset && r.endOffset > offset) return Number(name.slice(9));
      return 15;
    };
    const rows = [];
    for (const tag of ['ul','ol']) {
      const seat = d.createElement('section');seat.dataset.chatFlowKey='marker-'+tag;
      seat.innerHTML='<div data-streaming="true"><p>起点</p></div>';d.querySelector('main').append(seat);await flush();
      const root = seat.firstChild;
      root.insertAdjacentHTML('beforeend','<'+tag+'>'+Array.from({length:6},(_,i)=>'<li>第'+i+'项：尚未显示的正文内容，需要逐项出现。</li>').join('')+'</'+tag+'>');await flush();
      const snapshot = phase => {for (const li of root.querySelectorAll('li')) rows.push({tag,phase,level:firstLevel(li),alpha:alpha(li)})};
      snapshot('queued');
      const until=w.performance.now()+450;
      while(w.performance.now()<until){await new Promise(w.requestAnimationFrame);snapshot('frame')}
      root.innerHTML=root.innerHTML;await flush();snapshot('replaced');
      root.removeAttribute('data-streaming');
      const end=w.performance.now()+2500;
      while(w.__dshAnthropicFonts.streamFadeStatus().active && w.performance.now()<end) await new Promise(w.requestAnimationFrame);
      snapshot('settled');seat.remove();await flush();
    }
    return rows;
  })`);
  assert.ok(rows.filter(r=>r.phase==='queued').every(r=>r.level===0), 'setup must queue the list');
  assert.ok(rows.some(r=>r.phase==='frame' && r.level>0 && r.level<15), 'must sample an in-progress fade');
  for (const row of rows) {
    if (row.level===0) assert.equal(row.alpha,0,'marker appeared ahead of text: '+JSON.stringify(row));
    assert.ok(Math.abs(row.alpha-row.level/15)<0.005,'marker fade differs from first character: '+JSON.stringify(row));
    if (row.phase==='settled') assert.equal(row.alpha,1,'settled marker must be restored');
  }
});
await test('nested list markers follow separate text fades and preserve host marker ink', async () => {
  const rows = await run(`return __withIsolatedFixture(async w => {
    const d=w.document, flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const style=d.createElement('style');style.textContent='li::marker{color:rgb(80,90,100)}';d.head.append(style);
    const seat=d.createElement('section');seat.dataset.chatFlowKey='nested-markers';
    seat.innerHTML='<div data-streaming="true"><p>seed</p></div>';d.querySelector('main').append(seat);await flush();
    const root=seat.firstChild;
    root.insertAdjacentHTML('beforeend','<ul><li id="parentItem">  <strong>父项正文先出现</strong><ol><li id="childItem">子项正文随后出现</li></ol></li><li id="siblingItem">下一项正文</li></ul>');await flush();
    const canvas=d.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const rows=[];
    const sample=phase=>{for(const li of root.querySelectorAll('li')){
      const walker=d.createTreeWalker(li,w.NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())&&!node.data.trim()){}
      const offset=node.data.search(/\\S/);let level=15;
      for(const [name,h] of w.CSS.highlights)for(const r of h)if(r.startContainer===node&&r.startOffset<=offset&&r.endOffset>offset)level=Number(name.slice(9));
      ctx.clearRect(0,0,1,1);ctx.fillStyle=w.getComputedStyle(li,'::marker').color;ctx.fillRect(0,0,1,1);
      rows.push({id:li.id,phase,level,rgba:[...ctx.getImageData(0,0,1,1).data],opacity:w.getComputedStyle(li).opacity});
    }};
    sample('queued');const until=w.performance.now()+1100;
    while(w.performance.now()<until){await new Promise(w.requestAnimationFrame);sample('frame')}
    root.innerHTML=root.innerHTML;await flush();sample('replacement');
    root.removeAttribute('data-streaming');const end=w.performance.now()+2500;
    while(w.__dshAnthropicFonts.streamFadeStatus().active&&w.performance.now()<end)await new Promise(w.requestAnimationFrame);
    sample('settled');return rows;
  })`);
  assert.ok(rows.some(r=>r.id==='parentItem'&&r.level>0&&r.level<15));
  assert.ok(rows.some(r=>r.id==='childItem'&&r.level>0&&r.level<15));
  for(const row of rows){
    assert.ok(Math.abs(row.rgba[3]/255-row.level/15)<0.005,JSON.stringify(row));
    assert.equal(row.opacity,'1','list ancestors must never be faded');
    if(row.phase==='settled')assert.deepEqual(row.rgba,[80,90,100,255],'host marker ink must be restored');
  }
});
await test('body commits preserve marker owners inside an independent reasoning source', async () => {
  const result=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const seat=d.createElement('section');seat.dataset.chatFlowKey='reasoning-marker';
    seat.innerHTML='<div data-streaming="true"><p>body</p><div data-variant="think" data-state="running" data-expanded="true"><div data-disclosure-header>header</div><p>thinking</p></div></div>';
    d.querySelector('main').append(seat);await flush();
    const root=seat.firstChild,think=root.querySelector('[data-variant="think"]');
    think.insertAdjacentHTML('beforeend','<ul><li>'+ '尚未显示的推理正文'.repeat(8)+'</li><li></li></ul>');await flush();
    const before=[...think.querySelectorAll('li')].map(li=>li.hasAttribute('data-daf-stream-marker'));
    root.querySelector('p').firstChild.appendData('正文更新');await flush();
    const after=[...think.querySelectorAll('li')].map(li=>({owned:li.hasAttribute('data-daf-stream-marker'),alpha:li.style.getPropertyValue('--daf-marker-alpha')}));
    return {before,after};
  })`);
  assert.deepEqual(result,{before:[true,true],after:[{owned:true,alpha:'0%'},{owned:true,alpha:'0%'}]});
});
await test('hydrated empty history stays visible while newly arriving empty markers wait', async () => {
  const result=await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const owned=li=>li.hasAttribute('data-daf-stream-marker');
    const scope=d.createElement('main');scope.dataset.conversationRegion='chat';
    scope.innerHTML='<section data-chat-flow-key="hydrated-list"><div data-streaming="true"><ul><li id="historyText">已有正文</li><li id="historyEmpty"></li></ul></div></section>';
    d.body.append(scope);await flush();
    const root=scope.querySelector('[data-streaming]'),list=root.querySelector('ul');
    const history=[...list.children].map(owned);
    const empty=d.createElement('li');empty.id='arrivingEmpty';list.append(empty);await flush();
    const waiting={owned:owned(empty),alpha:empty.style.getPropertyValue('--daf-marker-alpha'),history:owned(d.getElementById('historyEmpty'))};
    root.innerHTML=root.innerHTML;await flush();
    const replacement=d.getElementById('arrivingEmpty');const replaced={owned:owned(replacement),alpha:replacement.style.getPropertyValue('--daf-marker-alpha')};
    replacement.textContent='   '+ '随后到达的正文'.repeat(8);await flush();
    const arrived={owned:owned(replacement),alpha:replacement.style.getPropertyValue('--daf-marker-alpha')};
    const finalEmpty=d.createElement('li');root.querySelector('ul').append(finalEmpty);await flush();
    root.removeAttribute('data-streaming');await flush();
    const finalizedEmpty=owned(finalEmpty);
    const end=w.performance.now()+2500;while(w.__dshAnthropicFonts.streamFadeStatus().active&&w.performance.now()<end)await new Promise(w.requestAnimationFrame);
    return {history,waiting,replaced,arrived,finalizedEmpty,left:root.querySelectorAll('[data-daf-stream-marker]').length};
  })`);
  assert.deepEqual(result,{history:[false,false],waiting:{owned:true,alpha:'0%',history:false},replaced:{owned:true,alpha:'0%'},arrived:{owned:true,alpha:'0%'},finalizedEmpty:false,left:0});
});
await test('disable, disposal and source removal release queued and empty marker ownership', async () => {
  const cases=[];
  for(const mode of ['disable','dispose','remove'])for(const emptyOnly of [false,true])cases.push(await run(`return __withIsolatedFixture(async w=>{
    const d=w.document,flush=()=>new Promise(r=>w.queueMicrotask(()=>w.queueMicrotask(r)));
    const seat=d.createElement('section');seat.dataset.chatFlowKey='marker-cleanup';seat.innerHTML='<div data-streaming="true"><p></p></div>';
    d.querySelector('main').append(seat);await flush();
    const root=seat.firstChild;root.insertAdjacentHTML('beforeend','<ul><li>'+ (${JSON.stringify(emptyOnly)}?'':'等待显示的正文'.repeat(10))+'</li><li></li></ul>');await flush();
    const items=[...root.querySelectorAll('li')],before=items.map(li=>li.hasAttribute('data-daf-stream-marker'));
    const active=w.__dshAnthropicFonts.streamFadeStatus().active;
    if(${JSON.stringify(mode)}==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(false);
    else if(${JSON.stringify(mode)}==='dispose')w.__disposers.at(-1)();
    else {seat.remove();await flush();await new Promise(w.requestAnimationFrame)}
    const after=items.map(li=>({owned:li.hasAttribute('data-daf-stream-marker'),ink:li.style.getPropertyValue('--daf-marker-ink'),alpha:li.style.getPropertyValue('--daf-marker-alpha')}));
    if(${JSON.stringify(mode)}==='disable')w.__dshAnthropicFonts.setStreamFadeEnabled(true);
    return {mode:${JSON.stringify(mode)},emptyOnly:${JSON.stringify(emptyOnly)},active,before,after,replayed:items.some(li=>li.hasAttribute('data-daf-stream-marker'))};
  })`));
  for(const result of cases){
    if(result.emptyOnly)assert.equal(result.active,0,'empty markers must not keep RAF alive');
    assert.deepEqual(result.before,[true,true],result.mode);
    assert.deepEqual(result.after,[{owned:false,ink:'',alpha:''},{owned:false,ink:'',alpha:''}],result.mode);
    assert.equal(result.replayed,false,result.mode);
  }
});
await test('card headers keep breathing room and mask scrolled code at rounded corners', async () => {
  const html = (await readFile(new URL('./card-scroll.html', import.meta.url), 'utf8')).replace(/<script src="\.\.\/\.\.\/lib\/client\.js"><\/script>/, '');
  const cases = await run(`return __withIsolatedFixture(async w => {
    const d = w.document, results = [];
    for (const dark of [false, true]) {
      d.body.toggleAttribute('data-ds-dark-theme', dark);
      for (const scroll of [0, 120, 600]) {
        const port = d.getElementById('ordinaryScroll');
        port.scrollTop = scroll;
        const toolPort = d.getElementById('ptcScroll');
        toolPort.scrollTop = scroll;
        await new Promise(w.requestAnimationFrame);
        const header = d.querySelector('#ordinary [data-code-block-banner]');
        const rect = header.getBoundingClientRect(), style = w.getComputedStyle(header);
        const backing = header.parentElement;
        const corner = d.elementFromPoint(rect.x + 2, rect.y + 2);
        const toolRect = toolPort.getBoundingClientRect();
        const toolCorner = d.elementFromPoint(toolRect.x + 2, toolRect.y + 2);
        const pre = d.querySelector('#ordinary pre'); pre.scrollLeft = 40;
        results.push({dark,scroll,height:rect.height,padding:[style.paddingTop,style.paddingBottom],
          sticky:Math.abs(rect.top - (port.getBoundingClientRect().top + port.clientTop)) < 1,
          masked:corner === backing, backing:w.getComputedStyle(backing).backgroundColor,
          canvas:w.getComputedStyle(d.body).backgroundColor,
          toolClipped:!toolPort.contains(toolCorner),toolHeight:toolRect.height,
          toolSticky:Math.abs(d.querySelector('#ptc [data-code-block-banner]').getBoundingClientRect().top - toolRect.top) < 1,
          horizontal:pre.scrollLeft > 0});
      }
    }
    return results;
  }, ${JSON.stringify(html)})`);
  for (const row of cases) {
    assert.equal(row.height, 36, JSON.stringify(row));
    assert.deepEqual(row.padding, ['6px','6px']);
    assert.equal(row.masked, true, 'code leaked through header corner: ' + JSON.stringify(row));
    assert.equal(row.backing, row.canvas);
    assert.equal(row.toolClipped, true, 'tool viewport lost its rounded clip');
    assert.equal(row.toolHeight, 260);
    assert.equal(row.horizontal, true, 'horizontal code scrolling must survive');
    if (row.scroll > 0) { assert.equal(row.sticky, true); assert.equal(row.toolSticky, true); }
  }
});
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
