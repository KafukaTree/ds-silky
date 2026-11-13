#!/usr/bin/env node
// Record actual Chromium paints at their real timestamps; ffmpeg keeps elapsed time.
// Node 22+, Chrome and ffmpeg. No external JS dependencies or existing browser profile.
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const wait = ms => new Promise(r => setTimeout(r, ms));
const temporary = await mkdtemp(join(tmpdir(), 'ds-silky-record-'));
const executable = process.env.CHROME_PATH || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const chrome = spawn(executable, ['--headless=new', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', `--user-data-dir=${temporary}/profile`, '--no-first-run',
  '--disable-background-networking', '--disable-extensions', '--disable-sync',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'],
  {stdio:['ignore','ignore','pipe']});
let chromeError, socket, seq = 0;
chrome.on('error', error => { chromeError = error; });
chrome.stderr.resume();
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`Timed out: ${method}`)); }, 10000);
  pending.set(id, {resolve, reject, timer});socket.send(JSON.stringify({id, method, params}));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', {expression, returnByValue:true});
  if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
try {
  let port;
  for(let i=0;i<200;i++){
    if(chromeError)throw chromeError;
    try{port=(await readFile(join(temporary,'profile/DevToolsActivePort'),'utf8')).split('\n')[0];break}catch{}
    await wait(50);
  }
  if(!port)throw Error('Chrome did not start');
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'}).then(r=>r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  socket.addEventListener('message',({data})=>{
    const m=JSON.parse(data), p=pending.get(m.id);if(!p)return;
    pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);
  });
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride',{width:900,height:560,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate',{url:new URL('../tests/browser/stream-demo.html',import.meta.url).href});
  for(let i=0;i<100;i++){if(await evaluate('!!window.__dshAnthropicFonts'))break;await wait(25)}
  if(!await evaluate('window.__dshAnthropicFonts?.streamFadeStatus().enabled'))throw Error('Stream fade is disabled');
  await evaluate('document.fonts.ready.then(()=>window.fontsReady=true)');
  for(let i=0;i<100&&!await evaluate('!!window.fontsReady');i++)await wait(25);
  await evaluate('playDemo();true');
  const frames=[], start=performance.now();
  while(performance.now()-start<20000){
    const time=performance.now();
    const shot=await send('Page.captureScreenshot',{format:'png'});
    const name=`frame-${String(frames.length).padStart(4,'0')}.png`;
    await writeFile(join(temporary,name),Buffer.from(shot.data,'base64'));
    frames.push({name,time});
    if(await evaluate('!!window.demoDone'))break;
    await wait(Math.max(0,50-(performance.now()-time)));
  }
  if(!await evaluate('!!window.demoDone'))throw Error('Demo did not finish');
  await writeFile(new URL('../assets/streaming-still.png',import.meta.url),await readFile(join(temporary,frames.at(-1).name)));
  const concat=frames.map((frame,i)=>`file '${frame.name}'\nduration ${((frames[i+1]?.time ?? frame.time+50)-frame.time)/1000}`).join('\n')+`\nfile '${frames.at(-1).name}'\n`;
  await writeFile(join(temporary,'frames.txt'),concat);
  const output=fileURLToPath(new URL('../assets/streaming-demo.gif',import.meta.url));
  const ffmpeg=spawn('ffmpeg',['-y','-loglevel','error','-f','concat','-safe','0','-i',join(temporary,'frames.txt'),
    '-filter_complex','fps=20,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a',
    '-loop','0',output],{stdio:'inherit'});
  await new Promise((resolve,reject)=>{ffmpeg.on('error',reject);ffmpeg.on('exit',code=>code===0?resolve():reject(Error(`ffmpeg exited ${code}`)))});
  console.log(JSON.stringify({output,frames:frames.length,durationSeconds:(frames.at(-1).time-start)/1000}));
} finally {
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Recorder stopped'))}
  socket?.close();
  const exited=new Promise(resolve=>chrome.once('exit',resolve));
  chrome.kill();await Promise.race([exited,wait(3000)]);
  await rm(temporary,{recursive:true,force:true});
}
