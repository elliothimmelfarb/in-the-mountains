export const meta = {
  name: 'claudemd-tournament',
  description: 'Adversarially review + judge 5 CLAUDE.md candidates, synthesize a champion, red-team the final',
  phases: [
    { title: 'Adversarial', detail: 'one skeptic attacks each candidate' },
    { title: 'Judge', detail: '3 judges score all candidates comparatively' },
    { title: 'Synthesize', detail: 'build the champion from the winner + best grafts' },
    { title: 'RedTeam', detail: 'attack the final, verify ground-truth, polish' },
  ],
}

const BASE = '/Users/elliothimmelfarb/code/in-the-mountains-claudemd/docs/claude-md-build'
const CATALOG = `${BASE}/catalog.md`
const BRIEF = `${BASE}/brief.md`
const OWNER = `${BASE}/owner-read.md`
const KEYS = ['opord', 'console', 'laws', 'firstfive', 'manifesto']
const candPath = k => `${BASE}/candidates/cand-${k}.md`

const RUBRIC = `Rubric dimensions (score each 1-10):
- identity: casts the reader as the orchestrator-owner (expert prompt engineer + agent orchestrator) vividly and usefully.
- orientation: a fresh Claude is productive after one read — knows what the repo is, where things live, the toolchain.
- technique_sop: the proven catalog techniques are baked in as standing procedure, not vague platitudes.
- anti_staleness: references only real/verified artifacts; durable principles; volatile detail quarantined or pointed-to; won't rot.
- signal_density: skimmable, most-important-first, every line earns its place, not bloated.
- voice_fun: reflects the user's ambitious, direct voice; "fun" is alive; not corporate.
- actionability: a reader knows exactly what to DO in concrete situations.`

const ADV = {
  type: 'object', additionalProperties: false,
  properties: {
    candidate: { type: 'string' },
    staleness_traps: { type: 'array', items: { type: 'string' }, description: 'specific lines/claims that will rot or reference things that may not exist' },
    vague_or_unactionable: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' }, description: 'internal contradictions, OR duplication of what the system/AGENTS.md already enforce, OR conflicts with repo reality' },
    would_mislead: { type: 'array', items: { type: 'string' }, description: 'things that would lead a fresh Claude astray' },
    missing_essence: { type: 'array', items: { type: 'string' }, description: 'catalog essence/technique that should be present but is not' },
    best_elements: { type: 'array', items: { type: 'string' }, description: 'genuinely strong, graft-worthy bits' },
    verdict: { type: 'string' },
  },
  required: ['candidate', 'staleness_traps', 'vague_or_unactionable', 'contradictions', 'would_mislead', 'missing_essence', 'best_elements', 'verdict'],
}

const JUDGE = {
  type: 'object', additionalProperties: false,
  properties: {
    rankings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          candidate: { type: 'string' },
          identity: { type: 'number' }, orientation: { type: 'number' }, technique_sop: { type: 'number' },
          anti_staleness: { type: 'number' }, signal_density: { type: 'number' }, voice_fun: { type: 'number' }, actionability: { type: 'number' },
          total: { type: 'number' }, note: { type: 'string' },
        },
        required: ['candidate', 'identity', 'orientation', 'technique_sop', 'anti_staleness', 'signal_density', 'voice_fun', 'actionability', 'total', 'note'],
      },
    },
    winner: { type: 'string' }, best_skeleton: { type: 'string' }, must_graft: { type: 'array', items: { type: 'string' } },
  },
  required: ['rankings', 'winner', 'best_skeleton', 'must_graft'],
}

const GROUND = `Anchor everything in these files (READ them): catalog ${CATALOG}; orientation+manifest ${BRIEF}; owner read ${OWNER}. The candidate CLAUDE.md files are at ${BASE}/candidates/cand-<key>.md for keys: ${KEYS.join(', ')}.`

