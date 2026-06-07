// UX AUDIT HARNESS — objective, repeatable UI/UX defect metric for the command UI.
//
// What it metricizes (the "no fix without a number" oracle for UI/UX): it boots the REAL
// running app via CDP (zero deps, like shoot.mjs — never contends with MCP browser), drives
// the store into each major UI STATE (menu · game HUD · village panel · soldier jacket), and
// walks the live rendered DOM in each, computing per-element WCAG/usability DEFECTS:
//
//   contrast    — visible text whose computed colour vs effective background is below WCAG AA
//                 (4.5:1 normal, 3:1 large ≥18.66px-bold / ≥24px). Honours panel gradients.
//   tinyText    — text nodes rendered below 12px (sub-11px bucketed separately — worse).
//   unlabeled   — button/link/input/select with NO accessible name (text|aria-label|title).
//   tinyTarget  — interactive control whose box is < 24px on either axis (pointer ergonomics).
//   noFocusRing — interactive controls with no visible :focus-visible indicator in any sheet.
//   reducedMotion — animated elements live while NO @media(prefers-reduced-motion) block exists.
//
// The composite DEFECT SCORE is the sum across the audited surface; the SAME states are
// captured every run, so before→after is a faithful, deterministic delta (defects are
// seed-independent — the metric reproduces regardless of valley).
//
//   Run:  node scripts/ux-audit.mjs [out.json]   (dev server must be up on :3000)
//   Out:  prints a per-category + per-state table; writes full JSON for the report.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const OUT = process.argv[2] || "docs/progress/ux-audit-latest.json";
// optional: --shots <dir> captures a full-viewport PNG per audited state for the judge panel.
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS_DIR = shotsIdx >= 0 ? process.argv[shotsIdx + 1] : null;
// --demo fires sample toasts before the HUD capture (for the report only — never a scored run)
const DEMO = process.argv.includes("--demo");
const PORT = 9334; // distinct from shoot.mjs's 9333
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const URL = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--force-device-scale-factor=1",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/itm-uxaudit-profile",
  "--window-size=1440,900", URL,
], { stdio: "ignore" });

let ws;
async function cdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const targets = await r.json();
      const page = targets.find((t) => t.type === "page" && t.url.startsWith("http://localhost:3000"));
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("no page target");
}
let _id = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++_id;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => rej(new Error("timeout " + method)), 30000); });
}
async function evalJS(expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description || ""));
  return r.result && r.result.value;
}

