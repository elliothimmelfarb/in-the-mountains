"use client";
import { create } from "zustand";
import { World, createWorld, loadWorld, applyWorldEventChoice, MissionType } from "@/lib/sim/world";
import { MoveTechnique } from "@/lib/sim/entities";

export type Screen = "menu" | "deploy" | "tourend";

export type OrderTool = "select" | "move" | "assault" | "hold" | "suppress" | "smoke" | "frag" | "withdraw";

export const SPEEDS = [1, 2, 4, 8, 16];

interface GameStore {
  screen: Screen;
  world: World | null;

  // selection / orders
  selection: string[];
  orderTool: OrderTool;
  posture: MoveTechnique;

  // patrol planning
  planning: boolean;
  planRoute: { cx: number; cy: number }[];
  planMission: MissionType;

  // time control
  paused: boolean;
  speed: number;
  warp: boolean;

  // fire support
  fireSupport: { weaponId: string; label: string; rounds: number } | null;

  // ui
  tick: number;
  selectedVillage: string | null;
  banner: string | null;
  jacketId: string | null;

  // save
  savedExists: boolean;
  refreshSave: () => void;

  // tutorial
  tutorial: boolean;
  tutorialStep: number;

  // ---- lifecycle ----
  newCampaign: (seed?: string, days?: number) => void;
  loadCampaign: () => void;
  saveCampaign: () => void;
  gotoMenu: () => void;
  resume: () => void;
  startTutorial: () => void;
  tutorialNext: () => void;
  tutorialPrev: () => void;
  endTutorial: () => void;

  // ---- the real-time frame (called by WorldView's RAF) ----
  frame: (realDt: number) => void;

  // ---- selection / orders ----
  selectUnits: (ids: string[], additive?: boolean) => void;
  setOrderTool: (t: OrderTool) => void;
  setPosture: (p: MoveTechnique) => void;
  orderAtWorld: (x: number, y: number) => void;
  orderTarget: (enemyId: string) => void;
  squadIds: (squadId: string) => string[];

  // ---- patrol planning ----
  setPlanning: (on: boolean) => void;
  setMission: (m: MissionType) => void;
  addWaypoint: (cx: number, cy: number) => void;
  popWaypoint: () => void;
  clearRoute: () => void;
  stepOff: () => void;

  // ---- village / COIN ----
  selectVillage: (id: string | null) => void;
  conductKLE: (villageId: string) => void;
  fundProject: (villageId: string, type: string) => void;
  requestResupply: (kind: "convoy" | "air") => void;
  recallTask: (taskId: number) => void;
  setJacket: (id: string | null) => void;

  // ---- time ----
  setSpeed: (s: number) => void;
  togglePause: () => void;
  toggleWarp: () => void;

  // ---- fire support / medevac ----
  setFireSupport: (weaponId: string | null, label?: string, rounds?: number) => void;
  fireAtWorld: (x: number, y: number) => void;
  medevacSelected: () => void;

  // ---- events ----
  resolveEvent: (choiceId: string) => void;
}

const SAVE_KEY = "itm-save-v2";
const SIM_DT = 0.1;
const WARP_SLICES = 700; // game-seconds (×0.1) advanced per warp frame, max

