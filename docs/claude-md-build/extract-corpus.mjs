// Extract a clean, mineable corpus from Claude Code transcripts.
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.HOME + '/.claude/projects/-Users-elliothimmelfarb-code-in-the-mountains';
const OUT = path.resolve(process.argv[2] || './corpus');
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl'))
  .map(f => path.join(DIR, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

const NOISE = [/^\[Request interrupted/, /^<bash-input>/, /^<bash-stdout>/];
function clean(s) {
  if (typeof s !== 'string') return '';
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  const hook = s.match(/Stop hook is now active with condition:\s*"([\s\S]*?)"\.\s*Briefly acknowledge/);
  if (hook) s = '[GOAL/INTENT] ' + hook[1];
  return s.trim();
}
function isNoise(s) {
  if (s.length === 0) return true;
  if (NOISE.some(r => r.test(s))) return true;
  if (/^This session is being continued from a previous conversation/.test(s)) return true;
  return false;
}

const userMsgs = [], orchestration = [], framing = [];
let sessionIdx = 0;
const seenGoal = new Set();

for (const file of files) {
  sessionIdx++;
  const sid = `S${String(sessionIdx).padStart(2,'0')}`;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || '';
    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      let text = '';
      if (typeof c === 'string') text = clean(c);
      else if (Array.isArray(c)) {
        const hasToolResult = c.some(b => b && b.type === 'tool_result');
        if (!hasToolResult) text = c.filter(b => b && b.type === 'text').map(b => clean(b.text)).join('\n').trim();
      }
      if (text && !isNoise(text)) {
        const key = sid + '|' + text.slice(0, 200);
        if (text.startsWith('[GOAL/INTENT]') && seenGoal.has(key)) continue;
        if (text.startsWith('[GOAL/INTENT]')) seenGoal.add(key);
        userMsgs.push({ sid, ts, text });
      }
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (b.type !== 'tool_use') continue;
        const inp = b.input || {};
        if (/Workflow|Agent/i.test(b.name)) {
          const text = inp.script || inp.prompt || '';
          if (text) orchestration.push({ sid, ts, tool: b.name, label: inp.description || (inp.subagent_type||''), text: clean(String(text)) });
        } else if (b.name === 'TaskCreate') {
          const text = inp.description ? `${inp.subject||''} :: ${inp.description}` : JSON.stringify(inp);
          framing.push({ sid, ts, tool: b.name, text: clean(text) });
        }
      }
    }
  }
}

const write = (file, header, arr, fmt) => {
  let out = header + '\n';
  for (const m of arr) out += fmt(m);
  fs.writeFileSync(path.join(OUT, file), out);
  return (fs.statSync(path.join(OUT, file)).size/1024).toFixed(0);
};

const us = write('user-prompts.md', `# USER PROMPT CORPUS — ${userMsgs.length} human-typed messages across ${sessionIdx} sessions`,
  userMsgs, m => `\n===== [${m.sid}] ${m.ts} =====\n${m.text}\n`);
const os = write('self-orchestration.md', `# SELF-AUTHORED ORCHESTRATION CORPUS — ${orchestration.length} Workflow/Agent prompts (how Claude fans out work)`,
  orchestration, m => `\n===== [${m.sid}] ${m.tool} — ${m.label} =====\n${m.text}\n`);
const fs2 = write('self-framing.md', `# SELF-AUTHORED WORK-FRAMING CORPUS — ${framing.length} TaskCreate decompositions (how Claude breaks down work)`,
  framing, m => `\n----- [${m.sid}] -----\n${m.text}\n`);

console.log(`sessions: ${sessionIdx}`);
console.log(`user-prompts.md:        ${userMsgs.length} msgs  ${us} KB`);
console.log(`self-orchestration.md:  ${orchestration.length} prompts  ${os} KB`);
console.log(`self-framing.md:        ${framing.length} tasks  ${fs2} KB`);
