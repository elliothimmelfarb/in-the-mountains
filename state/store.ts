"use client";
import { create } from "zustand";
import { RNG } from "@/lib/sim/rng";
import { Terrain, DEFAULT_TERRAIN } from "@/lib/sim/terrain";
import {
  CampaignState,
  createCampaign,
  advancePhase,
  currentPhase,
  completeDirective,
  applyCombatResult,
  pushLog,
  addIntel,
  recomputeMetrics,
  reseedCounters,
} from "@/lib/sim/campaign";
import { CombatSim } from "@/lib/sim/combat";
import {
  PatrolPlan,
  ContactSpec,
  EncounterMeta,
  MissionType,
  newPatrolId,
  resolveMarch,
  buildEncounter,
  buildBaseDefense,
} from "@/lib/sim/patrol";
import { GameEvent, maybeEvent, applyEventChoice } from "@/lib/sim/events";

export type Screen = "menu" | "briefing" | "command" | "tactical" | "afteraction" | "tourend";

export type OrderTool =
  | "select"
  | "move"
  | "movefast"
  | "assault"
  | "hold"
  | "suppress"
  | "smoke"
  | "frag"
  | "withdraw";

export interface PlanDraft {
  missionType: MissionType;
  memberIds: string[];
  route: { cx: number; cy: number }[];
  targetVillageId?: string;
}

export interface AfterAction {
  outcome: string;
  usKIA: number;
  usWIA: number;
  enemyKIA: number;
  civCasualties: number;
  durationS: number;
  ammoExpended: number;
  fireMissionsUsed: number;
  context: string;
  log: { msg: string; kind: string; timeS: number }[];
}

interface GameStore {
  screen: Screen;
  campaign: CampaignState | null;
  terrain: Terrain | null;
  rng: RNG | null;

  // tactical
  sim: CombatSim | null;
  activePlan: PatrolPlan | null;
  activeSpec: ContactSpec | null;
  activeMeta: EncounterMeta | null;
  selection: string[];
  orderTool: OrderTool;
  paused: boolean;
  speed: number;
  fireSupport: { weaponId: string; label: string; rounds: number } | null;

  // planning / command
  plan: PlanDraft;
  currentEvent: GameEvent | null;
  afterAction: AfterAction | null;

  tick: number; // HUD refresh counter

  // tutorial
  tutorial: boolean;
  tutorialStep: number;

  // save
  savedExists: boolean;
  refreshSave: () => void;

  // ---- actions ----
  newCampaign: (seed?: string, days?: number) => void;
  startTutorial: () => void;
  tutorialNext: () => void;
  tutorialPrev: () => void;
  endTutorial: () => void;
  saveCampaign: () => void;
  loadCampaign: () => void;
  gotoMenu: () => void;
  gotoCommand: () => void;
  advance: () => void;
  resolveEvent: (choiceId: string) => void;

  // planning
  setMission: (m: MissionType) => void;
  toggleMember: (id: string) => void;
  selectSquad: (squadId: string) => void;
  addWaypoint: (cx: number, cy: number) => void;
  popWaypoint: () => void;
  clearRoute: () => void;
  launchPatrol: () => void;
  conductShura: (villageId: string) => void;
  fundProject: (villageId: string, project: string) => void;

  // tactical
  beginTactical: () => void;
  endTactical: () => void;
  selectUnits: (ids: string[], additive?: boolean) => void;
  setOrderTool: (t: OrderTool) => void;
  orderAtWorld: (x: number, y: number) => void;
  orderTarget: (enemyId: string) => void;
  setSpeed: (s: number) => void;
  togglePause: () => void;
  setFireSupport: (weaponId: string | null, label?: string, rounds?: number) => void;
  fireAtWorld: (x: number, y: number) => void;
  medevacSelected: () => void;
  syncTactical: () => void;
}

const DEFAULT_PLAN: PlanDraft = { missionType: "presence", memberIds: [], route: [] };
const SAVE_KEY = "itm-save-v1";

function hasSaveOnDisk(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage.getItem(SAVE_KEY);
  } catch {
    return false;
  }
}