// module-scope loop accumulators (kept out of state to avoid re-renders)
let _acc = 0;
let _lastSyncMs = 0;
let _nowMs = 0;
let _saveTimer = 0;

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
  world: null,
  selection: [],
  orderTool: "select",
  posture: "patrol",
  planning: false,
  planRoute: [],
  planMission: "presence",
  paused: true,
  speed: 4,
  warp: false,
  fireSupport: null,
  tick: 0,
  selectedVillage: null,
  banner: null,
  jacketId: null,
  savedExists: false,
  tutorial: false,
  tutorialStep: 0,

  refreshSave: () => set({ savedExists: hasSaveOnDisk() }),

  newCampaign: (seed, days = 90) => {
    const s = seed && seed.length ? seed : `valley-${Math.floor(performance.now())}`;
    const world = createWorld(s, days);
    _acc = 0;
    set({
      world,
      screen: "deploy",
      selection: [],
      orderTool: "select",
      posture: "patrol",
      planning: false,
      planRoute: [],
      planMission: "presence",
      paused: true,
      speed: 4,
      warp: false,
      fireSupport: null,
      selectedVillage: null,
      banner: null,
      jacketId: null,
      tutorial: false,
      tick: get().tick + 1,
    });
    get().saveCampaign();
  },

  loadCampaign: () => {
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { rngState: number; state: import("@/lib/sim/world").WorldState; units: never };
      const world = loadWorld(parsed as Parameters<typeof loadWorld>[0]);
      _acc = 0;
      set({
        world,
        screen: "deploy",
        selection: [],
        orderTool: "select",
        planning: false,
        planRoute: [],
        paused: true,
        speed: 4,
        warp: false,
        fireSupport: null,
        selectedVillage: null,
        banner: null,
        jacketId: null,
        tutorial: false,
        tick: get().tick + 1,
      });
    } catch {
      /* corrupt save — ignore */
    }
  },

  saveCampaign: () => {
    const { world } = get();
    if (!world || world.state.ended) return;
    try {
      window.localStorage.setItem(SAVE_KEY, JSON.stringify(world.serialize()));
      set({ savedExists: true });
    } catch {
      /* storage full / unavailable */
    }
  },

  gotoMenu: () => {
    get().saveCampaign();
    set({ screen: "menu", tutorial: false });
  },
  resume: () => {
    if (get().world) set({ screen: "deploy" });
  },

  startTutorial: () => {
    get().newCampaign("tutorial-valley", 60);
    set({ tutorial: true, tutorialStep: 0, paused: true });
  },
  tutorialNext: () => set((st) => ({ tutorialStep: st.tutorialStep + 1 })),
  tutorialPrev: () => set((st) => ({ tutorialStep: Math.max(0, st.tutorialStep - 1) })),
  endTutorial: () => set({ tutorial: false }),

  // ------------------------------------------------------------------ frame
  frame: (realDt) => {
    const st = get();
    const w = st.world;
    if (!w) return;
    _nowMs += realDt * 1000;

    if (w.state.ended) {
      clearSaveOnDisk();
      set({ screen: "tourend", savedExists: false, paused: true });
      return;
    }

    const running = !st.paused && !w.pendingEvent;
    if (running) {
      const inContact = w.inContact();
      if (st.warp && !inContact) {
        // skip-to-event warp: advance fast, stop on the first thing that matters
        let n = 0;
        let stop: string | null = null;
        while (n < WARP_SLICES && !w.pendingEvent && !w.state.ended) {
          w.tick(SIM_DT);
          n++;
          const ints = w.drainInterrupts();
          if (ints.length) {
            stop = ints[0];
            break;
          }
        }
        if (stop || w.pendingEvent) {
          set({ warp: false, banner: w.pendingEvent ? w.pendingEvent.title : stop });
        }
      } else {
        const effSpeed = inContact ? Math.min(st.speed, 4) : st.speed;
        _acc += realDt * effSpeed;
        let slices = 0;
        const cap = Math.max(8, Math.ceil(effSpeed / SIM_DT) + 4);
        while (_acc >= SIM_DT && slices < cap) {
          w.tick(SIM_DT);
          _acc -= SIM_DT;
          slices++;
        }
        const ints = w.drainInterrupts();
        if (ints.length) {
          const urgent = ints.find((r) => r.includes("CONTACT") || r.includes("ATTACK") || r.includes("KIA"));
          set({ banner: urgent ?? ints[0] });
        }
        if (st.warp && inContact) set({ warp: false });
      }
    }

    // periodic HUD refresh + autosave
    if (_nowMs - _lastSyncMs > 110) {
      _lastSyncMs = _nowMs;
      _saveTimer += 0.11;
      if (_saveTimer > 25 && running) {
        _saveTimer = 0;
        get().saveCampaign();
      }
      set({ tick: get().tick + 1 });
    }
  },

  // ------------------------------------------------------------------ selection
  selectUnits: (ids, additive) =>
    set((st) => ({ selection: additive ? [...new Set([...st.selection, ...ids])] : ids })),
  setOrderTool: (t) => set({ orderTool: t, fireSupport: null }),
  setPosture: (p) => set({ posture: p }),
  squadIds: (squadId) => {
    const w = get().world;
    if (!w) return [];
    const sq = w.platoon.squads.find((s) => s.id === squadId);
    if (!sq) return [];
    return sq.memberIds.filter((id) => {
      const m = w.platoon.members.find((x) => x.id === id);
      return m && m.alive;
    });
  },

  orderAtWorld: (x, y) => {
    const { world, selection, orderTool, posture } = get();
    if (!world || selection.length === 0) return;
    const point = { x, y };
    const sim = world.sim;
    switch (orderTool) {
      case "move":
        sim.issueOrder(selection, { type: "move", point, technique: posture, pathfind: true });
        break;
      case "assault":
        sim.issueOrder(selection, { type: "assault", point, technique: "traveling", pathfind: true });
        break;
      case "hold":
        sim.issueOrder(selection, { type: "hold", point });
        break;
      case "suppress":
        sim.issueOrder(selection, { type: "suppress", point });
        break;
      case "withdraw":
        sim.issueOrder(selection, { type: "withdraw", point, technique: "rush", pathfind: true });
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
        sim.issueOrder(selection, { type: "move", point, technique: posture, pathfind: true });
    }
    set({ tick: get().tick + 1 });
  },

  orderTarget: (enemyId) => {
    const { world, selection } = get();
    if (!world || selection.length === 0) return;
    world.sim.issueOrder(selection, { type: "engage", targetId: enemyId });
    set({ tick: get().tick + 1 });
  },

  // ------------------------------------------------------------------ planning
  setPlanning: (on) => set({ planning: on, selectedVillage: on ? null : get().selectedVillage }),
  setMission: (m) => set({ planMission: m }),
  addWaypoint: (cx, cy) => set((st) => ({ planRoute: [...st.planRoute, { cx, cy }] })),
  popWaypoint: () => set((st) => ({ planRoute: st.planRoute.slice(0, -1) })),
  clearRoute: () => set({ planRoute: [] }),

  stepOff: () => {
    const { world, selection, planRoute, planMission, posture } = get();
    if (!world || selection.length === 0 || planRoute.length === 0) return;
    const task = world.formPatrol(selection, planRoute, planMission, posture);
    if (task) {
      set({ planRoute: [], planning: false, banner: `${task.label} ordered`, tick: get().tick + 1 });
      get().saveCampaign();
    }
  },

  // ------------------------------------------------------------------ village / COIN
  selectVillage: (id) => set({ selectedVillage: id, planning: false }),
  conductKLE: (villageId) => {
    const { world, selection, posture } = get();
    if (!world) return;
    const ids = selection.length ? selection : world.platoon.squads.find((s) => s.id === "hq")?.memberIds ?? [];
    const t = world.conductKLE(ids, villageId, posture);
    if (t) set({ banner: t.label, tick: get().tick + 1 });
    get().saveCampaign();
  },
  fundProject: (villageId, type) => {
    const { world } = get();
    if (!world) return;
    const p = world.startProject(villageId, type);
    if (p) set({ tick: get().tick + 1 });
    get().saveCampaign();
  },
  requestResupply: (kind) => {
    const { world } = get();
    if (!world) return;
    world.requestResupply(kind);
    set({ tick: get().tick + 1 });
  },
  recallTask: (taskId) => {
    const { world } = get();
    if (!world) return;
    world.recall(taskId);
    set({ tick: get().tick + 1 });
  },
  setJacket: (id) => set({ jacketId: id }),

  // ------------------------------------------------------------------ time
  setSpeed: (s) => set({ paused: false, speed: s, warp: false }),
  togglePause: () => {
    const paused = !get().paused;
    set({ paused });
    if (paused) get().saveCampaign();
  },
  toggleWarp: () => set((st) => ({ warp: !st.warp, paused: false })),

  // ------------------------------------------------------------------ fire support
  setFireSupport: (weaponId, label, rounds) =>
    set({ fireSupport: weaponId ? { weaponId, label: label ?? weaponId, rounds: rounds ?? 4 } : null, orderTool: "select" }),
  fireAtWorld: (x, y) => {
    const { world, fireSupport } = get();
    if (!world || !fireSupport) return;
    const point = { x, y };
    if (fireSupport.weaponId === "cas_gun" || fireSupport.weaponId === "cas_rocket") {
      world.requestCAS(point, fireSupport.weaponId as "cas_gun" | "cas_rocket");
    } else {
      world.requestFireMission(fireSupport.weaponId, point, fireSupport.rounds);
    }
    set({ fireSupport: null, tick: get().tick + 1 });
  },
  medevacSelected: () => {
    const { world, selection } = get();
    if (!world) return;
    for (const id of selection) {
      const u = world.sim.unit(id);
      if (u && (!u.conscious || u.wounds.length > 0)) world.medevac(id);
    }
    set({ tick: get().tick + 1 });
  },

  // ------------------------------------------------------------------ events
  resolveEvent: (choiceId) => {
    const { world } = get();
    if (!world || !world.pendingEvent) return;
    applyWorldEventChoice(world, world.pendingEvent, choiceId);
    set({ tick: get().tick + 1 });
    get().saveCampaign();
  },
}));

// Debug handle.
if (typeof window !== "undefined") {
  (window as unknown as { __ITM?: typeof useGame }).__ITM = useGame;
}
