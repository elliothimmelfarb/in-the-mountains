/**
 * AUTONOMY + SOP-RESPONSE HARNESS
 *
 * The squad-command overhaul makes combat 100% AI ("The Watch"): the player gives a
 * squad waypoints + an SOP (movement / on-contact drill / ROE) and never touches a
 * trigger. This harness PROVES, with numbers across seeds, two things:
 *   1. AUTONOMY — a squad with ZERO player orders fights competently: it gets into
 *      cover, sets a base of fire, maneuvers/holds/breaks per its SOP, and survives.
 *   2. SOP RESPONSE — the three SOP dials actually change the fight (assault closes &
 *      kills more at higher cost; break preserves men & cedes ground; ROE hold/tight
 *      fires far less and protects civilians; free trades civcas risk for lethality).
 *
 * Run:  npx tsx scripts/autonomy.ts            (full matrix)
 *       npx tsx scripts/autonomy.ts 12 22      (SEEDS MINUTES)
 *
 * Per CLAUDE.md: capture a baseline, then re-measure after each AI change.
 */
import { createWorld } from "../lib/sim/world";
import { SquadSOP, MovementSOP, ContactSOP } from "../lib/sim/world/types";
import { ROE } from "../lib/sim/entities";

const argv = process.argv.slice(2);
const SEEDS = Number(argv[0] ?? 14);
const MINUTES = Number(argv[1] ?? 22);
const HEAT = 0.75;

interface Metrics {
  contacts: number; // seeds that saw contact
  usKIA: number;
  usSeriousWIA: number; // unconscious / hp<40 / bleeding
  usWalkingWIA: number;
  enemyKIA: number;
  civCas: number;
  restraint: number; // total ROE hold-fire events (civ in kill zone)
  rounds: number;
  // squad-combat behavior, sampled while in contact:
  coverFrac: number; // fraction of in-contact man-samples in cover (coverAt>0.3)
  bofFrac: number; // fraction of in-contact samples where a base of fire was up (>=1 auto on suppress)
  stateAssault: number; // fraction of in-contact time the squad was assaulting
  stateBreak: number; // fraction breaking contact
  stateHoldSup: number; // fraction holding / suppressing
  brokeWhenMauled: number; // seeds where squad entered break-contact
  gotHome: number; // seeds where the patrol task completed (returned/finished) or >=60% survived inside wire
}

function blank(): Metrics {
  return { contacts: 0, usKIA: 0, usSeriousWIA: 0, usWalkingWIA: 0, enemyKIA: 0, civCas: 0, restraint: 0, rounds: 0,
    coverFrac: 0, bofFrac: 0, stateAssault: 0, stateBreak: 0, stateHoldSup: 0, brokeWhenMauled: 0, gotHome: 0 };
}

const AUTO = new Set(["saw_gunner", "auto_rifleman", "machinegunner"]);

function runScenario(seed: string, sop: SquadSOP): Metrics {
  const world = createWorld(seed, 90);
  const { terrain, state, sim } = world;
  state.enemyHeat = HEAT;
  const cop = terrain.copCell;
  const v = terrain.villages[Math.abs(hash(seed)) % terrain.villages.length];
  const sq = world.platoon.squads.find((sd) => sd.id === "sq1")!;
  const medic = world.platoon.members.find((m) => m.role === "medic");
  const ids = [...sq.memberIds, ...(medic ? [medic.id] : [])];
  const task = world.formPatrol(
    ids,
    [{ cx: Math.round((cop.cx + v.cx) / 2), cy: Math.round((cop.cy + v.cy) / 2) }, { cx: v.cx, cy: v.cy }],
    "presence",
    "tactical",
    sop
  );
  state.nextActivityAt = 0;

  const m = blank();
  let sawContact = false;
  let inContactSamples = 0, coverHits = 0, bofHits = 0;
  let stAssault = 0, stBreak = 0, stHoldSup = 0, stateSamples = 0;
  let entriedBreak = false;
  const ammo0 = sim.ammoExpended;

  const ticks = MINUTES * 600;
  for (let t = 0; t < ticks && !state.ended; t++) {
    world.tick(0.1);
    const contact = world.inContact();
    if (contact) sawContact = true;

    // behavior sampling every 1 s while the squad's task is in a combat state
    if (t % 10 === 0 && task && task.squadState) {
      stateSamples++;
      if (task.squadState === "assault") stAssault++;
      else if (task.squadState === "break") stBreak++;
      else if (task.squadState === "hold" || task.squadState === "suppress") stHoldSup++;
      if (task.squadState === "break") entriedBreak = true;

      let autoSuppressing = false;
      for (const id of ids) {
        const u = sim.unit(id);
        if (!u || !u.alive || !u.conscious) continue;
        inContactSamples++;
        // "protected" = behind terrain cover OR hitting the dirt prone (both cut exposure)
        if (terrain.coverAt(u.pos.x, u.pos.y) > 0.3 || u.stance === "prone") coverHits++;
        if (AUTO.has(u.role) && u.rof === "suppress") autoSuppressing = true;
      }
      if (autoSuppressing) bofHits++;
    }
  }

  // tally
  if (sawContact) m.contacts = 1;
  m.usKIA = world.platoon.members.filter((p) => ids.includes(p.id) && !p.alive).length;
  m.usSeriousWIA = world.platoon.members.filter((p) => ids.includes(p.id) && p.alive && (!p.conscious || p.hp < 40 || p.bleedRate > 0.3)).length;
  m.usWalkingWIA = world.platoon.members.filter((p) => ids.includes(p.id) && p.alive && p.conscious && p.hp >= 40 && p.bleedRate <= 0.3 && p.wounds.length > 0).length;
  m.enemyKIA = world.platoon.members.filter((p) => ids.includes(p.id)).reduce((a, p) => a + p.kills, 0);
  m.civCas = sim.units.filter((u) => u.faction === "civilian" && u.casualtyByFaction && (u.casualtyByFaction === "us" || u.casualtyByFaction === "ana") && (!u.alive || u.wounds.length > 0)).length;
  // restraint: count is consumed by the World each tick, so read the cumulative attitude proxy instead:
  m.restraint = restraintProxy(world, v.id);
  m.rounds = sim.ammoExpended - ammo0;
  m.coverFrac = inContactSamples ? coverHits / inContactSamples : 0;
  m.bofFrac = stateSamples ? bofHits / stateSamples : 0;
  m.stateAssault = stateSamples ? stAssault / stateSamples : 0;
  m.stateBreak = stateSamples ? stBreak / stateSamples : 0;
  m.stateHoldSup = stateSamples ? stHoldSup / stateSamples : 0;
  m.brokeWhenMauled = entriedBreak ? 1 : 0;
  // got home: the task completed (returned), or a majority are alive & inside the wire
  const center = world.copWorld();
  const alive = world.platoon.members.filter((p) => ids.includes(p.id) && p.alive);
  const inside = alive.filter((p) => Math.hypot(p.pos.x - center.x, p.pos.y - center.y) < terrain.cop.radius * terrain.cellSize + 20).length;
  const taskGone = !state.tasks.some((tk) => tk.id === task?.id);
  m.gotHome = taskGone || inside >= Math.ceil(ids.length * 0.6) ? 1 : 0;
  return m;
}