function clearSaveOnDisk() {
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export const useGame = create<GameStore>((set, get) => ({
  screen: "menu",
  campaign: null,
  terrain: null,
  rng: null,
  sim: null,
  activePlan: null,
  activeSpec: null,
  activeMeta: null,
  selection: [],
  orderTool: "select",
  paused: false,
  speed: 1,
  fireSupport: null,
  plan: { ...DEFAULT_PLAN },
  currentEvent: null,
  afterAction: null,
  tick: 0,
  tutorial: false,
  tutorialStep: 0,
  savedExists: false, // set on the client via refreshSave() to avoid hydration mismatch

  refreshSave: () => set({ savedExists: hasSaveOnDisk() }),

  saveCampaign: () => {
    const { campaign, rng } = get();
    if (!campaign || !rng || campaign.ended) return;
    try {
      const blob = JSON.stringify({ v: 1, rngState: rng.getState(), campaign });
      window.localStorage.setItem(SAVE_KEY, blob);
      set({ savedExists: true });
    } catch {
      /* storage full / unavailable — ignore */
    }
  },

  loadCampaign: () => {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { rngState: number; campaign: CampaignState };
      const campaign = parsed.campaign;
      const terrain = new Terrain({ ...DEFAULT_TERRAIN, seed: campaign.seed });
      const rng = new RNG(`${campaign.seed}-adv`);
      rng.setState(parsed.rngState);
      reseedCounters(campaign);
      set({
        campaign,
        terrain,
        rng,
        screen: "command",
        sim: null,
        plan: { ...DEFAULT_PLAN },
        currentEvent: null,
        afterAction: null,
        tutorial: false,
        tick: get().tick + 1,
      });
    } catch {
      /* corrupt save — ignore */
    }
  },

  startTutorial: () => {
    get().newCampaign("tutorial-valley", 90);
    const c = get().campaign;
    if (c) c.enemyHeat = 0.4;
    set({ tutorial: true, tutorialStep: 0 });
  },
  tutorialNext: () => set((st) => ({ tutorialStep: st.tutorialStep + 1 })),
  tutorialPrev: () => set((st) => ({ tutorialStep: Math.max(0, st.tutorialStep - 1) })),
  endTutorial: () => set({ tutorial: false }),

  newCampaign: (seed, days = 120) => {
    const s = seed && seed.length ? seed : `valley-${Math.floor(performance.now())}`;
    const { state, terrain } = createCampaign(s, days);
    set({
      campaign: state,
      terrain,
      rng: new RNG(`${s}-adv`),
      screen: "command",
      sim: null,
      plan: { ...DEFAULT_PLAN },
      currentEvent: null,
      afterAction: null,
      tutorial: false,
      tick: get().tick + 1,
    });
    get().saveCampaign();
  },

  gotoMenu: () => set({ screen: "menu", tutorial: false }),
  gotoCommand: () => set({ screen: "command", tick: get().tick + 1 }),

  advance: () => {
    const { campaign, terrain, rng } = get();
    if (!campaign || !terrain || !rng) return;
    advancePhase(campaign, rng);

    // Chance of an attack on the COP, worse at night & high heat.
    const night = currentPhase(campaign) === "Night";
    const attackP = campaign.enemyHeat * (night ? 0.16 : 0.05);
    if (!campaign.ended && rng.chance(attackP)) {
      const { init, meta } = buildBaseDefense(campaign, terrain, rng.fork(`def-${campaign.day}`));
      const sim = new CombatSim(init);
      pushLog(campaign, "STAND TO! The COP is taking fire from the ridgelines!", "contact");
      set({
        sim,
        activePlan: null,
        activeSpec: { occurred: true, cell: meta.contactCell, enemyInitiated: true, kind: "complex", enemyCount: 0, narrative: `Attack on ${campaign.fob.name}.` },
        activeMeta: meta,
        screen: "briefing",
        selection: [],
        paused: true,
        speed: 1,
        tick: get().tick + 1,
      });
      return;
    }

    // Otherwise maybe a decision event.
    const ev = !campaign.ended ? maybeEvent(campaign, rng) : null;
    if (campaign.ended) {
      clearSaveOnDisk();
      set({ screen: "tourend", savedExists: false, tick: get().tick + 1 });
      return;
    }
    set({ currentEvent: ev, tick: get().tick + 1 });
    get().saveCampaign();
  },

  resolveEvent: (choiceId) => {
    const { campaign, rng, currentEvent } = get();
    if (!campaign || !rng || !currentEvent) return;
    applyEventChoice(campaign, rng, currentEvent, choiceId);
    recomputeMetrics(campaign);
    set({ currentEvent: null, tick: get().tick + 1 });
    get().saveCampaign();
  },

  // ---------------- planning ----------------
  setMission: (m) => set((st) => ({ plan: { ...st.plan, missionType: m } })),
  toggleMember: (id) =>
    set((st) => {
      const has = st.plan.memberIds.includes(id);
      return {
        plan: {
          ...st.plan,
          memberIds: has ? st.plan.memberIds.filter((x) => x !== id) : [...st.plan.memberIds, id],
        },
      };
    }),
  selectSquad: (squadId) => {
    const { campaign } = get();
    if (!campaign) return;
    const sq = campaign.platoon.squads.find((s) => s.id === squadId);
    if (!sq) return;
    const ready = sq.memberIds.filter((id) => {
      const m = campaign.platoon.members.find((x) => x.id === id);
      return m && m.alive && m.status === "ready";
    });
    set((st) => {
      const allIn = ready.every((id) => st.plan.memberIds.includes(id));
      const set2 = new Set(st.plan.memberIds);
      if (allIn) ready.forEach((id) => set2.delete(id));
      else ready.forEach((id) => set2.add(id));
      return { plan: { ...st.plan, memberIds: [...set2] } };
    });
  },
  addWaypoint: (cx, cy) =>
    set((st) => ({ plan: { ...st.plan, route: [...st.plan.route, { cx, cy }] } })),
  popWaypoint: () => set((st) => ({ plan: { ...st.plan, route: st.plan.route.slice(0, -1) } })),
  clearRoute: () => set((st) => ({ plan: { ...st.plan, route: [] } })),

  launchPatrol: () => {
    const { campaign, terrain, rng, plan } = get();
    if (!campaign || !terrain || !rng) return;
    if (plan.memberIds.length === 0 || plan.route.length < 2) return;

    // mark soldiers as out
    const fullPlan: PatrolPlan = {
      id: newPatrolId(),
      missionType: plan.missionType,
      memberIds: plan.memberIds,
      route: [{ cx: campaign.copCell.cx, cy: campaign.copCell.cy }, ...plan.route],
      notes: "",
    };

    const spec = resolveMarch(campaign, terrain, fullPlan, rng.fork(`march-${campaign.day}-${campaign.phaseIndex}`));
    if (spec.occurred) {
      const { init, meta } = buildEncounter(campaign, terrain, fullPlan, spec, rng.fork(`enc-${campaign.day}`));
      const sim = new CombatSim(init);
      set({
        sim,
        activePlan: fullPlan,
        activeSpec: spec,
        activeMeta: meta,
        screen: "briefing",
        selection: [],
        paused: true,
        speed: 1,
        plan: { ...DEFAULT_PLAN },
        tick: get().tick + 1,
      });
    } else {
      applyNoContact(campaign, rng, fullPlan);
      recomputeMetrics(campaign);
      // advance a phase for the patrol's duration
      advancePhase(campaign, rng);
      set({ plan: { ...DEFAULT_PLAN }, tick: get().tick + 1, screen: "command" });
      if (campaign.ended) {
        clearSaveOnDisk();
        set({ screen: "tourend", savedExists: false });
      } else {
        get().saveCampaign();
      }
    }
  },

  conductShura: (villageId) => {
    const { campaign, rng } = get();
    if (!campaign || !rng) return;
    const v = campaign.villages.find((x) => x.id === villageId);
    if (!v) return;
    const gain = 4 + Math.round(rng.range(0, 6));
    v.attitude = Math.min(100, v.attitude + gain);
    v.cooperation = Math.min(100, v.cooperation + gain);
    v.lastVisitedDay = campaign.day;
    pushLog(campaign, `Shura at ${v.name}: tea with ${v.elder}. Promises made on both sides (+${gain} attitude).`, "info");
    if (rng.chance(0.4 + v.cooperation / 200)) {
      addIntel(campaign, {
        source: "HUMINT",
        text: `${v.elder} hints that outsiders pressure his village and cache weapons up the draw.`,
        reliability: 0.55,
        cx: v.cx,
        cy: v.cy,
      });
    }
    // KLE directive progress
    const kle = campaign.directives.find((d) => d.kind === "kle" && d.status === "active");
    if (kle) {
      kle.progress = Math.min(1, kle.progress + 0.5);
      if (kle.progress >= 1) completeDirective(campaign, kle.id);
    }
    recomputeMetrics(campaign);
    advancePhase(campaign, rng);
    set({ tick: get().tick + 1 });
    if (campaign.ended) {
      clearSaveOnDisk();
      set({ screen: "tourend", savedExists: false });
    } else {
      get().saveCampaign();
    }
  },

  fundProject: (villageId, project) => {
    const { campaign } = get();
    if (!campaign) return;
    const v = campaign.villages.find((x) => x.id === villageId);
    if (!v || campaign.cerp < 5000) return;
    campaign.cerp -= 5000;
    v.projects.push(project);
    v.attitude = Math.min(100, v.attitude + 8);
    v.sympathy = Math.max(0, v.sympathy - 5);
    pushLog(campaign, `CERP project funded at ${v.name}: ${project}. The valley will notice who built it.`, "info");
    const con = campaign.directives.find((d) => d.kind === "construct" && d.status === "active");
    if (con) {
      con.progress = Math.min(1, con.progress + 0.5);
      if (con.progress >= 1) completeDirective(campaign, con.id);
    }
    recomputeMetrics(campaign);
    set({ tick: get().tick + 1 });
    get().saveCampaign();
  },

  // ---------------- tactical ----------------
  beginTactical: () => set({ screen: "tactical", paused: false, tick: get().tick + 1 }),

  endTactical: () => {
    const { sim, campaign, rng, activeMeta, activePlan } = get();
    if (!sim || !campaign || !rng) return;
    const result = sim.result();
    applyCombatResult(campaign, rng, result, sim.units, { villageId: activeMeta?.villageId });

    // patrol mission credit even on contact (you showed up)
    if (activePlan) applyNoContact(campaign, rng, activePlan, true);

    const aa: AfterAction = {
      outcome: result.outcome,
      usKIA: result.usKIA.length,
      usWIA: result.usWIA.length,
      enemyKIA: result.enemyKIA,
      civCasualties: result.civCasualties,
      durationS: result.durationS,
      ammoExpended: result.ammoExpended,
      fireMissionsUsed: result.fireMissionsUsed,
      context: sim.context,
      log: sim.log.slice(-30).map((l) => ({ msg: l.msg, kind: l.kind, timeS: l.timeS })),
    };
    // advance time for the engagement
    advancePhase(campaign, rng);
    set({ afterAction: aa, screen: "afteraction", sim: null, selection: [], tick: get().tick + 1 });
    if (campaign.ended) {
      clearSaveOnDisk();
      set({ screen: "tourend", savedExists: false });
    } else {
      get().saveCampaign();
    }
  },

  selectUnits: (ids, additive) =>
    set((st) => ({ selection: additive ? [...new Set([...st.selection, ...ids])] : ids })),

  setOrderTool: (t) => set({ orderTool: t, fireSupport: null }),

  orderAtWorld: (x, y) => {
    const { sim, selection, orderTool } = get();
    if (!sim || selection.length === 0) return;
    const point = { x, y };
    switch (orderTool) {
      case "move":
        sim.issueOrder(selection, { type: "move", point, technique: "patrol" });
        break;
      case "movefast":
        sim.issueOrder(selection, { type: "move", point, technique: "rush" });
        break;
      case "assault":
        sim.issueOrder(selection, { type: "assault", point, technique: "traveling" });
        break;
      case "hold":
        sim.issueOrder(selection, { type: "hold", point });
        break;
      case "suppress":
        sim.issueOrder(selection, { type: "suppress", point });
        break;
      case "withdraw":
        sim.issueOrder(selection, { type: "withdraw", point, technique: "rush" });
        break;
      case "smoke":
        for (const id of selection) {
          const u = sim.unit(id);
          if (u) sim.throwSmoke(u, point);
        }
        break;
      case "frag":
        sim.issueOrder(selection, { type: "frag", point });
        break;
      default:
        sim.issueOrder(selection, { type: "move", point, technique: "patrol" });
    }
    set({ tick: get().tick + 1 });
  },

  orderTarget: (enemyId) => {
    const { sim, selection } = get();
    if (!sim || selection.length === 0) return;
    sim.issueOrder(selection, { type: "engage", targetId: enemyId });
    set({ tick: get().tick + 1 });
  },

  setSpeed: (s) => set({ speed: s, paused: false }),
  togglePause: () => set((st) => ({ paused: !st.paused })),

  setFireSupport: (weaponId, label, rounds) =>
    set({ fireSupport: weaponId ? { weaponId, label: label ?? weaponId, rounds: rounds ?? 4 } : null, orderTool: "select" }),

  fireAtWorld: (x, y) => {
    const { sim, fireSupport } = get();
    if (!sim || !fireSupport) return;
    const point = { x, y };
    if (fireSupport.weaponId === "cas_gun" || fireSupport.weaponId === "cas_rocket") {
      sim.requestCAS(point, fireSupport.weaponId as "cas_gun" | "cas_rocket");
    } else {
      sim.requestFireMission(fireSupport.weaponId, point, fireSupport.rounds);
    }
    set({ fireSupport: null, tick: get().tick + 1 });
  },

  medevacSelected: () => {
    const { sim, selection } = get();
    if (!sim) return;
    for (const id of selection) {
      const u = sim.unit(id);
      if (u && (!u.conscious || u.wounds.length > 0)) sim.medevac(id);
    }
    set({ tick: get().tick + 1 });
  },

  syncTactical: () => {
    const { sim } = get();
    if (!sim) return;
    if (sim.outcome !== "ongoing") {
      get().endTactical();
      return;
    }
    set({ tick: get().tick + 1 });
  },
}));

