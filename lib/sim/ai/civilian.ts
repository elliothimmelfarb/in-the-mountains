import type { CombatSim } from "../combat";
import { Unit } from "../entities";
import { dist, sub, norm, add, scale, len, dot, fromAngle } from "../vec";
import { clamp01, lerp, RNG } from "../rng";

/**
 * Civilian behavior. Unarmed. The valley is meant to read as LIVED-IN: villagers
 * amble their pattern of life at their own pace, stop to work and talk, and — as a
 * patrol comes near — react the way real people do, in GRADUATED tiers rather than a
 * single calm↔sprint switch:
 *
 *   OBLIVIOUS  no armed men close — go about the day (per-person pace, dwell, idle drift).
 *   WARY       armed men in the middle distance — stop, watch them, give a beat.
 *   CLEAR-ROAD a patrol bears down close — step off its line to the field edge and let it
 *              pass (children, curious, may instead drift IN for a look; elders withdraw home).
 *   FLEE       gunfire, a blast, or armed men right on top of them — bolt for home/dead ground.
 *
 * The tier rises the instant a threat appears and falls back one step at a time, so a
 * villager doesn't flip-flop. Their sudden absence is still the oldest tell in the valley.
 *
 * Every per-person trait (pace, dwell, curiosity, idle phase) is derived from a PURE hash
 * of the unit id — no per-tick randomness — so the headless sim stays bit-for-bit
 * reproducible across replays. The one O(units) scan the brain already did for gunfire
 * fear is reused to also find the nearest armed man and count the armed nearby; no second pass.
 */

const ARMED = new Set(["us", "ana", "insurgent"]);

/** Stable per-civ trait in [0,1) from the id (advances no RNG stream). */
function trait(id: string, salt: string): number {
  return (RNG.hashString(id + salt) % 100000) / 100000;
}

