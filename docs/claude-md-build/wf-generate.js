export const meta = {
  name: 'generate-claudemd-candidates',
  description: 'Generate five distinct CLAUDE.md candidates, each a different organizing philosophy',
  phases: [{ title: 'Generate', detail: 'five philosophies drafted in parallel' }],
}

const BASE = '/Users/elliothimmelfarb/code/in-the-mountains-claudemd/docs/claude-md-build'
const CATALOG = `${BASE}/catalog.md`
const BRIEF = `${BASE}/brief.md`
const OWNER = `${BASE}/owner-read.md`

const SPEC = `
=== WHAT YOU ARE WRITING ===
CLAUDE.md — the very FIRST thing every future Claude reads before doing ANY work on this repo. It
silently conditions all downstream work. It must make a fresh Claude do its best work immediately.

It serves TWO jobs at once, fused, not bolted together:
  (A) PERSONALITY / IDENTITY. The reader IS the main Claude orchestrator and OWNER of this project:
      an expert prompt engineer and agent orchestrator who coordinates subagents and workflows using
      every capability available. Not a passive assistant — the owner who sets the bar and reaches
      for fan-out, adversarial verification, and tournaments by default. Confident, warm, a little
      fun (on THIS repo, "have fun" is a literal success criterion the user states repeatedly).
  (B) ORIENTATION. What this repo is, its soul, its architecture-at-a-glance, the verification
      toolchain, the standards and practices — enough that the reader is productive after one read.

=== HARD REQUIREMENTS (every candidate) ===
1. ANTI-STALENESS IS PARAMOUNT. The file must not rot. Therefore:
   - Reference ONLY artifacts confirmed in the ground-truth manifest (real scripts, real commands,
     real doc paths, real debug handles). Never invent a path or command.
   - Prefer durable PRINCIPLES over volatile specifics. Quarantine anything that will change
     (version numbers, file-by-file detail) into a single small, clearly-labeled pointer section,
     or just point to README.md / docs/DESIGN.md instead of duplicating them.
   - Do NOT duplicate what the harness/system prompt already enforces (e.g. commit trailer mechanics
     are enforced; mention the convention once, don't lecture).
2. BAKE THE PROVEN TECHNIQUES IN as standing operating procedure — from the technique catalog. These
   are not suggestions; they are how work is done here (verify-as-a-number, orchestrate-don't-trust-
   yourself, autonomy + a high emotional bar, HTML explainers that teach, one robust mechanism over
   per-case patches, honest residual-imperfection reporting, etc.).
3. SKIMMABLE, SIGNAL-DENSE. Most important things FIRST. A reader skimming the first 30 lines should
   already grasp who they are, what this is, and the non-negotiables. Every line earns its place.
4. LENGTH: tight. Aim ~140-240 lines of dense markdown. A bloated CLAUDE.md gets ignored.
5. VOICE: reflect the user's actual voice (see owner-read + catalog user_voice). Ambitious, direct,
   "make people say did AI really do this", fun as fuel.
6. Decide and state the relationship to AGENTS.md (which holds the critical "this is NOT the Next.js
   you know — read node_modules/next/dist/docs first" caveat). Either @import it or fold its essence
   in, but that caveat MUST survive somewhere visible.

=== OUTPUT ===
Return ONLY the full markdown content of the candidate CLAUDE.md. No preamble, no explanation,
no code fences around the whole thing. Just the file content, ready to save.`

const PHILOSOPHIES = [
  { key: 'opord', label: 'Commander-Intent / OPORD',
    angle: `Structure it like a military operations order (OPORD), which fits this repo's soul perfectly:
      SITUATION (what this repo is + the bar), MISSION (your role as orchestrator-owner), EXECUTION
      (how work is done here — the techniques as SOP, the orchestration doctrine, verification),
      SERVICE & SUPPORT (the toolchain + standards), COMMAND & SIGNAL (how you communicate, report,
      and deliver). Make the milspeak feel native and earned, never costume. Crisp, doctrinal, alive.` },
  { key: 'console', label: 'Orchestrator Operating Manual',
    angle: `Persona-first. Open by casting the reader hard as the orchestrator-owner, then give an
      explicit DECISION PROTOCOL for when to go solo vs. fan out vs. run a tournament, the menu of
      orchestration shapes that work here, and how to scope/verify subagents. The repo orientation is
      the "system you operate." Feels like the cockpit manual for an expert pilot of agent fleets.` },
  { key: 'laws', label: 'Laws + Playbooks',
    angle: `A short canon of non-negotiable LAWS at the top (the irreducible essence), then a set of
      tight PLAYBOOKS (Verification playbook, Orchestration playbook, Delivery/HTML-explainer
      playbook, Bug-hunt playbook). Laws are evergreen; playbooks are concrete moves. Maximum
      actionability — a reader knows exactly what to do in each situation.` },
  { key: 'firstfive', label: 'First Five Minutes (onboarding-optimized)',
    angle: `Optimize for a cold-start Claude. Layered: (1) WHO YOU ARE in two lines, (2) WHAT THIS IS
      in five, (3) THE NON-NEGOTIABLES, (4) THE MAP (where things live + the toolchain), (5) HOW WE
      WORK (techniques as SOP), (6) deeper pointers. Progressive disclosure; anti-staleness via
      pointers not duplication. The fastest path from cold to productive.` },
  { key: 'manifesto', label: 'Minimalist High-Signal Manifesto',
    angle: `Ruthless signal density — the anti-bloat candidate. Every line is load-bearing. Short
      declarative laws, a tiny verified pointer block, nothing decorative. If a line could be cut
      without loss, it's cut. Proves how much can be said in how little. Still must carry identity,
      orientation, technique-SOP, and anti-staleness — just distilled to the bone.` },
]

phase('Generate')
const candidates = await parallel(PHILOSOPHIES.map(p => () =>
  agent(
    `You are an elite prompt engineer authoring a CLAUDE.md. First READ these three files for your raw material:
- Technique catalog (the "quantum DS" — proven prompting techniques distilled from 23 sessions): ${CATALOG}
- Orientation brief + verified ground-truth manifest: ${BRIEF}
- Owner's independent read of the corpus (voice + patterns): ${OWNER}

${SPEC}

=== YOUR ASSIGNED PHILOSOPHY: ${p.label} ===
${p.angle}

Write the strongest possible CLAUDE.md in THIS philosophy. Commit to the philosophy fully — the five
candidates must be genuinely different so a tournament can compare real alternatives.`,
    { label: `candidate:${p.key}`, phase: 'Generate' })
))

return PHILOSOPHIES.map((p, i) => ({ key: p.key, label: p.label, markdown: candidates[i] })).filter(c => c.markdown)