// ---- the in-page audit (pure DOM walk; returns a plain object by value) ----------------
// Kept as one self-contained function string so CDP can eval it in the page context.
const AUDIT_FN = `
function __uxAudit(stateName) {
  // --- colour math ---
  function parseColor(c) {
    if (!c) return null;
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(s => parseFloat(s.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(fg, bg) {
    const a = lum(fg), b = lum(bg);
    const hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }
  function blend(fg, bg) { // fg over bg with fg.a
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  const ROOT_BG = { r: 12, g: 13, b: 10, a: 1 }; // body --bg #0c0d0a
  function gradStops(bgImage) {
    if (!bgImage || bgImage === 'none') return [];
    const out = [];
    const re = /rgba?\\([^)]+\\)/g; let m;
    while ((m = re.exec(bgImage)) !== null) { const c = parseColor(m[0]); if (c) out.push(c); }
    return out;
  }
  // effective background candidates by walking ancestors (gradients contribute their stops)
  function bgCandidates(el) {
    const cands = [];
    let node = el;
    for (let i = 0; node && i < 12; i++, node = node.parentElement) {
      const cs = getComputedStyle(node);
      for (const s of gradStops(cs.backgroundImage)) cands.push(s);
      const bc = parseColor(cs.backgroundColor);
      if (bc && bc.a > 0.001) { cands.push(bc.a >= 0.999 ? bc : blend(bc, ROOT_BG)); if (bc.a >= 0.999) break; }
    }
    cands.push(ROOT_BG);
    return cands;
  }
  function accessibleName(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) { const t = document.getElementById(labelledby); if (t && t.textContent.trim()) return t.textContent.trim(); }
    const title = (el.getAttribute('title') || '').trim();
    if (title) return title;
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (txt) return txt;
    if (el.tagName === 'INPUT') {
      const id = el.id; if (id) { const lab = document.querySelector('label[for="' + id + '"]'); if (lab && lab.textContent.trim()) return lab.textContent.trim(); }
      const wrap = el.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
      const ph = (el.getAttribute('placeholder') || '').trim(); if (ph) return ph;
    }
    const ti = el.querySelector('[aria-label],[title]');
    if (ti) return (ti.getAttribute('aria-label') || ti.getAttribute('title') || '').trim();
    return '';
  }
  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // --- stylesheet-level facts (focus ring + reduced motion support) ---
  let hasFocusVisibleRule = false, hasReducedMotionBlock = false;
  try {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        const t = rule.cssText || '';
        if (/:focus-visible/.test(t) && /(outline|box-shadow|border)/.test(t)) hasFocusVisibleRule = true;
        if (rule.media && /prefers-reduced-motion/.test(rule.conditionText || '')) hasReducedMotionBlock = true;
        if (/@media[^{]*prefers-reduced-motion/.test(t)) hasReducedMotionBlock = true;
      }
    }
  } catch {}

  const defects = { contrast: 0, tinyText: 0, subEleven: 0, unlabeled: 0, tinyTarget: 0, noFocusRing: 0, reducedMotion: 0 };
  const samples = { contrast: [], tinyText: [], unlabeled: [], tinyTarget: [] };
  const seenText = new Set();

  // text-bearing leaf detection: an element with direct (non-whitespace) text
  const all = Array.from(document.querySelectorAll('body *'));
  let textNodes = 0, interactives = 0, animated = 0;

  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const tag = el.tagName;

    // animations live? (for reduced-motion accounting)
    if ((cs.animationName && cs.animationName !== 'none') || (cs.transitionDuration && parseFloat(cs.transitionDuration) > 0 && /(transform|opacity)/.test(cs.transitionProperty))) {
      if (cs.animationName && cs.animationName !== 'none') animated++;
    }

    // direct text content (ignore children's text)
    let direct = '';
    for (const n of el.childNodes) if (n.nodeType === 3) direct += n.textContent;
    direct = direct.replace(/\\s+/g, ' ').trim();

    if (direct) {
      textNodes++;
      const fs = parseFloat(cs.fontSize);
      const fg0 = parseColor(cs.color) || { r: 216, g: 214, b: 196, a: 1 };
      const fg = fg0.a < 0.999 ? blend(fg0, bgCandidates(el)[0] || ROOT_BG) : fg0;
      // worst-case contrast across bg candidates
      let minC = 99;
      for (const bg of bgCandidates(el)) { const c = contrast(fg, bg); if (c < minC) minC = c; }
      const bold = (parseInt(cs.fontWeight) || 400) >= 700;
      const large = fs >= 24 || (fs >= 18.66 && bold);
      const need = large ? 3.0 : 4.5;
      const key = stateName + '|' + (el.className || tag) + '|' + direct.slice(0, 18);
      if (minC + 0.05 < need && !seenText.has('c' + key)) {
        seenText.add('c' + key);
        defects.contrast++;
        if (samples.contrast.length < 14) samples.contrast.push({ text: direct.slice(0, 40), ratio: +minC.toFixed(2), need, fs: +fs.toFixed(1), color: cs.color, cls: (el.className || tag).toString().slice(0, 40) });
      }
      if (fs < 12 && !seenText.has('t' + key)) {
        seenText.add('t' + key);
        defects.tinyText++;
        if (fs < 11) defects.subEleven++;
        if (samples.tinyText.length < 14) samples.tinyText.push({ text: direct.slice(0, 40), fs: +fs.toFixed(1), cls: (el.className || tag).toString().slice(0, 40) });
      }
    }

    // interactive controls
    const role = el.getAttribute('role');
    const isInteractive = tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA' || role === 'button' || role === 'separator';
    if (isInteractive) {
      interactives++;
      const r = el.getBoundingClientRect();
      const name = accessibleName(el);
      const isText = tag === 'A' && cs.display.includes('inline');
      if (!name && tag !== 'INPUT') {
        defects.unlabeled++;
        if (samples.unlabeled.length < 14) samples.unlabeled.push({ tag, cls: (el.className || '').toString().slice(0, 40), state: stateName });
      } else if (!name && tag === 'INPUT' && el.type !== 'hidden') {
        defects.unlabeled++;
        if (samples.unlabeled.length < 14) samples.unlabeled.push({ tag: 'INPUT:' + el.type, cls: (el.className || '').toString().slice(0, 40), state: stateName });
      }
      if (!isText && r.width > 0 && (r.width < 24 || r.height < 24) && role !== 'separator') {
        defects.tinyTarget++;
        if (samples.tinyTarget.length < 14) samples.tinyTarget.push({ tag, w: Math.round(r.width), h: Math.round(r.height), name: name.slice(0, 24), state: stateName });
      }
      if (!hasFocusVisibleRule) defects.noFocusRing++;
    }
  }

  if (!hasReducedMotionBlock) defects.reducedMotion = animated;

  // DIAGNOSTIC (not scored): horizontal overflow / text clipping. Catches the
  // exact failure mode a font-size bump risks — content wider than its clipped
  // box. Reported separately so it never perturbs the before/after defect ruler.
  let overflowClipped = 0; const overflowSamples = [];
  for (const el of all) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const clips = cs.overflowX === 'hidden' || cs.overflowX === 'clip' || cs.textOverflow === 'ellipsis';
    if (!clips) continue;
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      // ignore intentionally-truncated single-line labels (.truncate) — those are by-design ellipsis
      const byDesign = el.classList.contains('truncate');
      if (!byDesign) {
        overflowClipped++;
        if (overflowSamples.length < 12) overflowSamples.push({ cls: (el.className||tag).toString().slice(0,44), sw: el.scrollWidth, cw: el.clientWidth, txt: (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30) });
      }
    }
  }

  const total = defects.contrast + defects.tinyText + defects.unlabeled + defects.tinyTarget + defects.noFocusRing + defects.reducedMotion;
  return { state: stateName, defects, total, counts: { textNodes, interactives, animated }, flags: { hasFocusVisibleRule, hasReducedMotionBlock }, diagnostics: { overflowClipped, overflowSamples }, samples };
}
window.__uxAudit = __uxAudit;
'ready'`;