export function civilianBrain(sim: CombatSim, u: Unit, dt: number) {
  if (!u.conscious) {
    u.moving = false;
    u.path = [];
    return;
  }
  u.panic = u.panic ?? 0;
  const isChild = u.role === "child";
  const isElder = u.role === "elder";

  // --- village context, pushed by the World each tick (empty for a standalone sim) ---
  // mood: the village's attitude (−1..1). reception: how fast THIS village relaxes
  // around armed men (presence/standing thaw it; absence and unresolved blood debts
  // chill it — rise logic untouched). grieving: this man's household has an unpaid
  // grievance — they clear the road from troops, always, and their children never trail.
  const mood = (u.villageId ? sim.villageMood.get(u.villageId) : undefined) ?? 0;
  const reception = (u.villageId ? sim.villageReception.get(u.villageId) : undefined) ?? 0.5;
  const grieving = !!u.householdId && sim.grieving.has(u.householdId);
  // A summoned man (the elder walking out to the shura, kin at a grave) and a trailing
  // child are CALM AMONG TROOPS: un-fired US/ANA don't feed their proximity threat —
  // the elder must be able to walk INTO the 9 m shura ring without his own FLEE tier
  // firing. Gunfire, panic and insurgents always count.
  const trailing = isChild && !grieving && mood > 0.2 && trait(u.id, "cur") > 0.5;
  const calmNearTroops = !!u.summons || trailing;

  // --- ONE pass over effects + units: gunfire/blast fear AND nearest-armed / armed-count ---
  let fear = 0;
  for (const e of sim.effects) {
    if (e.kind === "muzzle" || e.kind === "impact" || e.kind === "blast" || e.kind === "frag_air") {
      const d = dist(e.pos, u.pos);
      if (d < 120) fear += (1 - d / 120) * (e.kind === "blast" ? 0.5 : 0.12);
    }
  }
  let nearArmed: Unit | null = null;
  let nad = Infinity;
  let armedCount = 0;
  let firingThreat: Unit | null = null;
  let fd = Infinity;
  // The nearest US/ANA soldier regardless of the calm-near-troops exemption — the
  // trailing child needs someone to trail even though he doesn't fear him.
  let nearTroop: Unit | null = null;
  let ntd = Infinity;
  // The "calm before": staged hostiles that have moved into the area but NOT yet opened fire
  // (ambushers holding their volley, infiltrators slipping through the draws). The director spawns
  // them a window BEFORE the shooting — that gap is the tell. Villagers sense "something is wrong
  // nearby" and quietly clear the open ground; an alert player reads the ABSENCE. (DESIGN §3.6.)
  let stagedThreat = 0; // 0..1, nearest staged-hostile proximity (1 = right on top)
  for (const o of sim.units) {
    if (!o.alive || !ARMED.has(o.faction)) continue;
    const d = dist(o.pos, u.pos);
    const isTroop = o.faction === "us" || o.faction === "ana";
    if (isTroop && d < ntd) {
      ntd = d;
      nearTroop = o;
    }
    if (d < 45 && !(calmNearTroops && isTroop && !o.hasFired)) {
      armedCount++;
      if (d < nad) {
        nad = d;
        nearArmed = o;
      }
    }
    if (o.hasFired) {
      if (d < 80) fear += (1 - d / 80) * 0.05;
      if (d < fd) {
        fd = d;
        firingThreat = o;
      }
    }
    // Staged (not-yet-firing) insurgent: ambush cell holding, OR an infiltrator moving concealed.
    // director.ts spawns ambushers with brainState "ambush" and infiltrators "patrolling"+concealed,
    // both faction "insurgent", and lays them at REALISTIC ambush stand-off (firingPositions 80-260 m
    // from the focus). They are ALIVE but have not fired (hasFired stays false until the volley). We
    // sense them out to STAGE_R = 150 m — well beyond the 45 m armed-proximity ring (which drives the
    // they're-on-top-of-us WARY/CLEAR/FLEE reaction) so the gentler MELT fires FIRST, at the mid
    // distance a village reads as "armed strangers have moved into the valley", before any shot. This
    // layering is the whole point: the tell is the absence at range, not a panic when a man is at 30 m.
    if (o.faction === "insurgent" && !o.hasFired) {
      const staged = o.brainState === "ambush" || (o.brainState === "patrolling" && o.technique === "concealed");
      if (staged) {
        const STAGE_R = 150; // m — sensing radius for the "calm before"
        if (d < STAGE_R) stagedThreat = Math.max(stagedThreat, 1 - d / STAGE_R);
      }
    }
  }
  u.panic = clamp01(u.panic + fear - dt * 0.08);

  // --- threat scalar → graduated tier (rises instantly, falls one step / FALL_S) ---
  const proximity = nearArmed ? clamp01(1 - nad / 45) : 0;
  const threat = clamp01(0.6 * proximity + 0.25 * (Math.min(armedCount, 3) / 3) + u.panic);
  let want = threat > 0.6 || u.panic > 0.45 ? 3 : threat > 0.35 ? 2 : threat > 0.15 ? 1 : 0;
  // The valley remembers: a grieving household clears the road from troops, always —
  // and in a hostile village the children are simply not out near a patrol (the
  // absence IS the read, the melt's quieter sibling running on attitude).
  if ((grieving || (isChild && mood < -0.2)) && nearTroop && ntd < 45) want = Math.max(want, 2);
  const prev = u.reactTier ?? 0;
  if (want >= prev) {
    u.reactTier = want;
    u.tierHoldS = 0;
  } else {
    u.tierHoldS = (u.tierHoldS ?? 0) + dt;
    // Reception scales how fast a villager RELAXES (the fall), never how fast he
    // reacts (the rise): a village patrolled daily thaws around your men in seconds;
    // one you haven't visited in ten days — or one carrying a blood debt — stays
    // wary a beat too long, and the player can read the difference.
    if (u.tierHoldS > 2.5 * lerp(1.7, 0.7, reception)) {
      u.reactTier = prev - 1;
      u.tierHoldS = 0;
    }
  }
  const tier = u.reactTier ?? want;

  // --- diurnal context (deterministic ambient light the World writes each tick) ---
  // Hoisted above the reaction tiers because the NIGHT-home drive must pre-empt the gentler WARY /
  // CLEAR-ROAD reactions: a villager who is merely wary of a distant armed man at 02:00 still wants
  // to be inside, not frozen in the open field. The home he settles at is the village center SNAPPED
  // off the wire / onto reachable ground (the same snap civMoveTo applies) so "am I home?" matches
  // where he really stops — checking the raw center reads as never-home and re-fires the path every
  // tick (the issue-010 thrash). Only an actual FLEE (tier 3) overrides the walk home.
  const light = sim.light;
  const NIGHT = light < 0.2;
  const DAY = light >= 0.85;
  const HOME_R = 16;
  // Lazy + memoized: civHome() does two terrain snaps, so compute the snapped home (and the at-home
  // test) AT MOST ONCE per tick and ONLY on the branches that read it — in broad daylight with no
  // threat the diurnal logic never needs it, so we don't pay the snap every civilian every tick.
  let _home: { x: number; y: number } | null = null;
  const getHome = () => (_home ??= civHome(sim, u));
  const isAtHome = () => dist(getHome(), u.pos) < HOME_R;

  // ---------------------------------------------------------------- MELT AWAY (the calm before)
  // Precedence: FLEE (tier 3, real gunfire) > MELT > CLEAR-ROAD > WARY > diurnal OBLIVIOUS.
  // Gated to tier < 3 so it never overrides an actual flee — once the shooting starts the FLEE
  // branch owns the villager. Staged hostiles nearby but no rounds yet: people quietly leave the
  // open ground and go home, children first, NOT the panicked sprint. The sim.rng.chance stagger
  // means they don't all depart on one tick — the fields THIN over a few seconds (the readable
  // "melting"), so the absence reads as a deliberate, legible signal rather than a teleport.
  // A staged threat ABORTS a summons outright, LATCHED — per-tick precedence alone
  // would let the melt's rng stagger ping-pong the elder between home and the shura.
  // An elder who turns back on his way out is itself a tell the squad can read.
  if (u.summons && stagedThreat > 0.18) {
    u.summons = null;
    u.summonsAborted = true;
  }
  if (stagedThreat > 0.18 && tier < 3) {
    const urgency = stagedThreat * (isChild ? 1.5 : isElder ? 1.1 : 1.0);
    if (sim.rng.chance(clamp01(0.25 + urgency))) {
      sim.civMoveTo(u, homePoint(sim, u));
      u.technique = isChild && urgency > 0.8 ? "rush" : "patrol"; // a kid may scamper; adults walk
      u.paceScale = 1;
      u.stance = "stand";
      u.faceLock = null;
      return;
    }
    // not departing this tick (the stagger) — fall through to the normal day/night behaviour so a
    // still-present villager keeps acting natural until his number comes up.
  }

  // ---------------------------------------------------------------- FLEE
  if (tier >= 3) {
    const threatU = firingThreat ?? nearArmed;
    const home = homePoint(sim, u);
    let dir = threatU ? norm(sub(u.pos, threatU.pos)) : { x: 0, y: 1 };
    const toHome = norm(sub(home, u.pos));
    if (!threatU || dist(home, threatU.pos) > dist(u.pos, threatU.pos)) {
      dir = norm(add(scale(dir, 0.5), scale(toHome, 0.6)));
    }
    if (len(dir) < 0.1) dir = { x: 0, y: 1 };
    const dest = sim.terrain.reachablePoint(u.pos.x + dir.x * 60, u.pos.y + dir.y * 60);
    sim.civMoveTo(u, dest);
    u.technique = "rush"; // run, don't amble
    u.paceScale = 1;
    u.stance = "stand";
    u.faceLock = null;
    return;
  }

  // ---------------------------------------------------------------- SUMMONS (civic scenes)
  // The elder walking out to sit with the squad leader; a household standing at a
  // grave at first light. Below FLEE and the melt in precedence — gunfire and staged
  // threats own him — but above the diurnal routine: this is where he is needed.
  if (u.summons && tier < 3) {
    if (sim.timeS >= u.summons.untilS) {
      u.summons = null;
    } else {
      const dest = { x: u.summons.x, y: u.summons.y };
      if (dist(u.pos, dest) > 2.5) {
        const headed = u.pathGoal && dist(u.pathGoal, dest) < 6;
        if (u.path.length === 0 || !headed) sim.civMoveTo(u, dest);
        u.technique = "patrol";
        u.paceScale = isElder ? 0.5 : 0.65; // deliberate, unhurried — he comes with dignity
        u.stance = "stand";
        u.faceLock = null;
      } else {
        u.path = [];
        u.moving = false;
        const host = u.summons.faceId ? sim.unit(u.summons.faceId) : null;
        // sits down with the squad leader; stands still at a grave
        u.stance = host ? "crouch" : "stand";
        u.faceLock = host ? Math.atan2(host.pos.y - u.pos.y, host.pos.x - u.pos.x) : (u.faceLock ?? null);
      }
      return;
    }
  }

  // ---------------------------------------------------------------- NIGHT HOME (pre-empts WARY/CLEAR)
  // At night a wary or road-clearing villager withdraws home rather than freezing in the open or
  // sidestepping to a field edge — being inside after dark is the stronger drive. FLEE (tier 3) above
  // already owns a real threat; this only catches the calmer tiers 1-2. Re-issue home when not already
  // headed there: path empty, OR the current goal is a daytime ERRAND (not near home) — so a villager
  // who was mid-errand when dusk fell turns around at once instead of finishing the trip out. The
  // pathGoal-near-home guard means we don't re-path every tick once he's genuinely homebound (issue-010).
  if (NIGHT && tier < 3 && !isAtHome()) {
    const home = getHome();
    const headingHome = u.pathGoal && dist(u.pathGoal, home) < HOME_R + 10;
    if (u.path.length === 0 || !headingHome) {
      const far = dist(home, u.pos) > 160;
      sim.civMoveTo(u, home, far ? 0.4 : 0);
      u.technique = "patrol";
      u.paceScale = isElder ? 0.4 : 0.6;
      u.faceLock = null;
    }
    return;
  }

  // ---------------------------------------------------------------- KIDS TRAIL THE PATROL
  // The tell a veteran reads at a glance (CALL atmospherics: children near a patrol is
  // the canonical green): in a friendly village the kids pick up a passing weapons-cold
  // patrol and trail it at a respectful ~9 m, scampering wall to wall to keep up. Their
  // troop-proximity feed is exempted above, so the FLEE math never fires on the men
  // they're following; real gunfire (panic) and insurgents still own them.
  if (trailing && tier < 3 && !NIGHT && nearTroop && ntd < 35 && !nearTroop.hasFired) {
    const behind = add(nearTroop.pos, scale(fromAngle(nearTroop.facing + Math.PI), 9));
    if (dist(u.pos, behind) > 4) {
      const headed = u.pathGoal && dist(u.pathGoal, behind) < 6;
      if (u.path.length === 0 || !headed) sim.civMoveTo(u, behind);
      u.technique = "patrol";
      u.paceScale = 0.95; // a scamper, to keep up with marching men
      u.faceLock = null;
    } else {
      u.path = [];
      u.moving = false;
      u.faceLock = Math.atan2(nearTroop.pos.y - u.pos.y, nearTroop.pos.x - u.pos.x);
    }
    return;
  }

  // ---------------------------------------------------------------- CLEAR-ROAD
  if (tier === 2 && nearArmed) {
    u.technique = "patrol";
    u.paceScale = 1;
    // A curious child drifts IN for a look instead of clearing (never inside FLEE
    // range, never in a hostile village, never from a grieving household).
    if (isChild && trait(u.id, "cur") > 0.5 && threat < 0.6 && mood > -0.2 && !grieving) {
      const to = sub(nearArmed.pos, u.pos);
      const d = len(to);
      if (d > 6) {
        const dest = add(u.pos, scale(norm(to), Math.min(d - 5, 8)));
        sim.civMoveTo(u, dest);
      } else {
        u.path = [];
        u.moving = false;
        u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x);
      }
      return;
    }
    // Elder: withdraw toward the compound and turn away.
    if (isElder) {
      sim.civMoveTo(u, homePoint(sim, u));
      u.faceLock = null;
      return;
    }
    // Everyone else: step off the patrol's line to the near field edge, then watch it pass.
    const away = norm(sub(u.pos, nearArmed.pos));
    const perp = { x: -away.y, y: away.x };
    const home = homePoint(sim, u);
    const side = dot(perp, norm(sub(home, u.pos))) >= 0 ? 1 : -1;
    const step = { x: away.x * 0.5 + perp.x * side, y: away.y * 0.5 + perp.y * side };
    const dest = add(u.pos, scale(norm(step), 5));
    sim.civMoveTo(u, dest);
    u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x); // watch them
    return;
  }

  // ---------------------------------------------------------------- WARY
  if (tier === 1 && nearArmed) {
    u.path = [];
    u.moving = false;
    u.stance = "stand";
    u.faceLock = Math.atan2(nearArmed.pos.y - u.pos.y, nearArmed.pos.x - u.pos.x); // look up, watch
    return;
  }

  // ---------------------------------------------------------------- OBLIVIOUS (pattern of life)
  u.faceLock = null;
  u.technique = "patrol"; // amble (1.5 m/s base) eased by a per-person pace, not a uniform 2 m/s march
  // per-person amble pace; paceScale is clamped <=1 in the integrator, so 0.5-0.92 * 1.5 = ~0.75-1.4 m/s
  const pb = trait(u.id, "pace");
  u.paceScale = isChild ? 0.62 + 0.3 * pb : isElder ? 0.42 + 0.18 * pb : 0.55 + 0.37 * pb;

  // --- DIURNAL PATTERN OF LIFE (light/NIGHT/DAY/home/atHome hoisted above the tiers) ---
  // The OCCUPANCY curve (how many are out) is what the player and probe read; it is governed by a
  // home-pull that is a pure function of light — identical whether light is rising (dawn) or falling
  // (dusk), so we never need to name the two apart.
  //   light >= 0.85  → full day (07-17h): normal pattern of life, everyone working the fields.
  //   0.2..0.85      → dawn/dusk ramp: bias toward home; children/elders lean home earlier.
  //   light < 0.2    → night: the NIGHT-HOME override above already walked him in; here he idles home.
  // A still-out night villager was handled by the override; reaching here at night means he IS home.

  // Home-pull grows smoothly as light falls below full day; children/elders bias home earlier.
  // 0 at full day → ~1 near night. This is the curve that produces "out early, drifting home as the
  // sun drops" WITHOUT needing to name dawn vs dusk (Law 4: model what's measured, the occupancy).
  const homePull = DAY ? 0 : clamp01((0.85 - light) / 0.65);
  const childBias = isChild ? 0.35 : isElder ? 0.15 : 0;
  const goHome = clamp01(homePull + childBias);

  if (u.path.length === 0) {
    // Dwell at a node — work a field, water animals, chat — for a per-person spell, then
    // amble to the next errand (longer hops prefer the track network). At night, suppress all new
    // errands so a villager who has reached home stays in (no 2% repick sending him back out).
    u.brainTimer = (u.brainTimer ?? 0) - dt;
    if (!NIGHT && u.brainTimer <= 0 && u.routine && u.routine.length > 0 && sim.rng.chance(0.02)) {
      // As light drops, bias the next destination toward home (deterministic, seeded). People don't
      // start a fresh long-haul trip to the next bazaar at dusk, so when goHome is high we also
      // reject far "market" errands and stay local / head in.
      if (sim.rng.chance(goHome)) {
        // Drawn toward home. If already in, STAY in (home is a sink whose depth tracks the light) —
        // this is what makes the outdoor OCCUPANCY ride the diurnal curve: at dawn/dusk a fraction
        // ~goHome of villagers sit at home each repick, so the count sits below the midday peak, and
        // collapses to ~0 as light → night. If still out, head in.
        if (!isAtHome()) {
          sim.civMoveTo(u, getHome());
          u.paceScale = isElder ? 0.45 : 0.6;
        } else {
          u.stance = "stand";
          u.moving = false;
        }
        u.brainTimer = isElder ? 16 + 24 * trait(u.id, "dwell") : 10 + 18 * trait(u.id, "dwell");
      } else {
        let node = sim.rng.pick(u.routine);
        if (goHome > 0.4 && node.activity === "market") node = sim.rng.pick(u.routine); // re-roll the long-haul
        const far = dist(node.target, u.pos) > 160;
        sim.civMoveTo(u, node.target, far ? 0.4 : 0);
        const dwell = isElder ? 18 + 28 * trait(u.id, "dwell") : isChild ? 4 + 10 * trait(u.id, "dwell") : 10 + 22 * trait(u.id, "dwell");
        u.brainTimer = dwell;
      }
    } else {
      // standing idle: a slow look-around so a villager isn't a frozen statue
      u.stance = "stand";
      u.moving = false;
      const ph = trait(u.id, "idle") * Math.PI * 2;
      u.facing = ph + 0.55 * Math.sin(sim.timeS * 0.16 + ph);
    }
  }
}

function homePoint(sim: CombatSim, u: Unit): { x: number; y: number } {
  const vil = sim.terrain.villages.find((v) => v.id === u.villageId) ?? sim.terrain.villages[0];
  if (vil) return sim.terrain.cellCenter(vil.cx, vil.cy);
  return { x: u.pos.x, y: u.pos.y };
}

/**
 * The point a villager actually settles at when sent "home": the village center snapped off the COP
 * wire and onto reachable ground — the SAME reachablePoint→civSafePoint snap civMoveTo applies. Used
 * by the diurnal logic so the "am I home?" arrival test matches where they really stop (the raw
 * center can be 20-60 m from the snapped home; testing the raw center reads as never-home and
 * re-fires the path every tick — the issue-010 stall). Deterministic (pure terrain snap), so the
 * occupancy curve is replay-stable.
 */
function civHome(sim: CombatSim, u: Unit): { x: number; y: number } {
  const c = homePoint(sim, u);
  const r = sim.terrain.reachablePoint(c.x, c.y);
  return sim.terrain.civSafePoint(r.x, r.y);
}
