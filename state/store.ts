"use client";
import { create } from "zustand";
import { World, createWorld, createTerrain, loadWorld, applyWorldEventChoice, MissionType, SquadSOP, defaultSOP } from "@/lib/sim/world";
// Render-cache pre-warm: the bridge owns the deploy moment, so it warms the renderer's
// caches (the 4096² terrain bake + the 164-asset sprite atlas) DURING the loading screen,
// where the cost is visible and narrated — instead of freezing the first deploy frame.
import { bakeTerrainProgressive } from "@/lib/render/topo";
import { loadSprites } from "@/lib/render/sprites";
import { ASSETS } from "@/lib/render/asset-manifest.generated";
// Procedural audio is a RENDER-SIDE OBSERVER (like lib/render/combat-fx.ts): the bridge owns
// the real-time loop, so it drives the audio tick. lib/sim imports NOTHING from lib/audio.
import { AudioEngine, AUDIO_CATEGORIES, type AudioCategory } from "@/lib/audio";

export type Screen = "menu" | "loading" | "deploy" | "tourend";

// ---- deploy loading feedback (a generation phase the player watches happen) ----
export type LoadStatus = "pending" | "active" | "done";
export interface LoadStep {
  id: string;
  label: string;
  status: LoadStatus;
}
export interface LoadProgress {
  title: string; // headline: DEPLOYING / RESUMING COMMAND
  sub: string; // seed · tour length
  pct: number; // 0..1 overall
  steps: LoadStep[];
  flavor: string; // a field-manual line, for atmosphere while the valley builds
}

export const SPEEDS = [1, 2, 4, 8, 16];

// ---- transient command feedback (toasts) ----
// A severity-typed, auto-expiring acknowledgement for every player command — so an
// action like a $5k CERP grant or a resupply call reads as DONE, not a dead click.
// Pure UI state (never touches the campaign save). Aged off in frame() by _nowMs.
export type ToastSev = "good" | "info" | "warn" | "crit";
export interface Toast {
  id: number;
  text: string;
  sev: ToastSev;
  born: number; // _nowMs at creation
}
const TOAST_TTL_MS = 4500;
const TOAST_MAX = 4;
let _toastId = 0;

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
  toasts: Toast[];
  pushToast: (text: string, sev?: ToastSev) => void;
  dismissToast: (id: number) => void;
  helpOpen: boolean; // transient: the keyboard-shortcut / controls reference overlay
  toggleHelp: (on?: boolean) => void;
  rosterSquadId: string | null; // transient: which squad's soldier roster is open in a modal
  setRoster: (id: string | null) => void;
  jacketId: string | null;
  loadProgress: LoadProgress | null; // non-null while the deploy/loading screen is up

  // ---- panel layout (left + right dock columns; localStorage-backed) ----
  layout: PanelLayout;
  togglePanel: (id: string) => void;
  setPanelHeight: (id: string, px: number) => void; // transient; persists on pointer-up
  persistPanelLayout: () => void; // call on pointer-up / after toggle
  markCombatSeen: (maxId: number) => void;

  // ---- audio (UI preference; persisted in itm-ui-v1, NOT the campaign save) ----
  audioMuted: boolean;
  audioVolume: number;
  audioCats: Record<AudioCategory, { v: number; on: boolean }>; // per-category volume + on/off
  setAudioVolume: (v: number) => void;
  toggleAudioMute: () => void;
  setAudioCatVolume: (cat: AudioCategory, v: number) => void;
  toggleAudioCat: (cat: AudioCategory) => void;

  // ---- call-for-fire auto-pause (UI preference; itm-ui-v1, NOT the campaign save) ----
  autoPauseOnFire: boolean;
  toggleAutoPauseOnFire: () => void;

  // save
  savedExists: boolean;
  refreshSave: () => void;

  // tutorial
  tutorial: boolean;
  tutorialStep: number;

  // ---- lifecycle ----
  // Generation is staged across paint-yielding phases (see runDeploy) so the player gets a
  // loading screen instead of a frozen button — hence these return promises now.
  newCampaign: (seed?: string, days?: number, tutorial?: boolean) => Promise<void>;
  loadCampaign: () => Promise<void>;
  saveCampaign: () => void;
  gotoMenu: () => void;
  resume: () => void;
  startTutorial: () => Promise<void>;
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
  secureBuild: (villageId: string) => void; // assign the active squad to garrison a project site
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
// Rising-edge latch for a NEW call-for-fire: when one appears we auto-PAUSE (if the player has
// the option on) so the commander reads the call before the rounds matter — an urgency cue, not a
// speed change. We deliberately do NOT auto-restore speed after (TIC's drop is the one-way latch
// that owns speed); the latch only fires on the 0→1 edge so a standing request never re-pauses.
let _hadFireRequest = false;

