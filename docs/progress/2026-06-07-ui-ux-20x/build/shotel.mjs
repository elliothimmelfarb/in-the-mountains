import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const URL=process.argv[2], OUT=process.argv[3], SEL=process.argv[4], IDX=+(process.argv[5]||0), PORT=9337;
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--hide-scrollbars","--force-device-scale-factor=1",`--remote-debugging-port=${PORT}`,"--user-data-dir=/tmp/itm-shotel","--window-size=1000,1400",URL],{stdio:"ignore"});
let ws,_id=0;const pending=new Map();
function send(m,p={}){const id=++_id;ws.send(JSON.stringify({id,method:m,params:p}));return new Promise((res,rej)=>{pending.set(id,{res,rej});setTimeout(()=>rej(new Error("to "+m)),30000);});}
async function ev(e){const r=await send("Runtime.evaluate",{expression:e,returnByValue:true});return r.result&&r.result.value;}
async function cdp(){for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json`);const t=await r.json();const pg=t.find(x=>x.type==="page");if(pg&&pg.webSocketDebuggerUrl)return pg.webSocketDebuggerUrl;}catch{}await sleep(300);}throw new Error("no target");}
(async()=>{try{const u=await cdp();ws=new WebSocket(u);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});ws.onmessage=m=>{const x=JSON.parse(m.data);if(x.id&&pending.has(x.id)){const p=pending.get(x.id);pending.delete(x.id);x.error?p.rej(new Error(x.error.message)):p.res(x.result);}};
await send("Page.enable");await send("Runtime.enable");await send("Page.navigate",{url:URL});await sleep(2200);
const rj=await ev(`(()=>{const e=document.querySelectorAll('${SEL}')[${IDX}];if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height});})()`);
if(!rj){console.error("no el");process.exit(1);}const r=JSON.parse(rj);await sleep(300);
const s=await send("Page.captureScreenshot",{format:"png",clip:{x:r.x,y:r.y,width:r.width,height:r.height,scale:2},captureBeyondViewport:true});
writeFileSync(OUT,Buffer.from(s.data,"base64"));console.log("wrote",OUT);
}catch(e){console.error("ERR",e.message);process.exitCode=1;}finally{try{ws&&ws.close();}catch{}chrome.kill("SIGKILL");}})();