// We can't read per-tick restraint events post-hoc (the World drains them); use the
// village attitude lift above its created baseline as a coarse proxy for restraint+presence.
function restraintProxy(world: ReturnType<typeof createWorld>, villageId: string): number {
  const v = world.state.villages.find((x) => x.id === villageId);
  return v ? Math.round(v.cooperation * 10) / 10 : 0;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function aggregate(label: string, sop: SquadSOP): Metrics {
  const agg = blank();
  for (let s = 0; s < SEEDS; s++) {
    const m = runScenario(`auto-${label}-${s}`, sop);
    agg.contacts += m.contacts;
    agg.usKIA += m.usKIA;
    agg.usSeriousWIA += m.usSeriousWIA;
    agg.usWalkingWIA += m.usWalkingWIA;
    agg.enemyKIA += m.enemyKIA;
    agg.civCas += m.civCas;
    agg.restraint += m.restraint;
    agg.rounds += m.rounds;
    agg.coverFrac += m.coverFrac;
    agg.bofFrac += m.bofFrac;
    agg.stateAssault += m.stateAssault;
    agg.stateBreak += m.stateBreak;
    agg.stateHoldSup += m.stateHoldSup;
    agg.brokeWhenMauled += m.brokeWhenMauled;
    agg.gotHome += m.gotHome;
  }
  return agg;
}

function row(label: string, sop: SquadSOP): void {
  const a = aggregate(label, sop);
  const n = SEEDS;
  const lossRatio = (a.usKIA + a.usSeriousWIA) > 0 ? (a.enemyKIA / (a.usKIA + a.usSeriousWIA)).toFixed(1) : "∞";
  console.log(
    `${label.padEnd(22)} ` +
    `KIA ${(a.usKIA / n).toFixed(2)}  sWIA ${(a.usSeriousWIA / n).toFixed(2)}  ` +
    `enKIA ${(a.enemyKIA / n).toFixed(2)}  K/L ${lossRatio.padStart(4)}  ` +
    `civ ${(a.civCas / n).toFixed(2)}  ` +
    `prot ${(100 * a.coverFrac / n).toFixed(0)}%  bof ${(100 * a.bofFrac / n).toFixed(0)}%  ` +
    `[aslt ${(100 * a.stateAssault / n).toFixed(0)} brk ${(100 * a.stateBreak / n).toFixed(0)} hold ${(100 * a.stateHoldSup / n).toFixed(0)}]  ` +
    `home ${a.gotHome}/${n}  rnds ${(a.rounds / n).toFixed(0)}`
  );
}

const SOP = (movement: MovementSOP, contact: ContactSOP, roe: ROE): SquadSOP => ({ movement, contact, roe });

console.log(`\n=== AUTONOMY + SOP RESPONSE (${SEEDS} seeds × ${MINUTES} game-min, sq1+medic, heat ${HEAT}, ZERO player orders) ===`);
console.log(`legend: KIA/sWIA/enKIA per patrol · K/L kill:loss · cover=% in cover in contact · bof=% time base-of-fire up · [state mix] · home=returned/survived\n`);
console.log("--- ON-CONTACT SOP (roe tight, patrol movement) ---");
row("hold+return", SOP("patrol", "hold", "tight"));
row("suppress+fires", SOP("patrol", "suppress", "tight"));
row("assault", SOP("patrol", "assault", "tight"));
row("break-contact", SOP("patrol", "break", "tight"));
console.log("\n--- ROE (hold-&-return contact drill) ---");
row("roe:hold", SOP("patrol", "hold", "hold"));
row("roe:tight", SOP("patrol", "hold", "tight"));
row("roe:free", SOP("patrol", "hold", "free"));
console.log("\n--- MOVEMENT SOP (hold contact, tight) ---");
row("move:stealth", SOP("stealth", "hold", "tight"));
row("move:patrol", SOP("patrol", "hold", "tight"));
row("move:fast", SOP("fast", "hold", "tight"));
console.log("");