// drive the store to a state, settle, then audit + return result
async function auditState(name, setupExpr) {
  await evalJS(setupExpr, true);
  await sleep(550);
  const res = await evalJS(`__uxAudit(${JSON.stringify(name)})`, false);
  if (SHOTS_DIR) {
    try {
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(`${SHOTS_DIR}/${name}.png`, Buffer.from(shot.data, "base64"));
      // hi-detail 2x crops of the two dense strips (CommandBar top + OrderBar bottom)
      if (name === "hud") {
        for (const [sel, tag] of [[".panel.h-12, .panel.border-x-0", "commandbar"], [".contact-accent", "orderbar"], ['[class~="w-[344px]"]', "rightcol"]]) {
          const rj = await evalJS(`(()=>{const e=document.querySelector('${sel}');if(!e)return null;const r=e.getBoundingClientRect();return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height});})()`);
          if (!rj) continue;
          const r = JSON.parse(rj);
          const c = await send("Page.captureScreenshot", { format: "png", clip: { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 }, captureBeyondViewport: true });
          writeFileSync(`${SHOTS_DIR}/${tag}.png`, Buffer.from(c.data, "base64"));
        }
      }
    } catch (e) { console.error("shot fail", name, e.message); }
  }
  return res;
}

(async () => {
  try {
    const url = await cdp();
    ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
    };
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url: URL });
    await sleep(1500);
    let ready = false;
    for (let i = 0; i < 120; i++) { if (await evalJS("!!(window.__ITM && window.__ITM.getState)")) { ready = true; break; } await sleep(300); }
    if (!ready) {
      const diag = await evalJS("JSON.stringify({title:document.title,rs:document.readyState,itm:typeof window.__ITM,body:document.body?document.body.innerText.slice(0,120):'no-body'})");
      throw new Error("__ITM never appeared. diag=" + diag);
    }
    await evalJS(AUDIT_FN);

    const states = [];
    // 1) MENU — initial screen
    await evalJS(`window.__ITM.getState().gotoMenu && window.__ITM.getState().gotoMenu()`, false).catch(()=>{});
    await sleep(300);
    states.push(await auditState("menu", `'menu'`));

    // 2) GAME HUD — boot a deterministic campaign, wait for the deploy screen, select a squad
    await evalJS(`window.__ITM.getState().newCampaign('ux-audit', 120)`, true);
    for (let i = 0; i < 120; i++) { const s = await evalJS(`(window.__ITM.getState().screen)`); if (s === 'deploy' && await evalJS(`!!window.__ITM.getState().world`)) break; await sleep(120); }
    await sleep(400);
    if (DEMO) {
      await evalJS(`(()=>{const st=window.__ITM.getState();st.pushToast('CERP approved — clinic at Darbart ($5k). Secure the site.','good');st.pushToast('1st Squad — stepping off','info');st.pushToast('▲ CONTACT — 2nd Squad taking fire vicinity Saret','crit');return 'ok'})()`);
    }
    states.push(await auditState("hud", `(()=>{const st=window.__ITM.getState();const sq=st.world.platoon.squads[1];if(sq)st.selectSquad(sq.id);return 'hud'})()`));

    // 3) VILLAGE PANEL — open the first village
    states.push(await auditState("village", `(()=>{const st=window.__ITM.getState();const v=st.world.state.villages[0];if(v){st.selectSquad(st.world.platoon.squads[1].id);st.selectVillage(v.id);}return 'village'})()`));

    // 4) SOLDIER JACKET — open a service record modal
    states.push(await auditState("jacket", `(()=>{const st=window.__ITM.getState();const m=st.world.platoon.members[0];if(m)st.setJacket(m.id);return 'jacket'})()`));

    // optional: capture the Help overlay for the report
    if (SHOTS_DIR && DEMO) {
      await evalJS(`window.__ITM.getState().toggleHelp(true)`);
      await sleep(500);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(`${SHOTS_DIR}/help.png`, Buffer.from(shot.data, "base64"));
      await evalJS(`window.__ITM.getState().toggleHelp(false)`);
    }

    // ---- aggregate ----
    const cats = ["contrast", "tinyText", "subEleven", "unlabeled", "tinyTarget", "noFocusRing", "reducedMotion"];
    const totals = Object.fromEntries(cats.map((c) => [c, 0]));
    let grand = 0;
    for (const s of states) { for (const c of cats) totals[c] += s.defects[c] || 0; grand += s.total; }

    const report = { ts: new Date().toISOString(), grandTotal: grand, totalsByCategory: totals, states, flags: states[0]?.flags };
    writeFileSync(OUT, JSON.stringify(report, null, 2));

    // pretty print
    console.log("\\n=== UX AUDIT ===");
    console.log("flags:", JSON.stringify(states.find(s=>s.state==='hud')?.flags));
    console.log("\\nstate      total  contrast tiny <11  unlbl target focus rmotion");
    for (const s of states) {
      const d = s.defects;
      console.log(
        s.state.padEnd(10),
        String(s.total).padStart(5),
        String(d.contrast).padStart(8), String(d.tinyText).padStart(4), String(d.subEleven).padStart(4),
        String(d.unlabeled).padStart(5), String(d.tinyTarget).padStart(6), String(d.noFocusRing).padStart(5), String(d.reducedMotion).padStart(7),
      );
    }
    console.log("-".repeat(64));
    console.log("TOTAL".padEnd(10), String(grand).padStart(5),
      String(totals.contrast).padStart(8), String(totals.tinyText).padStart(4), String(totals.subEleven).padStart(4),
      String(totals.unlabeled).padStart(5), String(totals.tinyTarget).padStart(6), String(totals.noFocusRing).padStart(5), String(totals.reducedMotion).padStart(7));
    console.log("\\nGRAND TOTAL DEFECTS:", grand);
    console.log("wrote", OUT);
  } catch (e) {
    console.error("ERROR", e.message, e.stack);
    process.exitCode = 1;
  } finally {
    try { ws && ws.close(); } catch {}
    chrome.kill("SIGKILL");
  }
})();