/**
 * The sub-tick interpolation fraction: how far (0..1) wall-time has advanced into the NEXT
 * 0.1 s sim tick, i.e. the accumulator remainder the fixed-timestep loop leaves behind. The
 * renderer reads this to INTERPOLATE fast combat motion (projectile position, transient-effect
 * age) between the previous and current tick — so a 880 m/s round that the sim only places at
 * ~3 discrete points over its flight sweeps smoothly at 60 fps instead of teleporting, and a
 * 0.12 s muzzle flash fades across its whole on-screen life instead of being born already
 * aged-out. It is a pure READ of loop state (Law 7: render never writes sim); paused ⇒ no tick
 * ⇒ _acc frozen ⇒ frac frozen (motion stops cleanly). WorldView passes it into the draw calls;
 * draw.ts never imports the store (the render layer stays React-free).
 */
export const getSimFrac = () => Math.max(0, Math.min(1, _acc / SIM_DT));

// The single render-side audio engine (module-scope, mirrors combat-fx.ts's module state).
// SSR-safe: it touches no browser global until unlock() runs inside a user gesture. WorldView
// grabs it via getAudio() to push the camera each RAF and wire the unlock-on-gesture listener.
const audio = new AudioEngine();
export const getAudio = () => audio;

/** Hand the audio engine the new world's terrain (for LOS occlusion) + the static positions the
 *  ambient bed needs (COP generator, village wildlife/adhan, river burble). Called once per deploy
 *  /load — a render-side READ of sim state (Law 7: never the reverse). */
