"use client";
import { create } from "zustand";
import { World, createWorld, loadWorld, applyWorldEventChoice, MissionType, SquadSOP, defaultSOP } from "@/lib/sim/world";

export type Screen = "menu" | "deploy" | "tourend";

export const SPEEDS = [1, 2, 4, 8, 16];

const DEFAULT_SOP: SquadSOP = { movement: "patrol", contact: "hold", roe: "tight" };

interface GameStore {
  screen: Screen;
  world: World | null;

  // squad command — you command fixed squads, never individual soldiers
  activeSquadId: string | null;
  attachOfficers: boolean; // include the HQ officer/enabler element with the next patrol

  // patrol planning
  planning: boolean;
  planRoute: { cx: number; cy: number }[];
  planMission: MissionType;
  planSOP: SquadSOP; // the standing SOP the next patrol steps off with

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

  // ---- panel layout (left + right dock columns; localStorage-backed) ----
  layout: PanelLayout;
  togglePanel: (id: string) => void;
  setPanelHeight: (id: string, px: number) => void; // transient; persists on pointer-up
  persistPanelLayout: () => void; // call on pointer-up / after toggle
  markCombatSeen: (maxId: number) => void;

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

  // ---- squad selection (you pick which fixed squad to command, never a man) ----
  selectSquad: (squadId: string | null) => void;
  toggleOfficers: () => void;
  squadIds: (squadId: string) => string[];
  patrolIds: () => string[]; // ready members of the active squad (+ officers if attached)