phase('Adversarial')
const adversarial = await parallel(KEYS.map(k => () =>
  agent(`You are a ruthless adversarial reviewer of a CLAUDE.md candidate. ${GROUND}\n\nAttack candidate "${k}" (read ${candPath(k)}). Your job is to find every way it would FAIL its purpose — go stale, mislead a fresh Claude, waste a line, duplicate what's already enforced, or miss a proven technique. Also note its genuinely best elements (for grafting). Be specific and quote lines. Default to skeptical.`,
    { label: `adv:${k}`, phase: 'Adversarial', schema: ADV })
))

phase('Judge')
const judges = await parallel([1, 2, 3].map(n =>
  () => agent(`You are judge #${n} in a panel selecting the best CLAUDE.md. ${GROUND}\n\nRead ALL FIVE candidates (${KEYS.map(candPath).join(', ')}) and score each comparatively.\n\n${RUBRIC}\n\nReturn scores for all five, your overall winner, which candidate has the best SKELETON to build on, and the must-graft elements from the others. Judge by what would actually make a fresh Claude do its best work — not by prettiness.`,
    { label: `judge:${n}`, phase: 'Judge', schema: JUDGE })
)).then(r => r.filter(Boolean))

// Tally judge totals per candidate
const tally = {}
for (const j of judges) for (const r of (j.rankings || [])) tally[r.candidate] = (tally[r.candidate] || 0) + (r.total || 0)
log(`Judge tally: ${JSON.stringify(tally)} | winners: ${judges.map(j => j.winner).join(', ')}`)

phase('Synthesize')
const champion = await agent(
  `You are the SYNTHESIS LEAD producing the FINAL CLAUDE.md for this repo. ${GROUND}\n\n` +
  `You have five candidate drafts, adversarial findings on each, and a 3-judge panel's comparative scores. ` +
  `Build the single best possible CLAUDE.md: start from the strongest skeleton, GRAFT the best elements ` +
  `from the others, and FIX every legitimate adversarial finding (staleness traps, vagueness, ` +
  `duplication, misleads, missing techniques).\n\n` +
  `It must fuse PERSONALITY (the reader is the orchestrator-owner: expert prompt engineer + agent ` +
  `orchestrator) with ORIENTATION (what the repo is, the toolchain, standards), bake the catalog ` +
  `techniques in as standing procedure, be skimmable and signal-dense (~140-240 lines), reflect the ` +
  `user's ambitious + fun voice, preserve the "this is NOT the Next.js you know" caveat, and reference ` +
  `ONLY verified ground-truth artifacts.\n\n` +
  `JUDGE PANEL (JSON): ${JSON.stringify(judges)}\n\nADVERSARIAL FINDINGS (JSON): ${JSON.stringify(adversarial.filter(Boolean))}\n\n` +
  `Output ONLY the final CLAUDE.md markdown content, ready to save. No preamble, no fences.`,
  { label: 'synthesize-champion', phase: 'Synthesize' })

phase('RedTeam')
const redteam = await agent(
  `You are the FINAL RED TEAM + polisher for this CLAUDE.md. ${GROUND}\n\n` +
  `Here is the synthesized final draft. Do three things:\n` +
  `1) VERIFY GROUND TRUTH: for every file path, script, and command the draft references, confirm it ` +
  `actually exists by running Bash (ls/test/grep) against the repo at /Users/elliothimmelfarb/code/in-the-mountains. ` +
  `Remove or correct anything unverifiable.\n` +
  `2) RED-TEAM: find any remaining staleness trap, vague directive, contradiction, or bloat.\n` +
  `3) POLISH: fix all of the above and tighten. Keep it skimmable, ~140-240 lines, identity + ` +
  `orientation + technique-SOP + anti-staleness all intact, voice ambitious and a little fun.\n\n` +
  `DRAFT (markdown):\n${champion}\n\nOutput ONLY the final, verified, polished CLAUDE.md markdown. No preamble, no fences.`,
  { label: 'redteam-polish', phase: 'RedTeam' })

return { tally, judges, adversarial: adversarial.filter(Boolean), champion_len: (champion || '').length, final_markdown: redteam }