function wireAudioWorld(w: World): void {
  audio.setTerrain(w.terrain);
  audio.setWorldStatics({
    copPos: w.terrain.cellCenter(w.terrain.copCell.cx, w.terrain.copCell.cy),
    villages: w.terrain.villages.map((v) => w.terrain.cellCenter(v.cx, v.cy)),
    river: w.terrain.riverPoints(24),
  });
}

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
  // Audio is a per-device UI preference — it lives in the UI-layout blob (itm-ui-v1), NOT the
  // campaign save (itm-save-v2), so it never enters the save-migration path (the two-localStorage
  // gotcha). Default volume 0.6, unmuted: the player who turns sound on should get the genre.
  audioMuted: boolean;
  audioVolume: number;
  // Per-CATEGORY mixer (combat/ambience/radio/alerts): volume 0..1 + on/off, so a player can e.g.
  // keep the war but silence the wildlife. Same blob, same per-device semantics as audioVolume.
  audioCats: Record<AudioCategory, { v: number; on: boolean }>;
  // Auto-pause the clock the instant the AI raises a NEW call-for-fire, so the commander reads the
  // call before clearing/denying. A UI preference (same blob as audio), default ON — it's the
  // urgency cue that makes the approve/deny lever land. It NEVER restores speed afterward.
  autoPauseOnFire: boolean;
}
const AUDIO_VOLUME_DEFAULT = 0.6;
function defaultAudioCats(): PanelLayout["audioCats"] {
  return { combat: { v: 1, on: true }, ambience: { v: 1, on: true }, radio: { v: 1, on: true }, alerts: { v: 1, on: true } };
}
function loadLayout(): PanelLayout {
  const base: PanelLayout = { collapsed: {}, heights: {}, seenCombatId: 0, audioMuted: false, audioVolume: AUDIO_VOLUME_DEFAULT, audioCats: defaultAudioCats(), autoPauseOnFire: true };
  try {
    if (typeof window === "undefined") return base;
    const r = window.localStorage.getItem(LAYOUT_KEY);
    if (!r) return base;
    const p = JSON.parse(r) as Partial<PanelLayout>;
    // merge categories per key so a future category gets its default instead of undefined.
    const cats = defaultAudioCats();
    for (const c of AUDIO_CATEGORIES) {
      const saved = p.audioCats?.[c];
      if (saved) cats[c] = { v: typeof saved.v === "number" ? Math.max(0, Math.min(1, saved.v)) : 1, on: saved.on !== false };
    }
    return {
      collapsed: p.collapsed ?? {},
      heights: p.heights ?? {},
      seenCombatId: p.seenCombatId ?? 0,
      audioMuted: p.audioMuted ?? false,
      audioVolume: typeof p.audioVolume === "number" ? p.audioVolume : AUDIO_VOLUME_DEFAULT,
      audioCats: cats,
      autoPauseOnFire: p.autoPauseOnFire ?? true,
    };
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

// ---- deploy staging ---------------------------------------------------------------
// The deploy work (terrain gen + the 4096² relief bake + 164 sprite rasters) is several
// hundred ms of synchronous main-thread work. Done in one click handler it freezes the UI
// with no feedback. runDeploy splits it into phases and YIELDS TO A REAL BROWSER PAINT
// before each one, so the loading screen renders the active phase (and its spinner keeps
// turning — it's a GPU transform) *before* the blocking work runs. Each phase is honest:
// it names a real cost centre the player is waiting on.
type SetGame = (partial: Partial<GameStore>) => void;

// Field-manual / first-hand lines shown under the title while the valley builds.
const DEPLOY_FLAVORS = [
  "“The terrain is the enemy. Learn it before he does.”",
  "“Every ridgeline is someone’s high ground. Make it yours.”",
  "“You can win every firefight and still lose the valley.”",
  "“The hardest part of command is watching.”",
  "“Patience is a weapon system. Shuras win more than rifles.”",
  "“Know where the dead ground is. So does he.”",
  "“No two valleys are the same. Read this one.”",
];
function pickFlavor(): string {
  // performance.now keeps it varied per deploy without Math.random (and SSR-safe enough —
  // this only runs in a click handler on the client).
  const t = typeof performance !== "undefined" ? performance.now() : 0;
  return DEPLOY_FLAVORS[Math.floor(t) % DEPLOY_FLAVORS.length];
}

// Wait for the browser to actually PAINT the current state. A single rAF fires before paint;
// double-rAF guarantees the previous commit has hit the screen, so the loading screen and the
// "active" phase are visible before we block the thread on heavy work.
const nextPaint = (): Promise<void> =>
  typeof requestAnimationFrame === "undefined"
    ? Promise.resolve()
    : new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

interface DeployPhase {
  id: string;
  label: string;
  // `report(frac)` lets a long phase (the relief bake) advance the bar smoothly within its
  // slice of the overall progress, instead of the bar sitting frozen for the whole phase.
  run: (report: (frac: number) => void) => void | Promise<void>;
}

async function runDeploy(
  set: SetGame,
  meta: { title: string; sub: string },
  phases: DeployPhase[],
  finalize: () => void,
): Promise<void> {
  const flavor = pickFlavor();
  const steps: LoadStep[] = phases.map((p) => ({ id: p.id, label: p.label, status: "pending" }));
  const snap = (pct: number) =>
    set({ loadProgress: { ...meta, pct, flavor, steps: steps.map((s) => ({ ...s })) } });

  set({ screen: "loading" });
  snap(0);
  await nextPaint(); // let the loading screen itself paint before anything heavy

  try {
    for (let i = 0; i < phases.length; i++) {
      steps[i].status = "active";
      snap(i / phases.length);
      await nextPaint(); // paint the active row + spinner BEFORE the (often blocking) work
      // overall pct = completed phases + this phase's own fraction, all over the phase count.
      await phases[i].run((frac) => snap((i + Math.max(0, Math.min(1, frac))) / phases.length));
      steps[i].status = "done";
      snap((i + 1) / phases.length);
    }
  } catch (e) {
    // A generation failure must never strand the player on a frozen loading screen.
    console.error("[deploy] generation failed:", e);
    set({ screen: "menu", loadProgress: null });
    return;
  }

  await nextPaint(); // let the 100%/all-green state register for a beat, then swap in the game
  finalize();
}

// The render-cache pre-warm phases shared by every deploy path: bake the relief into the
// WeakMap drawTerrain reads, then rasterize the sprite atlas. After these, the first deploy
// frame is a pure cache hit — no first-frame freeze.
// One-shot probe: can we get a WebGL2 context? Decides whether the deploy warm-bake produces
// the unlit albedo (GL underlayer) or the lit relief (2D fallback) — must agree with TerrainGL.
let _webgl2: boolean | null = null;
function webgl2Available(): boolean {
  if (_webgl2 !== null) return _webgl2;
  try {
    _webgl2 = typeof document !== "undefined" && !!document.createElement("canvas").getContext("webgl2");
  } catch {
    _webgl2 = false;
  }
  return _webgl2;
}

function renderWarmPhases(getWorld: () => World): DeployPhase[] {
  return [
    // The relief bake is the long pole (~seconds, 16 M shaded pixels) — bake it progressively
    // so the bar fills smoothly through it, and cache it so the first deploy frame is instant.
    // On the WebGL path the underlayer samples the UNLIT albedo, so bake that (else the first
    // GL frame would synchronously bake it — a multi-second hitch). On the 2D fallback bake the
    // lit relief as before. One probe decides which (matches TerrainGL's webgl2 availability).
    { id: "relief", label: "Surveying the relief — baking the topographic map", run: async (report) => { await bakeTerrainProgressive(getWorld().terrain, report, !webgl2Available()); } },
    { id: "assets", label: "Issuing kit — rasterizing the asset library", run: () => loadSprites(ASSETS) },
  ];
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
  toasts: [],
  pushToast: (text, sev = "info") =>
    set((s) => ({ toasts: [...s.toasts, { id: ++_toastId, text, sev, born: _nowMs }].slice(-TOAST_MAX) })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  helpOpen: false,
  toggleHelp: (on) => set((s) => ({ helpOpen: on ?? !s.helpOpen })),
  rosterSquadId: null,
  setRoster: (id) => set({ rosterSquadId: id }),
  jacketId: null,
  loadProgress: null,
  layout: loadLayout(),
  savedExists: false,
  tutorial: false,
  tutorialStep: 0,
  // mirror the persisted UI-layout audio prefs into top-level slots for easy HUD subscription;
  // the engine is synced to them on the first user gesture (it has no context before unlock).
  audioMuted: loadLayout().audioMuted,
  audioVolume: loadLayout().audioVolume,
  audioCats: loadLayout().audioCats,
  // call-for-fire auto-pause preference, mirrored top-level for HUD subscription (read in frame()).
  autoPauseOnFire: loadLayout().autoPauseOnFire,

  refreshSave: () => set({ savedExists: hasSaveOnDisk() }),

  newCampaign: async (seed, days = 90, tutorial = false) => {
    const s = seed && seed.length ? seed : `valley-${Math.floor(performance.now())}`;
    _acc = 0;
    _wasInContact = false;
    _hadFireRequest = false;
    let terrain!: ReturnType<typeof createTerrain>;
    let world!: World;
    await runDeploy(
      set,
      { title: tutorial ? "BEGINNING THE WALK-THROUGH" : "DEPLOYING", sub: `${s} · ${days}-day tour` },
      [
        // Phase 1 is the heavy one (~200 ms heightmap). Phase 2 (~40 ms) musters the platoon,
        // reads the villages, populates the valley and stands up the COP — reusing the terrain
        // from phase 1 (byte-identical to the one-shot path; verified).
        { id: "valley", label: "Carving the valley — ridgelines, draws, and the river", run: () => { terrain = createTerrain(s); } },
        { id: "muster", label: "Mustering the platoon; reading the villages; standing up COP Vimoto", run: () => { world = createWorld(s, days, terrain); } },
        ...renderWarmPhases(() => world),
      ],
      () => {
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
          tutorial,
          tutorialStep: 0,
          loadProgress: null,
          tick: get().tick + 1,
        });
        wireAudioWorld(world);
        get().saveCampaign();
      },
    );
  },

  loadCampaign: async () => {
    let parsed: Parameters<typeof loadWorld>[0] | null = null;
    try {
      const raw = window.localStorage.getItem(SAVE_KEY);
      if (!raw) return;
      parsed = JSON.parse(raw) as Parameters<typeof loadWorld>[0];
    } catch {
      return; // corrupt / unreadable save — stay on the menu
    }
    _acc = 0;
    _wasInContact = false;
    _hadFireRequest = false;
    let world!: World;
    await runDeploy(
      set,
      { title: "RESUMING COMMAND", sub: "restoring the deployment record" },
      [
        { id: "restore", label: "Reading the deployment record; rebuilding the valley", run: () => { world = loadWorld(parsed!); } },
        ...renderWarmPhases(() => world),
      ],
      () => {
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
          loadProgress: null,
          tick: get().tick + 1,
        });
        wireAudioWorld(world);
      },
    );
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

  startTutorial: async () => {
    // newCampaign now carries the tutorial flag through the loading screen and sets
    // tutorial/tutorialStep/paused in its finalize, so the coach is live the moment deploy shows.
    await get().newCampaign("tutorial-valley", 60, true);
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

    // age off expired toasts (only write state when the set actually shrinks → no churn)
    if (st.toasts.length) {
      const live = st.toasts.filter((t) => _nowMs - t.born < TOAST_TTL_MS);
      if (live.length !== st.toasts.length) set({ toasts: live });
    }

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
          // each sim interrupt becomes a severity-typed toast (they stack, newest on top,
          // and no longer stomp one another the way the single banner string did)
          for (const r of ints) {
            const crit = r.includes("CONTACT") || r.includes("ATTACK") || r.includes("KIA") || r.includes("WIA");
            get().pushToast(r, crit ? "crit" : "info");
          }
        }
        // Reaching this branch with warp still set means we're in contact (warp can't
        // run during a firefight) — clear it so the warp toggle never sticks "on".
        if (warp) set({ warp: false });
      }
    }

    // CALL-FOR-FIRE AUTO-PAUSE: latch the 0→1 edge of a pending fire request and PAUSE on it
    // (when the player has the option on) so the commander reads the call before clearing/denying.
    // Tracked every frame so toggling the option mid-flight can't replay a stale edge; only the
    // rising edge pauses (a standing request never re-pauses). We pause ONLY — never touch speed
    // (TIC owns the one-way speed drop) and never auto-restore. Banner makes the call unmissable.
    const hasFireReq = !!w.state.fireRequest;
    if (hasFireReq && !_hadFireRequest && get().autoPauseOnFire && !get().paused) {
      set({ paused: true, banner: `▲ CALL FOR FIRE — ${w.state.fireRequest!.label}: clear or deny` });
    }
    _hadFireRequest = hasFireReq;

    // AUDIO: a render-side observer of the just-ticked sim. Always called so the mapper's
    // high-water marks never go stale (identical to noteCombatEffects running every frame);
    // the engine SCHEDULES sound only when running & !paused & !warp. Pos/pan come from the
    // camera WorldView pushes each RAF. The combat log/effects/fire-missions are the seam.
    // Read warp/paused FRESH (post-set): the contact-latch may have just cleared warp this
    // frame (TIC kicking off a firefight), and the audio gate must reflect that — otherwise
    // the firefight's first frame would be silenced by the stale `st.warp` captured up top.
    const af = get();
    const nowContact = w.inContact();
    const wx = w.state.weather;
    audio.tick(
      { effects: w.sim.effects, log: w.sim.log, fireMissions: w.sim.fireMissions, inContact: nowContact },
      { running, paused: af.paused, warp: af.warp, inContact: nowContact },
      // ambient bed env — all deterministic World getters; the engine adds the camera-relative bits.
      { secondsOfDay: w.secondsOfDay, solar: w.solarLight(), isNight: w.isNight(), windSpeed: wx.wind, weatherLabel: wx.label, precip: wx.precip, inContact: nowContact },
    );

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
      // BOOTS-PAUSED FIX (#31): the deploy screen comes up PAUSED so the player can plan the
      // first patrol with the clock stopped. The moment they step an element off, the clock must
      // RUN — leaving it paused made the game look frozen ("I gave the order and nothing happened").
      // We only un-pause; we never touch speed/warp here (TIC's one-way latch and the player's
      // speed choice are owned elsewhere). Re-pausing later is still the player's call (Space).
      set({ paused: false, planRoute: [], planning: false, tick: get().tick + 1 });
      get().pushToast(`${task.label} — stepping off`, "info");
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
      set({ planRoute: [], planning: false, tick: get().tick + 1 });
      get().pushToast(`${task.label} re-routed`, "info");
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
      get().pushToast("No element free for a key-leader engagement.", "warn");
      return;
    }
    const t = world.conductKLE(ids, villageId, "patrol");
    if (t) { set({ tick: get().tick + 1 }); get().pushToast(`☕ ${t.label}`, "good"); }
    get().saveCampaign();
  },
  fundProject: (villageId, type) => {
    const { world } = get();
    if (!world) return;
    const v = world.state.villages.find((x) => x.id === villageId);
    const p = world.startProject(villageId, type);
    if (p) {
      set({ tick: get().tick + 1 });
      get().pushToast(`CERP approved — ${type} at ${v?.name ?? "village"} ($5k). Secure the site.`, "good");
    } else {
      get().pushToast(`Can't fund ${type} — check CERP balance or an active project.`, "warn");
    }
    get().saveCampaign();
  },
  // Assign the active squad to SECURE a project site (the patrol-level "garrison this build"
  // order — TARGET 1). Mirrors conductKLE: only free/ready members of the active squad go, the
  // World API does the reachability-aware routing + open-ended hold (NO map-canvas gesture, NO
  // beeline). Like Step Off it un-pauses the clock — committing an element starts time running.
  secureBuild: (villageId) => {
    const { world } = get();
    if (!world) return;
    const ids = get().patrolIds(); // busy-aware ready members of the active squad (+officers if attached)
    if (ids.length === 0) {
      get().pushToast("No element free to secure the site.", "warn");
      return;
    }
    const t = world.secureBuild(ids, villageId, "tactical", get().planSOP);
    if (t) { set({ paused: false, tick: get().tick + 1 }); get().pushToast(`🛡 ${t.label}`, "good"); }
    get().saveCampaign();
  },
  requestResupply: (kind) => {
    const { world } = get();
    if (!world) return;
    world.requestResupply(kind);
    set({ tick: get().tick + 1 });
    get().pushToast(`${kind === "air" ? "Air" : "Convoy"} resupply requested — inbound.`, "info");
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

  // ------------------------------------------------------------------ audio prefs
  setAudioVolume: (v) => {
    const vol = Math.max(0, Math.min(1, v));
    audio.setMasterVolume(vol);
    set((st) => ({ audioVolume: vol, layout: { ...st.layout, audioVolume: vol } }));
    persistLayout(get().layout); // itm-ui-v1 only — never the campaign save
  },
  toggleAudioMute: () => {
    const muted = !get().audioMuted;
    audio.setMuted(muted);
    set((st) => ({ audioMuted: muted, layout: { ...st.layout, audioMuted: muted } }));
    persistLayout(get().layout);
  },
  setAudioCatVolume: (cat, v) => {
    const vol = Math.max(0, Math.min(1, v));
    audio.setCategoryVolume(cat, vol);
    set((st) => {
      const cats = { ...st.audioCats, [cat]: { ...st.audioCats[cat], v: vol } };
      return { audioCats: cats, layout: { ...st.layout, audioCats: cats } };
    });
    persistLayout(get().layout); // itm-ui-v1 only — never the campaign save
  },
  toggleAudioCat: (cat) => {
    const on = !get().audioCats[cat].on;
    audio.setCategoryMuted(cat, !on);
    set((st) => {
      const cats = { ...st.audioCats, [cat]: { ...st.audioCats[cat], on } };
      return { audioCats: cats, layout: { ...st.layout, audioCats: cats } };
    });
    persistLayout(get().layout);
  },

  // ------------------------------------------------------------------ call-for-fire auto-pause
  toggleAutoPauseOnFire: () => {
    const on = !get().autoPauseOnFire;
    set((st) => ({ autoPauseOnFire: on, layout: { ...st.layout, autoPauseOnFire: on } }));
    persistLayout(get().layout); // itm-ui-v1 only — never the campaign save
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
    if (world.approveFireRequest()) { set({ tick: get().tick + 1 }); get().pushToast("✓ Cleared hot — rounds inbound.", "crit"); }
  },
  denyFires: () => {
    const { world } = get();
    if (!world) return;
    world.denyFireRequest();
    set({ tick: get().tick + 1 });
    get().pushToast("✕ Fire mission denied.", "info");
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
    get().pushToast(`▲ ${fireSupport.label} — shot, on the way.`, "crit");
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
    if (any) { set({ tick: get().tick + 1 }); get().pushToast("✚ 9-LINE MEDEVAC requested — bird inbound.", "crit"); }
    else get().pushToast("No casualty in the field to evacuate.", "warn");
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