  // ---- patrol planning ----
  setPlanning: (on: boolean) => void;
  setMission: (m: MissionType) => void;
  setPlanSOP: (patch: Partial<SquadSOP>) => void;
  addWaypoint: (cx: number, cy: number) => void;
  popWaypoint: () => void;
  clearRoute: () => void;
  stepOff: () => void;
  reroute: () => void; // re-route the active squad's task to the drawn waypoints
  setSquadSOP: (taskId: number, sop: SquadSOP) => boolean; // edit a deployed squad's SOP (locked in contact)

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
  approveFires: () => void; // approve the squad AI's pending call-for-fire
  denyFires: () => void;
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
// Rising-edge latch for "troops in contact": TIC is a ONE-WAY switch to 1× real time.
let _wasInContact = false;

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

// ---- UI chrome layout (per-device preference, NOT part of the campaign save) ----
const LAYOUT_KEY = "itm-ui-v1";
export interface PanelLayout {
  collapsed: Record<string, boolean>;
  heights: Record<string, number>;
  seenCombatId: number;
}
function loadLayout(): PanelLayout {
  const base: PanelLayout = { collapsed: {}, heights: {}, seenCombatId: 0 };
  try {
    if (typeof window === "undefined") return base;
    const r = window.localStorage.getItem(LAYOUT_KEY);
    if (!r) return base;
    const p = JSON.parse(r) as Partial<PanelLayout>;
    return { collapsed: p.collapsed ?? {}, heights: p.heights ?? {}, seenCombatId: p.seenCombatId ?? 0 };
  } catch {
    return base;
  }
}
function persistLayout(l: PanelLayout) {
  try {
    window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* full / unavailable */
  }
}

export const useGame = create<GameStore>((set, get) => ({
  screen: "menu",
  world: null,
  activeSquadId: null,
  attachOfficers: false,
  planning: false,
  planRoute: [],
  planMission: "presence",
  planSOP: DEFAULT_SOP,
  paused: true,
  speed: 4,
  warp: false,
  fireSupport: null,
  tick: 0,
  selectedVillage: null,
  banner: null,
  jacketId: null,
  layout: loadLayout(),
  savedExists: false,
  tutorial: false,
  tutorialStep: 0,

  refreshSave: () => set({ savedExists: hasSaveOnDisk() }),

  newCampaign: (seed, days = 90) => {
    const s = seed && seed.length ? seed : `valley-${Math.floor(performance.now())}`;
    const world = createWorld(s, days);
    _acc = 0;
    _wasInContact = false;
    set({
      world,
      screen: "deploy",
      activeSquadId: "sq1",
      attachOfficers: false,
      planning: false,
      planRoute: [],
      planMission: "presence",
      planSOP: DEFAULT_SOP,
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
      _wasInContact = false;
      set({
        world,
        screen: "deploy",
        activeSquadId: "sq1",
        attachOfficers: false,
        planning: false,
        planRoute: [],
        planSOP: DEFAULT_SOP,
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
      // TIC is a ONE-WAY switch. The instant a squad goes into contact, drop the
      // time compression to 1× real-time and leave it there. We do NOT restore the
      // pre-contact speed afterward — that auto-restore is what made the clock lurch
      // (16× → clamp 4× → pop back to 16× as contact flickered). After the drop the
      // player owns the speed control again; we simply never bump it back up for them.
      let speed = st.speed;
      let warp = st.warp;
      if (inContact && !_wasInContact && (speed !== 1 || warp)) {
        speed = 1;
        warp = false;
        set({ speed: 1, warp: false });
      }
      _wasInContact = inContact;

      if (warp && !inContact) {
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
        // In combat the clock is already latched to 1× above; the Math.min is a
        // belt-and-suspenders cap if the player manually nudges speed up mid-fight
        // (combat sim stays stable up to 4×). Out of contact it runs at the set speed.
        const effSpeed = inContact ? Math.min(speed, 4) : speed;
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
        // Reaching this branch with warp still set means we're in contact (warp can't
        // run during a firefight) — clear it so the warp toggle never sticks "on".
        if (warp) set({ warp: false });
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

  // ------------------------------------------------------------------ squad selection
  // Selecting a different squad drops any half-drawn route so it can't be applied to the wrong squad.
  selectSquad: (squadId) => set({ activeSquadId: squadId, selectedVillage: null, planRoute: [], planning: false }),
  toggleOfficers: () => set((st) => ({ attachOfficers: !st.attachOfficers })),
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
  patrolIds: () => {
    const { world, activeSquadId, attachOfficers } = get();
    if (!world || !activeSquadId) return [];
    // a soldier already out on a task is not available to be sent again
    const busy = new Set(world.state.tasks.flatMap((t) => (t.phase !== "complete" ? t.memberIds : [])));
    const ready = (id: string) => {
      const m = world.platoon.members.find((x) => x.id === id);
      return !!m && m.alive && (m.status === "ready" || m.status === "rest") && !busy.has(id);
    };
    const ids = (world.platoon.squads.find((s) => s.id === activeSquadId)?.memberIds ?? []).filter(ready);
    if (attachOfficers && activeSquadId !== "hq") {
      const off = world.platoon.squads.find((s) => s.id === "hq")?.memberIds.filter(ready) ?? [];
      return [...new Set([...ids, ...off])];
    }
    return ids;
  },

  // ------------------------------------------------------------------ planning
  setPlanning: (on) => set({ planning: on, selectedVillage: on ? null : get().selectedVillage }),
  setMission: (m) => set((st) => ({ planMission: m, planSOP: { ...defaultSOP(m), roe: st.planSOP.roe } })),
  setPlanSOP: (patch) => set((st) => ({ planSOP: { ...st.planSOP, ...patch } })),
  addWaypoint: (cx, cy) => set((st) => ({ planRoute: [...st.planRoute, { cx, cy }] })),
  popWaypoint: () => set((st) => ({ planRoute: st.planRoute.slice(0, -1) })),
  clearRoute: () => set({ planRoute: [] }),

  stepOff: () => {
    const { world, planRoute, planMission, planSOP } = get();
    if (!world || planRoute.length === 0) return;
    const ids = get().patrolIds();
    if (ids.length === 0) return;
    // formPatrol derives the movement technique from the SOP; the 4th arg is a fallback only.
    const task = world.formPatrol(ids, planRoute, planMission, "patrol", planSOP);
    if (task) {
      set({ planRoute: [], planning: false, banner: `${task.label} ordered`, tick: get().tick + 1 });
      get().saveCampaign();
    }
  },

  reroute: () => {
    const { world, activeSquadId, planRoute } = get();
    if (!world || !activeSquadId || planRoute.length === 0) return;
    // match against the squad's FULL roster (not alive-only) so an all-casualty squad whose
    // attached officers keep the task alive still finds and re-routes its task.
    const sq = world.platoon.squads.find((s) => s.id === activeSquadId);
    if (!sq) return;
    const task = world.state.tasks.find((t) => sq.memberIds.some((id) => t.memberIds.includes(id)));
    if (task && world.reroute(task.id, planRoute)) {
      set({ planRoute: [], planning: false, banner: `${task.label} re-routed`, tick: get().tick + 1 });
      get().saveCampaign();
    }
  },

  setSquadSOP: (taskId, sop) => {
    const { world } = get();
    if (!world) return false;
    const ok = world.setSOP(taskId, sop);
    if (ok) set({ tick: get().tick + 1 });
    return ok;
  },

  // ------------------------------------------------------------------ village / COIN
  selectVillage: (id) => set({ selectedVillage: id, planning: false }),
  conductKLE: (villageId) => {
    const { world } = get();
    if (!world) return;
    // never pull a squad off an in-progress task: only free, ready members go to the shura.
    const busy = new Set(world.state.tasks.flatMap((t) => (t.phase !== "complete" ? t.memberIds : [])));
    const readyFree = (id: string) => {
      const m = world.platoon.members.find((x) => x.id === id);
      return !!m && m.alive && (m.status === "ready" || m.status === "rest") && !busy.has(id);
    };
    const sel = get().patrolIds(); // busy-aware; empty if the active squad is already deployed
    const ids = sel.length ? sel : world.platoon.squads.find((s) => s.id === "hq")?.memberIds.filter(readyFree) ?? [];
    if (ids.length === 0) {
      set({ banner: "No element free for a key-leader engagement." });
      return;
    }
    const t = world.conductKLE(ids, villageId, "patrol");
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

  // ------------------------------------------------------------------ panel layout
  togglePanel: (id) => {
    set((st) => ({ layout: { ...st.layout, collapsed: { ...st.layout.collapsed, [id]: !st.layout.collapsed[id] } } }));
    persistLayout(get().layout);
  },
  setPanelHeight: (id, px) => set((st) => ({ layout: { ...st.layout, heights: { ...st.layout.heights, [id]: px } } })),
  persistPanelLayout: () => persistLayout(get().layout),
  markCombatSeen: (maxId) => {
    if (maxId <= get().layout.seenCombatId) return;
    set((st) => ({ layout: { ...st.layout, seenCombatId: maxId } }));
    persistLayout(get().layout);
  },

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
    set({ fireSupport: weaponId ? { weaponId, label: label ?? weaponId, rounds: rounds ?? 4 } : null }),
  approveFires: () => {
    const { world } = get();
    if (!world) return;
    if (world.approveFireRequest()) set({ banner: "Cleared hot — rounds inbound.", tick: get().tick + 1 });
  },
  denyFires: () => {
    const { world } = get();
    if (!world) return;
    world.denyFireRequest();
    set({ tick: get().tick + 1 });
  },
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
  // Command-level 9-line: under hands-off combat the AI surfaces a CASUALTY callout and
  // the player calls the bird for whoever is down in the field (no individual selection).
  medevacSelected: () => {
    const { world } = get();
    if (!world) return;
    let any = false;
    for (const u of world.sim.units) {
      if ((u.faction === "us" || u.faction === "ana") && u.alive && !u.evac && (!u.conscious || u.bleedRate > 0.3)) {
        world.medevac(u.id);
        any = true;
      }
    }
    if (any) set({ banner: "MEDEVAC requested", tick: get().tick + 1 });
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