// Debug handle (also handy for the in-game tutorial driver).
if (typeof window !== "undefined") {
  (window as unknown as { __ITM?: typeof useGame }).__ITM = useGame;
}

// ---------------------------------------------------------------------------
//  Non-contact patrol resolution (mission rewards / progress)
// ---------------------------------------------------------------------------
function applyNoContact(campaign: CampaignState, rng: RNG, plan: PatrolPlan, afterContact = false) {
  // which villages did the route pass near?
  const visited = new Set<string>();
  for (const wp of plan.route) {
    for (const v of campaign.villages) {
      if (Math.hypot(wp.cx - v.cx, wp.cy - v.cy) < 8) visited.add(v.id);
    }
  }
  const visitedVils = campaign.villages.filter((v) => visited.has(v.id));

  switch (plan.missionType) {
    case "presence":
    case "cordon_search": {
      for (const v of visitedVils) {
        v.attitude = Math.min(100, v.attitude + (afterContact ? 1 : 3));
        v.lastVisitedDay = campaign.day;
      }
      const d = campaign.directives.find((x) => x.kind === "presence" && x.status === "active");
      if (d) {
        const everVisited = campaign.villages.filter((v) => v.lastVisitedDay >= 0).length;
        d.progress = Math.min(1, everVisited / Math.max(1, campaign.villages.length));
        if (d.progress >= 1) completeDirective(campaign, d.id);
      }
      if (!afterContact) pushLog(campaign, `Presence patrol returned. Villages walked: ${visitedVils.map((v) => v.name).join(", ") || "open ground"}.`, "info");
      break;
    }
    case "recon": {
      addIntel(campaign, {
        source: "PATROL",
        text: `Patrol reports trail use and fresh tracks in the ${rng.pick(["upper", "lower", "eastern", "western"])} valley.`,
        reliability: 0.6,
        cx: plan.route[plan.route.length - 1].cx,
        cy: plan.route[plan.route.length - 1].cy,
      });
      if (!afterContact) pushLog(campaign, "Recon patrol returned with fresh atmospherics on the upper valley.", "info");
      break;
    }
    case "census": {
      for (const v of visitedVils) v.censusDone = true;
      const d = campaign.directives.find((x) => x.kind === "census" && x.status === "active");
      if (d) {
        const censused = campaign.villages.filter((v) => v.censusDone).length;
        d.progress = Math.min(1, censused / 3);
        if (d.progress >= 1) completeDirective(campaign, d.id);
      }
      if (!afterContact) pushLog(campaign, "Census patrol logged military-age males and built the human-terrain picture.", "info");
      break;
    }
    case "kle": {
      for (const v of visitedVils) {
        v.attitude = Math.min(100, v.attitude + 5);
        v.cooperation = Math.min(100, v.cooperation + 5);
        v.lastVisitedDay = campaign.day;
      }
      const d = campaign.directives.find((x) => x.kind === "kle" && x.status === "active");
      if (d && visitedVils.length) {
        d.progress = Math.min(1, d.progress + 0.5);
        if (d.progress >= 1) completeDirective(campaign, d.id);
      }
      break;
    }
    case "ambush":
    case "overwatch": {
      const d = campaign.directives.find((x) => x.kind === "interdict" && x.status === "active");
      if (afterContact && d) {
        d.progress = Math.min(1, d.progress + 0.6);
        if (d.progress >= 1) completeDirective(campaign, d.id);
      }
      if (!afterContact) pushLog(campaign, "The ambush sat cold. Nothing moved tonight.", "info");
      break;
    }
    default:
      break;
  }
}
