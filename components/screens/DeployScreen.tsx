"use client";
import { useEffect, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useGame, SPEEDS, type ToastSev } from "@/state/store";
import WorldView from "@/components/world/WorldView";
import { getWeapon } from "@/lib/sim/weapons";
import { Unit, ROE } from "@/lib/sim/entities";
import {
  MISSION_LABEL, MissionType,
  MovementSOP, ContactSOP, SquadSOP,
  MOVEMENT_SOP_LABEL, CONTACT_SOP_LABEL, ROE_LABEL,
} from "@/lib/sim/world";
import { Supplies, CERP_PROJECTS } from "@/lib/sim/campaign";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";

// map a CERP project label → its authored icon id
function cerpIcon(p: string): string {
  if (p.startsWith("road")) return "ico-cerp-road";
  if (p.startsWith("micro")) return "ico-cerp-hydro";
  if (p.startsWith("retaining")) return "ico-cerp-wall";
  if (p.startsWith("mosque")) return "ico-cerp-mosque";
  return "ico-cerp-" + p; // well / school / clinic / culvert / footbridge
}
const ROLE_ICON: Record<string, string> = {
  platoon_leader: "pl", platoon_sergeant: "pl", squad_leader: "sl", team_leader: "sl",
  rifleman: "rfl", grenadier: "grn", saw_gunner: "saw", auto_rifleman: "saw", machinegunner: "mg",
  marksman: "dm", sniper: "snp", medic: "doc", rto: "rto", jtac: "fo", engineer: "eng",
};
function roleIcon(role: string): string {
  return "ico-role-" + (ROLE_ICON[role] ?? "rfl");
}
function weatherIcon(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("rain") || l.includes("storm")) return "ico-rain";
  if (l.includes("snow")) return "ico-snow";
  if (l.includes("dust") || l.includes("haze")) return "ico-dust";
  if (l.includes("cloud") || l.includes("overcast")) return "ico-cloud";
  return "ico-clear";
}

const MISSIONS: MissionType[] = ["presence", "recon", "ambush", "census", "cordon", "overwatch"];
const MOVEMENTS: MovementSOP[] = ["stealth", "patrol", "fast"];
const CONTACTS: ContactSOP[] = ["hold", "suppress", "assault", "break"];
const ROES: ROE[] = ["hold", "tight", "free"];

function Bar({ label, value, color = "#6b7a3a", max = 100, suffix = "%", title }: { label: ReactNode; value: number; color?: string; max?: number; suffix?: string; title?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono" title={title}>
      <div className="w-[80px] text-inkdim shrink-0 inline-flex items-center gap-1">{label}</div>
      <div className="flex-1 h-2.5 bg-bg border border-line relative overflow-hidden">
        <div className="h-full" style={{ width: pct + "%", background: color }} />
      </div>
      <div className="w-[40px] text-right text-ink">{Math.round(value)}{suffix}</div>
    </div>
  );
}

// The five campaign metrics — the strategic north-star ("win the valley, not the
// firefight"). Promoted from identical horizontal slivers to a labeled vertical
// meter: a stencil TAG (text, not colour) + a bright tabular value + a thin bar.
// ENEMY is the one "bad-when-high" axis, so it fills FROM THE RIGHT with a hazard
// hatch — redundant shape+texture cues so colour-blind commanders read it as danger.
function CampaignMeter({ tag, label, value, color, bad = false }: { tag: string; label: string; value: number; color?: string; bad?: boolean }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col justify-center gap-1 min-w-0 flex-1" title={`${label}: ${Math.round(value)}%`}>
      <div className="flex items-baseline justify-between gap-1 leading-none">
        <span className="stencil text-[9px] text-inkdim">{tag}</span>
        <span className={`font-mono text-[13px] tabular-nums ${bad && value > 60 ? "text-rust" : "text-ink"}`}>{Math.round(value)}</span>
      </div>
      <div className="h-[5px] bg-bg border border-line relative overflow-hidden">
        <div
          className={`h-full absolute top-0 ${bad ? `right-0 hazard-hatch` : "left-0"}`}
          style={{ width: pct + "%", background: bad ? undefined : color }}
        />
      </div>
    </div>
  );
}

function roleAbbr(role: string): string {
  const map: Record<string, string> = {
    platoon_leader: "PL", platoon_sergeant: "PSG", squad_leader: "SL", team_leader: "TL",
    rifleman: "RFL", grenadier: "GRN", saw_gunner: "SAW", machinegunner: "MG", marksman: "DM",
    sniper: "SNP", medic: "DOC", rto: "RTO", jtac: "FO",
  };
  return map[role] ?? role.slice(0, 3).toUpperCase();
}

// Tooltip expansions — every abbreviation / glyph in the roster spells itself out on hover.
const ROLE_FULL: Record<string, string> = {
  platoon_leader: "Platoon Leader", platoon_sergeant: "Platoon Sergeant", squad_leader: "Squad Leader",
  team_leader: "Team Leader", rifleman: "Rifleman", grenadier: "Grenadier",
  saw_gunner: "Automatic Rifleman (SAW)", auto_rifleman: "Automatic Rifleman", machinegunner: "Machine Gunner",
  marksman: "Designated Marksman", sniper: "Sniper", medic: "Combat Medic",
  rto: "Radio-Telephone Operator", jtac: "Joint Terminal Attack Controller (calls fires)", engineer: "Combat Engineer",
};
const roleFull = (role: string) => ROLE_FULL[role] ?? role.replace(/_/g, " ");
const STATUS_LABEL: Record<string, string> = {
  ready: "Ready for duty", rest: "Resting / refitting", wounded: "Wounded in action (WIA)", kia: "Killed in action (KIA)",
};
// What each SOP option actually does — so the segmented control teaches itself on hover.
const MOVEMENT_DESC: Record<string, string> = {
  stealth: "Stealth — hug cover and concealment; hardest to spot, slowest.",
  patrol: "Patrol — standard tactical movement, balanced pace.",
  fast: "Fast — take roads/tracks; quickest but most exposed.",
};
const CONTACT_DESC: Record<string, string> = {
  hold: "Hold & return fire — hold the ground and fire back.",
  suppress: "Suppress & call fires — pin the enemy and call for support.",
  assault: "Assault — set a base of fire and maneuver a team onto the enemy.",
  break: "Break contact — peel back to a rally point.",
};
const ROE_DESC: Record<string, string> = {
  hold: "Weapons Hold — fire only in self-defense.",
  tight: "Weapons Tight — engage positively-identified threats; keep fire off civilians.",
  free: "Weapons Free — engage known enemy without further clearance.",
};

// ---------------------------------------------------------------- log split predicate
// One shared partition used by Combat Log, Command Log, and the Contact Feed — every log
// entry shows in exactly one channel. Retune by editing this single Set.
const FIGHT_KINDS = new Set(["contact", "kia", "casualty", "support"]);
const isCombat = (l: { kind: string }) => FIGHT_KINDS.has(l.kind);

function kindStyle(kind: string): string {
  switch (kind) {
    case "kia":      return "text-rust border-rust font-semibold";
    case "casualty": return "text-tan border-tan";
    case "contact":  return "text-amber border-amber";
    case "support":  return "text-us border-us";
    default:         return "text-inkdim border-line";
  }
}

// ---------------------------------------------------------------- dock primitive
// A dock module: stencil header (collapsible) + internally-scrolling body + bottom drag handle.
// `grow` panels are the elastic sink (no fixed height, no handle); exactly one per column.
function DockPanel({
  id, title, accent = "amber", right, grow = false, defaultHeight = 130, last = false, children,
}: {
  id: string; title: string; accent?: string; right?: ReactNode;
  grow?: boolean; defaultHeight?: number; last?: boolean; children: ReactNode;
}) {
  const collapsed = useGame((s) => !!s.layout.collapsed[id]);
  const height = useGame((s) => s.layout.heights[id]);
  const togglePanel = useGame((s) => s.togglePanel);
  const h = height ?? defaultHeight;
  // collapsed → header only (28px); grow → flex:1; else → fixed pixel height.
  const style: CSSProperties = collapsed
    ? { height: 28, flex: "0 0 auto" }
    : grow
      ? { flex: "1 1 0%", minHeight: 64 }
      : { height: h, flex: "0 0 auto", minHeight: 28 };
  return (
    <div className="relative flex flex-col min-h-0 border-b border-line" style={style}>
      {/* Header row: a click-to-collapse button + an optional right slot that may itself hold
          interactive controls (Convoy/Air, badges). The right slot is a SIBLING of the toggle
          button — never nested inside it — so we never produce an invalid button-in-button DOM. */}
      <div className="dock-header w-full flex items-center justify-between px-2 h-7 shrink-0 border-b border-line bg-panel select-none">
        <button
          onClick={() => togglePanel(id)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 min-w-0 flex-1 text-left hover:text-amber h-full"
        >
          <span className="text-inkdim text-[9px] transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
          <span className={`stencil text-[10px] text-${accent}`}>{title}</span>
        </button>
        {right && <span className="text-[9px] font-mono shrink-0 ml-2">{right}</span>}
      </div>
      {!collapsed && <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>}
      {!collapsed && !grow && !last && <ResizeHandle id={id} defaultHeight={defaultHeight} />}
    </div>
  );
}

// 5px bottom-edge grab target. Drag resizes THIS panel; the column's lone `grow` panel
// (Intel left / Task Org right) absorbs/yields the slack, so the column sum stays exact
// and the fixed-height shell never scrolls.
function ResizeHandle({ id, defaultHeight }: { id: string; defaultHeight: number }) {
  const setPanelHeight = useGame((s) => s.setPanelHeight);
  const persist = useGame((s) => s.persistPanelLayout);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.dataset.active = "true";
    document.body.classList.add("dock-dragging");
    const startY = e.clientY;
    const startH = useGame.getState().layout.heights[id] ?? defaultHeight;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(28, Math.min(560, startH + (ev.clientY - startY)));
      setPanelHeight(id, next);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.dataset.active = "false";
      document.body.classList.remove("dock-dragging");
      persist();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
  return (
    <div className="dock-handle" data-active="false" role="separator" aria-orientation="horizontal"
      aria-label="Drag to resize panel (double-click to reset)"
      onPointerDown={onDown} onDoubleClick={() => { setPanelHeight(id, defaultHeight); persist(); }}>
      <i />
    </div>
  );
}

export default function DeployScreen() {
  const world = useGame((s) => s.world);
  const togglePause = useGame((s) => s.togglePause);
  const setSpeed = useGame((s) => s.setSpeed);
  const toggleWarp = useGame((s) => s.toggleWarp);
  const setFireSupport = useGame((s) => s.setFireSupport);
  const setPlanning = useGame((s) => s.setPlanning);
  const hasDirectives = useGame((s) => !!s.world && s.world.state.directives.length > 0);
  useGame((s) => s.tick);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePause();
        return;
      }
      const k = e.key.toUpperCase();
      // Call-for-fire hotkeys — only while a request is pending. F clears hot (the urgent ✓),
      // X denies. Hotkeys make the time-critical approve/deny lever fast under TIC's 1× clock.
      if (useGame.getState().world?.state.fireRequest) {
        if (k === "F") { e.preventDefault(); useGame.getState().approveFires(); return; }
        if (k === "X") { e.preventDefault(); useGame.getState().denyFires(); return; }
      }
      if (e.key === "1") setSpeed(1);
      if (e.key === "2") setSpeed(2);
      if (e.key === "3") setSpeed(4);
      if (e.key === "4") setSpeed(8);
      if (e.key === "5") setSpeed(16);
      if (k === "T") toggleWarp();
      if (k === "M") useGame.getState().toggleAudioMute(); // M = mute/unmute the procedural audio
      if (k === "R") setPlanning(!useGame.getState().planning); // R = draw/route mode for the active squad
      if (k === "H" || e.key === "?") { e.preventDefault(); useGame.getState().toggleHelp(); } // H / ? = controls reference
      if (e.key === "Escape") {
        setFireSupport(null);
        if (useGame.getState().planning) setPlanning(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, setSpeed, toggleWarp, setFireSupport, setPlanning]);

  if (!world) return null;

  return (
    <div className="w-full h-full flex flex-col" data-contact={world.inContact()}>
      <CommandBar />
      <div className="flex-1 flex min-h-0">
        <div className="w-[280px] shrink-0 border-r border-line flex flex-col min-h-0">
          <DockPanel id="tasks" title="Active Elements" defaultHeight={132}><TasksBody /></DockPanel>
          {hasDirectives && <DockPanel id="directives" title="Battalion Directives" defaultHeight={120}><DirectivesBody /></DockPanel>}
          <DockPanel id="intel" title="Intel Feed" grow><IntelBody /></DockPanel>
          <DockPanel id="combatlog" title="Combat Log" defaultHeight={150} right={<CombatBadge />}><CombatLogBody /></DockPanel>
          <DockPanel id="commandlog" title="Command Log" defaultHeight={130} last><CommandLogBody /></DockPanel>
        </div>
        <div className="flex-1 relative min-w-0">
          <WorldView />
          <MapControls />
          <BannerOverlay />
          <ToastStack />
          <OrderBar />
        </div>
        <RightColumn />
      </div>
      <EventModal />
      <SoldierJacket />
      <HelpOverlay />
    </div>
  );
}

// ---------------------------------------------------------------- command bar
function CommandBar() {
  const world = useGame((s) => s.world)!;
  const paused = useGame((s) => s.paused);
  const speed = useGame((s) => s.speed);
  const warp = useGame((s) => s.warp);
  const togglePause = useGame((s) => s.togglePause);
  const setSpeed = useGame((s) => s.setSpeed);
  const toggleWarp = useGame((s) => s.toggleWarp);
  const gotoMenu = useGame((s) => s.gotoMenu);
  const audioMuted = useGame((s) => s.audioMuted);
  const audioVolume = useGame((s) => s.audioVolume);
  const setAudioVolume = useGame((s) => s.setAudioVolume);
  const toggleAudioMute = useGame((s) => s.toggleAudioMute);
  const autoPauseOnFire = useGame((s) => s.autoPauseOnFire);
  const toggleAutoPauseOnFire = useGame((s) => s.toggleAutoPauseOnFire);
  useGame((s) => s.tick);

  const m = world.state.metrics;
  const wx = world.state.weather;
  const light = world.ambientLight();
  const inContact = world.inContact();

  return (
    <div className="panel border-x-0 border-t-0 flex items-stretch gap-0 h-12 shrink-0">
      <div className="flex items-center px-3 gap-2.5 border-r border-line">
        <Icon name="crest-us" size={28} />
        <span className="text-amber font-black text-lg tracking-tight">ITM</span>
        <div className="font-mono text-[11px] leading-tight">
          <div className="text-ink">{world.state.fob.name}</div>
          <div className="text-inkdim">{world.platoon.callsign} · {world.state.seed}</div>
        </div>
      </div>
      <div className="flex items-center px-3 gap-3 border-r border-line font-mono text-[11px]">
        <div>
          <div className="text-inkdim">CLOCK</div>
          <div className="text-ink text-sm leading-none tabular-nums">{world.clockLabel()}<span className="text-inkdim text-[10px]"> /{world.state.totalDays}d</span></div>
        </div>
        <div className={light < 0.2 ? "text-us" : "text-ink"}>
          <div className="text-inkdim">LIGHT</div>
          <div className="leading-none text-sm">{light < 0.2 ? "NIGHT" : light < 0.6 ? "LOW" : "DAY"}</div>
        </div>
        <div>
          <div className="text-inkdim">WX</div>
          <div className="text-ink leading-none text-sm inline-flex items-center gap-1"><Icon name={weatherIcon(wx.label)} size={14} className="text-tan" />{wx.label}</div>
        </div>
        <div className={wx.airAvailable ? "text-good" : "text-rust"}>
          <div className="text-inkdim">AIR</div>
          <div className="leading-none text-sm">{wx.airAvailable ? "ON" : "NO-GO"}</div>
        </div>
      </div>
      {/* STRATEGIC POSTURE — the campaign's north-star, the visual anchor of the bar.
          Population axes (STAB/ATT) and force axes (ENY/CBT/HHQ) split by a hairline. */}
      <div className="flex-1 flex items-center px-3 min-w-0">
        <div className="flex items-stretch gap-3 w-full max-w-[600px] py-1.5">
          <CampaignMeter tag="STAB" label="Valley Stability" value={m.stability} color="var(--good)" />
          <CampaignMeter tag="ATT" label="Village Attitudes" value={m.attitude} color="var(--amber)" />
          <div className="w-px bg-line self-stretch shrink-0" aria-hidden />
          <CampaignMeter tag="ENY" label="Estimated Enemy Strength" value={m.enemyStrength} bad />
          <CampaignMeter tag="CBT" label="Combat Power" value={m.combatPower} color="var(--us)" />
          <CampaignMeter tag="HHQ" label="Higher's Confidence" value={m.higherConfidence} color="var(--tan)" />
        </div>
      </div>
      {/* time controls */}
      <div className="flex items-center px-2 gap-1 border-l border-line">
        {inContact && <span className="stencil text-rust text-[10px] blink mr-1">● TIC</span>}
        <button className={`tac-btn px-2 py-1 ${paused ? "active" : ""}`} onClick={togglePause} title={paused ? "Resume (Space)" : "Pause (Space)"} aria-label={paused ? "Resume the clock" : "Pause the clock"} aria-pressed={paused}>{paused ? "▶" : "⏸"}</button>
        {SPEEDS.map((s) => {
          const disabled = inContact && s > 4;
          return (
            <button key={s} disabled={disabled} className={`tac-btn px-2 py-1 ${!paused && !warp && speed === s ? "active" : ""}`} onClick={() => setSpeed(s)}>{s}×</button>
          );
        })}
        <button disabled={inContact} className={`tac-btn px-2 py-1 ${warp ? "active" : ""}`} onClick={toggleWarp} title="Skip to next event (T)" aria-label="Skip to next event" aria-pressed={warp}>⏩</button>
        {/* Auto-pause on a new call-for-fire: the urgency cue. On = the clock stops so you read the
            call (clear hot [F] / deny [X]). Never auto-restores speed — TIC owns that one-way drop. */}
        <button className={`tac-btn px-2 py-1 ${autoPauseOnFire ? "active" : ""}`} onClick={toggleAutoPauseOnFire} title="Auto-pause on a new call-for-fire" aria-label="Toggle auto-pause on a new call-for-fire" aria-pressed={autoPauseOnFire}>⏸▲</button>
      </div>
      {/* audio — master mute + volume (persisted in itm-ui-v1, NOT the campaign save) */}
      <div className="flex items-center px-2 gap-1 border-l border-line">
        <button className={`tac-btn px-2 py-1 ${audioMuted ? "active" : ""}`} onClick={toggleAudioMute} title="Mute (M)" aria-label={audioMuted ? "Unmute audio" : "Mute audio"} aria-pressed={audioMuted}>{audioMuted ? "🔇" : "🔊"}</button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={audioVolume}
          onChange={(e) => setAudioVolume(+e.target.value)}
          disabled={audioMuted}
          className="w-16 h-6 accent-amber"
          title="Volume"
          aria-label="Master volume"
        />
      </div>
      <button className="tac-btn rounded-none border-y-0 px-3" onClick={() => useGame.getState().toggleHelp()} aria-label="Controls & shortcuts reference" title="Controls & shortcuts (H or ?)">?</button>
      <button className="tac-btn rounded-none border-y-0 border-r-0 px-3" onClick={gotoMenu} aria-label="Menu — return to main menu" title="Menu">☰</button>
    </div>
  );
}

// ---------------------------------------------------------------- left column
function TasksBody() {
  const world = useGame((s) => s.world)!;
  const recallTask = useGame((s) => s.recallTask);
  useGame((s) => s.tick);
  const tasks = world.state.tasks;
  return (
    <div className="p-2">
      {tasks.length === 0 && <div className="text-inkdim text-[11px] italic">All elements at the COP.</div>}
      <div className="flex flex-col gap-1">
        {tasks.map((t) => (
          <div key={t.id} className="bg-bg border border-line p-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-ink text-[11px] font-semibold truncate">{t.label}</div>
              <div className="text-inkdim text-[9px] font-mono">{t.memberIds.length} pax · {t.kind === "secure" && t.phase === "onstation" ? "securing" : t.phase}{t.phase === "assembling" ? ` ${Math.ceil(t.timer)}s` : ""} · {t.technique}</div>
            </div>
            <button className="tac-btn text-[9px] px-1.5 py-0.5 shrink-0" onClick={() => recallTask(t.id)}>recall</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// Short tag for each directive kind — the FRAGO "type" the player reads at a glance.
const DIRECTIVE_KIND_TAG: Record<string, string> = {
  presence: "PRESENCE", kle: "KLE", census: "CENSUS", interdict: "INTERDICT",
  construct: "CERP", hold: "HOLD", casualty: "PROTECT POP",
};

// The Battalion Directives feed: every FRAGO from Higher with its kind, deadline, live progress,
// and status. Active ones are driveable; COMPLETE earns Higher's confidence; FAILED costs it —
// the player FEELS the pressure from above (reward/penalty are surfaced, not hidden).
function DirectivesBody() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const dirs = world.state.directives;
  if (dirs.length === 0) return null;
  // Sort: active first (soonest deadline up top), then the resolved ones (newest id last → recent
  // failures/completions sit just under the live ones, so the player sees the consequence).
  const active = dirs.filter((d) => d.status === "active").sort((a, b) => a.deadlineDay - b.deadlineDay);
  const resolved = dirs.filter((d) => d.status !== "active").slice(-4);
  const day = world.day;
  return (
    <div className="p-2">
      <div className="flex flex-col gap-1.5">
        {active.map((d) => {
          const left = d.deadlineDay - day;
          const urgent = left <= 3; // deadline pressure — colour the countdown when it bites
          return (
            <div key={d.id} className="bg-bg border border-line p-1.5">
              <div className="flex justify-between items-baseline gap-2">
                <span className="text-ink text-[11px] font-semibold truncate inline-flex items-center gap-1.5">
                  <span className="stencil text-[8px] text-amber bg-panel2 px-1 border border-line shrink-0">{DIRECTIVE_KIND_TAG[d.kind] ?? d.kind}</span>
                  {d.title}
                </span>
                <span className={`font-mono text-[9px] shrink-0 ${urgent ? "text-rust blink" : "text-inkdim"}`}>
                  {left >= 0 ? `${left}d` : "OVERDUE"} · D{d.deadlineDay}
                </span>
              </div>
              <div className="text-inkdim text-[10px] leading-snug mt-0.5">{d.desc}</div>
              <div className="h-1 bg-panel2 mt-1 border border-line">
                <div className="h-full bg-olive" style={{ width: `${Math.round(d.progress * 100)}%` }} />
              </div>
            </div>
          );
        })}
        {resolved.map((d) => {
          const done = d.status === "complete";
          return (
            <div key={d.id} className={`bg-bg border p-1.5 opacity-90 ${done ? "border-good" : "border-rust"}`}>
              <div className="flex justify-between items-baseline gap-2">
                <span className="text-inkdim text-[10px] truncate inline-flex items-center gap-1.5">
                  <span className="stencil text-[8px] text-inkdim bg-panel2 px-1 border border-line shrink-0">{DIRECTIVE_KIND_TAG[d.kind] ?? d.kind}</span>
                  {d.title}
                </span>
                <span className={`stencil text-[9px] shrink-0 ${done ? "text-good" : "text-rust"}`}>
                  {done ? `✓ COMPLETE +${d.reward}` : `✕ FAILED −${d.penalty}`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IntelBody() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  return (
    <div className="p-2 flex flex-col gap-1">
      {world.state.intel.slice(0, 26).map((r) => (
        <div key={r.id} className="text-[10px] leading-snug border-l-2 pl-1.5" style={{ borderColor: r.source === "SIGINT" ? "#e0a72b" : r.source === "HUMINT" ? "#6fae54" : "#c89c5c" }}>
          <span className="font-mono text-inkdim">[{r.source} ·{Math.round(r.reliability * 100)}%] </span>
          <span className="text-ink">{r.text}</span>
        </div>
      ))}
      {world.state.intel.length === 0 && <div className="text-inkdim italic text-[11px]">No reporting yet. Patrol and talk to people.</div>}
    </div>
  );
}

// ---- Combat Log / Command Log / Contact Feed (req #3) — split by log kind ----
function CombatLogBody() {
  const world = useGame((s) => s.world)!;
  const markCombatSeen = useGame((s) => s.markCombatSeen);
  useGame((s) => s.tick);
  const lines = world.state.log.filter(isCombat).slice(-60).reverse();
  // mark the newest combat line seen while this panel is open (clears the "N NEW" badge).
  const newestId = lines.length ? lines[0].id : 0;
  useEffect(() => { if (newestId) markCombatSeen(newestId); }, [newestId, markCombatSeen]);
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {lines.length === 0 && <div className="text-inkdim italic text-[11px]">No contact. The valley is quiet.</div>}
      {lines.map((l) => (
        <div key={l.id} className={`text-[10px] leading-snug font-mono pl-1.5 border-l-2 ${kindStyle(l.kind)}`}>
          <span className="opacity-50">D{l.day} </span>{l.msg}
        </div>
      ))}
    </div>
  );
}

function CommandLogBody() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const lines = world.state.log.filter((l) => !isCombat(l)).slice(-40).reverse();
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {lines.map((l) => (
        <div key={l.id} className={`text-[10px] leading-snug ${l.kind === "objective" ? "text-amber" : "text-inkdim"}`}>
          <span className="font-mono opacity-60">D{l.day} </span>{l.msg}
        </div>
      ))}
    </div>
  );
}

// header badge: live ● TIC, or unread-since-seen count when collapsed.
function CombatBadge() {
  const world = useGame((s) => s.world)!;
  const seen = useGame((s) => s.layout.seenCombatId);
  useGame((s) => s.tick);
  if (world.inContact()) return <span className="stencil text-[9px] text-rust blink">● TIC</span>;
  const n = world.state.log.filter((l) => isCombat(l) && l.id > seen).length;
  return n > 0 ? <span className="stencil text-[9px] text-rust">{n} NEW</span> : <span className="text-inkdim">—</span>;
}

// ---------------------------------------------------------------- map overlays
function MapControls() {
  const planning = useGame((s) => s.planning);
  const setPlanning = useGame((s) => s.setPlanning);
  const planRoute = useGame((s) => s.planRoute);
  const popWaypoint = useGame((s) => s.popWaypoint);
  const clearRoute = useGame((s) => s.clearRoute);
  return (
    <div className="absolute top-2 left-2 flex gap-1">
      <button className={`tac-btn ${planning ? "active" : ""}`} onClick={() => setPlanning(!planning)}>
        ✚ {planning ? "Planning…" : "Plan Patrol"}
      </button>
      {planning && planRoute.length > 0 && (
        <>
          <button className="tac-btn" onClick={popWaypoint}>↶ Undo</button>
          <button className="tac-btn tac-btn-danger" onClick={clearRoute}>Clear</button>
        </>
      )}
    </div>
  );
}

// Severity-typed command-feedback toasts — every order, fund, fire and combat
// interrupt acknowledged so nothing reads as a dead click. Stacks newest-on-top,
// auto-expires (store frame loop), click to dismiss, announced to screen readers.
const TOAST_SEV_BORDER: Record<ToastSev, string> = {
  good: "border-l-good",
  info: "border-l-us",
  warn: "border-l-amber",
  crit: "border-l-rust",
};
function ToastStack() {
  const toasts = useGame((s) => s.toasts);
  const dismiss = useGame((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="absolute top-2 right-2 z-40 flex flex-col gap-1.5 w-[290px] pointer-events-none" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          title="Dismiss"
          aria-label={`Notification: ${t.text}. Click to dismiss.`}
          className={`pointer-events-auto text-left panel border-l-[3px] ${TOAST_SEV_BORDER[t.sev]} px-2.5 py-1.5 fade-in shadow-lg shadow-black/40`}
        >
          <span className="font-mono text-[11px] text-ink leading-snug block normal-case">{t.text}</span>
        </button>
      ))}
    </div>
  );
}

// Controls & shortcuts reference + a live map legend — so the LIVE surface teaches its own
// controls (the time-critical F=clear-hot lever was previously discoverable only in source).
// Reachable from the CommandBar "?" and the H / ? keys; built on the shared accessible Modal.
function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-block min-w-[20px] text-center bg-bg border border-line rounded-[2px] px-1.5 py-0.5 font-mono text-[11px] text-amber">{children}</kbd>;
}
function HelpRow({ keys, desc }: { keys: ReactNode; desc: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="flex gap-1 shrink-0 w-[112px]">{keys}</span>
      <span className="text-inkdim text-[12px]">{desc}</span>
    </div>
  );
}
function LegendSwatch({ color, shape = "dot", label }: { color: string; shape?: "dot" | "ring"; label: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="shrink-0 w-4 inline-flex justify-center">
        <span className="w-3 h-3" style={shape === "ring" ? { border: `2px solid ${color}`, borderRadius: 9999 } : { background: color, borderRadius: 9999 }} />
      </span>
      <span className="text-inkdim text-[12px]">{label}</span>
    </div>
  );
}
function HelpOverlay() {
  const helpOpen = useGame((s) => s.helpOpen);
  const toggleHelp = useGame((s) => s.toggleHelp);
  if (!helpOpen) return null;
  return (
    <Modal onClose={() => toggleHelp(false)} labelledBy="help-title" width="w-[620px]">
      <div className="flex justify-between items-start mb-3">
        <div>
          <div className="stencil text-[10px] text-amber">Field Reference</div>
          <h2 id="help-title" className="text-ink text-xl font-bold leading-tight">Controls &amp; Map Legend</h2>
        </div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={() => toggleHelp(false)} aria-label="Close controls reference">✕</button>
      </div>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <div className="stencil text-[10px] text-amber mb-1">Time</div>
          <HelpRow keys={<Kbd>Space</Kbd>} desc="Pause / resume the clock" />
          <HelpRow keys={<><Kbd>1</Kbd><Kbd>…</Kbd><Kbd>5</Kbd></>} desc="Speed 1× · 2× · 4× · 8× · 16×" />
          <HelpRow keys={<Kbd>T</Kbd>} desc="Skip to the next event" />
        </div>
        <div>
          <div className="stencil text-[10px] text-rust mb-1">Combat</div>
          <HelpRow keys={<Kbd>F</Kbd>} desc="Clear hot — approve fires" />
          <HelpRow keys={<Kbd>X</Kbd>} desc="Deny the fire request" />
          <HelpRow keys={<Kbd>C</Kbd>} desc="Jump camera to contact" />
        </div>
        <div>
          <div className="stencil text-[10px] text-amber mb-1">Command</div>
          <HelpRow keys={<Kbd>R</Kbd>} desc="Draw / route the active squad" />
          <HelpRow keys={<span className="text-inkdim text-[11px]">click</span>} desc="Select a squad / open a village" />
          <HelpRow keys={<span className="text-inkdim text-[11px]">drag</span>} desc="Pan map · scroll to zoom" />
        </div>
        <div>
          <div className="stencil text-[10px] text-amber mb-1">Interface</div>
          <HelpRow keys={<Kbd>M</Kbd>} desc="Mute / unmute audio" />
          <HelpRow keys={<><Kbd>H</Kbd><Kbd>?</Kbd></>} desc="This reference" />
          <HelpRow keys={<Kbd>Esc</Kbd>} desc="Cancel targeting / close" />
        </div>
      </div>
      <div className="divider my-3" />
      <div className="stencil text-[10px] text-amber mb-1">Map Legend</div>
      <div className="grid grid-cols-2 gap-x-6">
        <div>
          <LegendSwatch color="var(--us)" label="Friendly element (you)" />
          <LegendSwatch color="var(--enemy)" label="Enemy — confirmed sighting" />
          <LegendSwatch color="color-mix(in srgb, var(--enemy) 45%, #000)" label="Enemy — suspected (going stale)" />
        </div>
        <div>
          <LegendSwatch color="var(--civ)" label="Civilian (protected)" />
          <LegendSwatch color="var(--amber)" shape="ring" label="ROE no-fire ring — hold fire here" />
          <LegendSwatch color="var(--good)" label="Cooperative village · ✓ visited" />
        </div>
      </div>
      <div className="text-inkdim/70 text-[11px] mt-3 font-mono">The hardest part of command is watching. Set the SOP, then read the net.</div>
    </Modal>
  );
}

function BannerOverlay() {
  const banner = useGame((s) => s.banner);
  const fireSupport = useGame((s) => s.fireSupport);
  const setFireSupport = useGame((s) => s.setFireSupport);
  useGame((s) => s.tick);
  return (
    <div className="absolute top-2 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1 z-20 pointer-events-none">
      {fireSupport && (
        <div className="panel px-4 py-1.5 border-amber pointer-events-auto fade-in">
          <span className="stencil text-amber text-xs blink">◎ SELECT IMPACT POINT — {fireSupport.label}</span>
          <button className="tac-btn ml-3 text-[10px] px-2 py-0.5" onClick={() => setFireSupport(null)}>cancel (Esc)</button>
        </div>
      )}
      {banner && !fireSupport && (
        <div className="panel px-4 py-1 fade-in text-[11px] text-amber font-mono">{banner}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- order bar
function OrderBar() {
  const world = useGame((s) => s.world)!;
  const fireSupport = useGame((s) => s.fireSupport);
  const setFireSupport = useGame((s) => s.setFireSupport);
  const medevacSelected = useGame((s) => s.medevacSelected);
  const approveFires = useGame((s) => s.approveFires);
  const denyFires = useGame((s) => s.denyFires);
  useGame((s) => s.tick);
  const sim = world.sim;
  // any friendly down in the field → surface the 9-line
  const casualtyInField = sim.units.some((u) => (u.faction === "us" || u.faction === "ana") && u.alive && !u.evac && (!u.conscious || u.bleedRate > 0.3));
  const fr = world.state.fireRequest;

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-panel/95 border-t border-line p-2 z-10 contact-accent">
      <div className="flex items-stretch gap-3">
        {/* ZONE 1 — squad readout */}
        <SquadReadout />
        {/* ZONE 2 — call-for-fire + fire support + medevac */}
        <div className="flex items-stretch gap-3 border-l border-line pl-3">
          {fr && (
            <div className="border-2 border-rust bg-rust/10 px-2.5 py-1.5 animate-pulse rounded-sm">
              <div className="stencil text-[11px] text-rust mb-1 blink">▲ CALL FOR FIRE — {fr.label}</div>
              <div className="font-mono text-[10px] text-ink max-w-[220px] mb-1.5">{fr.reason}. Requesting <span className="text-amber">{getWeapon(fr.weaponId).short}</span> on grid {String(fr.cx).padStart(3, "0")}–{String(fr.cy).padStart(3, "0")}.</div>
              <div className="flex gap-1.5">
                <button className="tac-btn tac-btn-danger active flex-1 text-[12px] py-1.5 font-bold" onClick={approveFires}>✓ CLEARED HOT <span className="text-[9px] opacity-70 font-normal">[F]</span></button>
                <button className="tac-btn flex-1 text-[11px] py-1.5" onClick={denyFires}>✕ DENY <span className="text-[9px] opacity-70">[X]</span></button>
              </div>
            </div>
          )}
          <div>
            <div className="stencil text-[9px] text-amber mb-1">Fire Support <span className="text-inkdim normal-case">— click the map</span></div>
            <div className="grid grid-cols-2 gap-1 max-w-[320px]">
              {sim.mortars.map((mt) => {
                const wp = getWeapon(mt.weaponId);
                return (
                  <button key={mt.weaponId} disabled={mt.rounds <= 0} title={mt.rounds <= 0 ? `${wp.short}: tube empty — resupply mortar rounds` : `${wp.name} — ${mt.rounds} rounds on hand`} className={`tac-btn inline-flex items-center gap-1.5 text-left text-[10px] ${fireSupport?.weaponId === mt.weaponId ? "active" : ""}`} onClick={() => setFireSupport(mt.weaponId, `${wp.short} ×4`, 4)}>
                    <Icon name="ico-mortar" size={13} /> {wp.name} <span className="text-inkdim">({mt.rounds})</span>
                  </button>
                );
              })}
              <button disabled={!sim.casAvailable || sim.casUsed} title={!sim.casAvailable ? "No CAS on station" : sim.casUsed ? "CAS already expended this window" : "CAS gun run — click the map"} className={`tac-btn inline-flex items-center justify-center gap-1 text-[10px] ${fireSupport?.weaponId === "cas_gun" ? "active" : ""}`} onClick={() => setFireSupport("cas_gun", "CAS GUN RUN")}><Icon name="ico-cas-gun" size={13} /> Gun</button>
              <button disabled={!sim.casAvailable || sim.casUsed} title={!sim.casAvailable ? "No CAS on station" : sim.casUsed ? "CAS already expended this window" : "CAS Hellfire — click the map"} className={`tac-btn inline-flex items-center justify-center gap-1 text-[10px] ${fireSupport?.weaponId === "cas_rocket" ? "active" : ""}`} onClick={() => setFireSupport("cas_rocket", "CAS HELLFIRE")}><Icon name="ico-cas-hellfire" size={13} /> Hellfire</button>
              <button className={`col-span-2 tac-btn inline-flex items-center justify-center gap-1 text-[10px] ${casualtyInField ? "tac-btn-danger active" : ""}`} onClick={medevacSelected}>
                <Icon name="ico-medevac" size={13} /> 9-LINE MEDEVAC {casualtyInField && <span className="text-[9px]">· casualty down</span>}
              </button>
            </div>
          </div>
        </div>
        {/* ZONE 3 — live contact feed fills the reclaimed right half */}
        <ContactFeed />
      </div>
    </div>
  );
}

// The reclaimed right half of the Ops Strip: the last few firefight lines, live.
function ContactFeed() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const lines = world.state.log.filter(isCombat).slice(-6).reverse();
  return (
    <div className="flex-1 min-w-0 border-l border-line pl-3">
      <div className="stencil text-[9px] text-amber mb-1">Contact Feed</div>
      {lines.length === 0
        ? <div className="text-inkdim text-[10px] font-mono">— net quiet —</div>
        : <div className="columns-2 gap-x-4">{lines.map((l) => (
            <div key={l.id} className={`text-[10px] leading-snug font-mono pl-1.5 border-l-2 mb-0.5 break-inside-avoid ${kindStyle(l.kind)}`}>
              <span className="opacity-50">D{l.day} </span>{l.msg}
            </div>))}</div>}
    </div>
  );
}

const PHASE_LABEL: Record<string, string> = {
  assembling: "kitting up", moving: "moving", onstation: "on station", returning: "returning", complete: "",
};

// The squad you're commanding: its strength, status, and the standing SOP it's running.
function SquadReadout() {
  const world = useGame((s) => s.world)!;
  const activeSquadId = useGame((s) => s.activeSquadId);
  useGame((s) => s.tick);
  if (!activeSquadId) return <div className="font-mono text-[10px] text-inkdim pl-1 self-center">No squad selected — pick one in Task Org, or click a squad on the map.</div>;
  const sq = world.platoon.squads.find((s) => s.id === activeSquadId);
  if (!sq) return null;
  const members = sq.memberIds.map((id) => world.sim.unit(id)).filter((u): u is Unit => !!u);
  const alive = members.filter((u) => u.alive);
  const task = world.state.tasks.find((t) => sq.memberIds.some((id) => t.memberIds.includes(id)));
  const sop = task?.sop;
  const inContact = !!task && (!!task.squadState || (task.contactHold ?? 0) > 0 || alive.some((u) => u.visibleEnemyIds.length > 0 || u.suppression > 0.3));
  const avgComp = alive.reduce((a, u) => a + u.composure, 0) / Math.max(1, alive.length);
  return (
    <div className="font-mono text-[10px] min-w-[230px]">
      <div className="stencil text-[10px] text-amber mb-1">
        {sq.name}
        {task && <span className={`normal-case ${inContact ? "text-rust" : "text-good"}`}> · {inContact ? "IN CONTACT" : (PHASE_LABEL[task.phase] || "tasked")}</span>}
      </div>
      <div className="text-inkdim">{alive.length}/{members.length} effective · morale {Math.round(avgComp * 100)}</div>
      {sop ? (
        <div className="text-inkdim mt-0.5">SOP <span className="text-ink">{MOVEMENT_SOP_LABEL[sop.movement]} · {CONTACT_SOP_LABEL[sop.contact]} · {ROE_LABEL[sop.roe]}</span>{inContact && <span className="text-inkdim/60"> (locked)</span>}</div>
      ) : (
        <div className="text-inkdim/70 mt-0.5">at the COP — plan a patrol →</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- right column
function RightColumn() {
  const planning = useGame((s) => s.planning);
  const selectedVillage = useGame((s) => s.selectedVillage);
  const showVillage = !!selectedVillage && !planning;
  return (
    <div className="w-[344px] shrink-0 border-l border-line flex flex-col min-h-0">
      {showVillage ? (
        // village takes the ORDERS slot exactly as today; it's the elastic sink while open
        <div className="flex-1 min-h-0 overflow-y-auto border-b border-line"><VillagePanel villageId={selectedVillage!} /></div>
      ) : (
        <>
          <DockPanel id="orders" title="Squad Orders" defaultHeight={360} right={<DeployBadge />}><SquadOrdersBody /></DockPanel>
          <DockPanel id="taskorg" title="Task Organization" grow><TaskOrgBody /></DockPanel>
        </>
      )}
      <DockPanel id="logistics" title="Logistics" defaultHeight={182} last
        right={<><LogiBadge /><span onClick={(e) => e.stopPropagation()}><ResupplyButtons /></span></>}>
        <LogisticsBody />
      </DockPanel>
    </div>
  );
}

// The ● DEPLOYED indicator for the Squad Orders header (shown when the active squad is tasked).
function DeployBadge() {
  const world = useGame((s) => s.world)!;
  const activeSquadId = useGame((s) => s.activeSquadId);
  useGame((s) => s.tick);
  const activeSq = world.platoon.squads.find((s) => s.id === activeSquadId) ?? null;
  const activeTask = activeSq ? world.state.tasks.find((t) => activeSq.memberIds.some((id) => t.memberIds.includes(id))) : null;
  return activeTask ? <span className="text-good">● DEPLOYED</span> : <span className="text-inkdim">—</span>;
}

// A segmented button group — one row of the SOP card.
function Seg<T extends string>({ label, options, value, labelOf, descOf, onChange, disabled }: { label: string; options: T[]; value: T; labelOf: (v: T) => string; descOf?: (v: T) => string; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="mb-1">
      <div className="text-inkdim text-[9px] font-mono mb-0.5">{label}</div>
      <div className="flex gap-0.5 flex-wrap">
        {options.map((o) => (
          <button key={o} disabled={disabled} onClick={() => onChange(o)} title={descOf ? descOf(o) : labelOf(o)} className={`tac-btn text-[10px] px-1.5 py-0.5 ${value === o ? "active" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
            {labelOf(o)}
          </button>
        ))}
      </div>
    </div>
  );
}

// The squad's standing operating procedure: how they move, what they do on contact, the ROE.
function SopCard({ sop, onChange, locked }: { sop: SquadSOP; onChange: (patch: Partial<SquadSOP>) => void; locked?: boolean }) {
  return (
    <div className="border border-line bg-bg p-1 mb-1">
      <div className="flex justify-between items-center mb-0.5">
        <div className="stencil text-[9px] text-amber">Squad SOP</div>
        {locked && <span className="text-rust text-[9px] font-mono">LOCKED · in contact</span>}
      </div>
      <Seg label="MOVEMENT" options={MOVEMENTS} value={sop.movement} labelOf={(m) => MOVEMENT_SOP_LABEL[m]} descOf={(m) => MOVEMENT_DESC[m]} disabled={locked} onChange={(m) => onChange({ movement: m })} />
      <Seg label="ON CONTACT" options={CONTACTS} value={sop.contact} labelOf={(c) => CONTACT_SOP_LABEL[c]} descOf={(c) => CONTACT_DESC[c]} disabled={locked} onChange={(c) => onChange({ contact: c })} />
      <Seg label="RULES OF ENGAGEMENT" options={ROES} value={sop.roe} labelOf={(r) => ROE_LABEL[r]} descOf={(r) => ROE_DESC[r]} disabled={locked} onChange={(r) => onChange({ roe: r })} />
    </div>
  );
}

// The hot path: mission, SOP, officer-attach, route/step-off for the active squad.
function SquadOrdersBody() {
  const world = useGame((s) => s.world)!;
  const activeSquadId = useGame((s) => s.activeSquadId);
  const attachOfficers = useGame((s) => s.attachOfficers);
  const toggleOfficers = useGame((s) => s.toggleOfficers);
  const planning = useGame((s) => s.planning);
  const planRoute = useGame((s) => s.planRoute);
  const planMission = useGame((s) => s.planMission);
  const setMission = useGame((s) => s.setMission);
  const planSOP = useGame((s) => s.planSOP);
  const setPlanSOP = useGame((s) => s.setPlanSOP);
  const setPlanning = useGame((s) => s.setPlanning);
  const stepOff = useGame((s) => s.stepOff);
  const reroute = useGame((s) => s.reroute);
  const setSquadSOP = useGame((s) => s.setSquadSOP);
  const patrolIds = useGame((s) => s.patrolIds);
  useGame((s) => s.tick);

  const activeSq = world.platoon.squads.find((s) => s.id === activeSquadId) ?? null;
  const activeTask = activeSq ? world.state.tasks.find((t) => activeSq.memberIds.some((id) => t.memberIds.includes(id))) : null;
  // Mirror world.setSOP's lock exactly (whole TASK roster incl. attached officers, plus the
  // coordinator's combat state and the sticky-contact window) so the SOP card never shows
  // editable when setSOP would reject the edit.
  const inContact = !!activeTask && (!!activeTask.squadState || (activeTask.contactHold ?? 0) > 0 ||
    activeTask.memberIds.some((id) => { const u = world.sim.unit(id); return !!u && (u.visibleEnemyIds.length > 0 || u.suppression > 0.3); }));
  const ids = patrolIds();
  const hasMedic = ids.some((id) => world.platoon.members.find((x) => x.id === id)?.role === "medic");
  const canStep = !activeTask && ids.length > 0 && planRoute.length > 0;
  const canReroute = !!activeTask && planRoute.length > 0;

  const sop: SquadSOP = activeTask?.sop ?? planSOP;
  const onSop = (patch: Partial<SquadSOP>) => {
    if (activeTask) setSquadSOP(activeTask.id, { ...sop, ...patch });
    else setPlanSOP(patch);
  };

  return (
    <div className="p-2">
      {!activeSq ? (
        <div className="text-inkdim text-[10px] font-mono">Select a squad below (or click one on the map) to give it orders.</div>
      ) : (
        <>
          {!activeTask && (
            <div className="flex flex-wrap gap-1 mb-1">
              {MISSIONS.map((mt) => (
                <button key={mt} title={`${MISSION_LABEL[mt]} mission`} className={`tac-btn inline-flex items-center gap-1 text-[10px] px-2 py-1 ${planMission === mt ? "active" : ""}`} onClick={() => setMission(mt)}><Icon name={`ico-${mt}`} size={12} />{MISSION_LABEL[mt]}</button>
              ))}
            </div>
          )}
          <SopCard sop={sop} onChange={onSop} locked={inContact} />
          {!activeTask && !hasMedic && <div className="text-rust text-[10px] mb-1 font-mono">⚠ NO MEDIC — attach officers (HQ) for the doc, or expect bleed-outs.</div>}
          {!activeTask && (
            <label className="flex items-center gap-1.5 text-[10px] font-mono text-inkdim mb-1.5 cursor-pointer">
              <input type="checkbox" checked={attachOfficers} onChange={toggleOfficers} className="accent-amber w-4 h-4" />
              Send officers (HQ: PL · medic · RTO · JTAC)
            </label>
          )}
          <div className="text-inkdim text-[10px] mb-1 font-mono">{ids.length} pax · {planRoute.length} waypoints{planning ? " · click the map to draw" : ""}</div>
          <div className="flex gap-1">
            <button className={`tac-btn flex-1 ${planning ? "active" : ""}`} onClick={() => setPlanning(!planning)}>{planning ? "Drawing…" : "✚ Draw Route [R]"}</button>
            {activeTask
              ? <button className={`tac-btn flex-1 ${canReroute ? "active" : ""}`} disabled={!canReroute} onClick={reroute}>↳ Re-route</button>
              : <button className={`tac-btn flex-1 ${canStep ? "active" : ""}`} disabled={!canStep} onClick={stepOff}>▸ Step Off</button>}
          </div>
        </>
      )}
    </div>
  );
}

// The platoon's fixed squads — pick which to command (never a man). The elastic roster.
function TaskOrgBody() {
  const world = useGame((s) => s.world)!;
  const activeSquadId = useGame((s) => s.activeSquadId);
  const selectSquad = useGame((s) => s.selectSquad);
  const setJacket = useGame((s) => s.setJacket);
  useGame((s) => s.tick);
  return (
    <div className="p-2">
      {world.platoon.squads.map((sq) => {
        const members = sq.memberIds.map((id) => world.platoon.members.find((x) => x.id === id)).filter(Boolean) as NonNullable<ReturnType<typeof world.platoon.members.find>>[];
        const readyCount = members.filter((mm) => mm.alive && (mm.status === "ready" || mm.status === "rest")).length;
        const tasked = world.state.tasks.some((t) => t.memberIds.some((id) => sq.memberIds.includes(id)));
        const active = sq.id === activeSquadId;
        return (
          <div key={sq.id} className="mb-1.5">
            {/* clicking the active squad again COLLAPSES it (deselect) — no need to pick another */}
            <button
              className={`w-full flex justify-between items-center text-[11px] py-1 px-1.5 border ${active ? "border-amber bg-[#3a4126] text-amber" : "border-line bg-bg text-ink hover:border-olive"}`}
              onClick={() => selectSquad(active ? null : sq.id)}
              aria-expanded={active}
              title={active ? "Collapse this squad" : "Select & expand this squad"}
            >
              <span className="font-semibold inline-flex items-center gap-1.5">
                <span className="text-[9px] transition-transform inline-block" style={{ transform: active ? "rotate(90deg)" : "none" }}>▸</span>
                {sq.name}
              </span>
              <span className="font-mono text-[9px] text-inkdim">{tasked && <span className="text-good mr-1" title="An element of this squad is deployed">●deployed</span>}{readyCount}/{members.length} ready</span>
            </button>
            {active && (
              <div className="grid grid-cols-1 gap-px mt-0.5">
                {members.map((mm) => (
                  <div key={mm.id} className={`flex items-center gap-1.5 px-1.5 py-0.5 border border-line bg-bg text-left text-[10px] ${!mm.alive ? "opacity-40" : ""}`}>
                    <span title={STATUS_LABEL[mm.status] ?? mm.status} className={`w-1.5 h-1.5 rounded-full shrink-0 ${mm.status === "ready" ? "bg-good" : mm.status === "wounded" ? "bg-rust" : mm.status === "kia" ? "bg-[#444]" : "bg-amber"}`} />
                    <span className="font-mono text-inkdim w-9 shrink-0" title={`Rank: ${mm.rank}`}>{mm.rank}</span>
                    <span className="text-ink flex-1 truncate" title={`${mm.rank} ${mm.name} — ${roleFull(mm.role)}`}>{mm.name.split(" ").pop()}</span>
                    <span className="inline-flex items-center gap-1 text-inkdim shrink-0" title={roleFull(mm.role)}>
                      <Icon name={roleIcon(mm.role)} size={12} />
                      <span className="font-mono">{roleAbbr(mm.role)}</span>
                    </span>
                    <button title="Open service record" aria-label={`Service record — ${mm.rank} ${mm.name}`} onClick={() => setJacket(mm.id)} className="text-inkdim hover:text-amber shrink-0 inline-flex items-center justify-center w-6 h-6">ⓘ</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function VillagePanel({ villageId }: { villageId: string }) {
  const world = useGame((s) => s.world)!;
  const conductKLE = useGame((s) => s.conductKLE);
  const fundProject = useGame((s) => s.fundProject);
  const secureBuild = useGame((s) => s.secureBuild);
  const selectVillage = useGame((s) => s.selectVillage);
  const activeSquadId = useGame((s) => s.activeSquadId);
  const patrolIds = useGame((s) => s.patrolIds);
  useGame((s) => s.tick);
  const kleSquad = world.platoon.squads.find((s) => s.id === activeSquadId);
  const klePax = activeSquadId && activeSquadId !== "hq" ? patrolIds().length : 0;
  const v = world.state.villages.find((x) => x.id === villageId);
  if (!v) return null;
  const attColor = v.attitude > 20 ? "#6fae54" : v.attitude < -20 ? "#c0392b" : "#e0a72b";
  // The in-flight project (not yet complete). A funded project sits at "building"/"securing" until
  // an element holds the site for the full build; otherwise the enemy SABOTAGES it.
  const proj = world.state.projects.find((p) => p.villageId === v.id && p.stage !== "complete");
  // Is an element already SECURING this site? (a secure task bound to this village, en route or holding)
  const securing = world.state.tasks.some((t) => t.kind === "secure" && t.secureVillageId === v.id && t.phase !== "complete");
  const canSecure = !!proj && proj.stage !== "sabotaged";
  return (
    <div className="border-b border-line p-2 flex-1 min-h-0 overflow-y-auto">
      <div className="flex justify-between items-center mb-2">
        <div className="stencil text-[11px] text-amber">{v.name}</div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={() => selectVillage(null)} aria-label="Close village panel">✕</button>
      </div>
      <div className="text-[11px] text-inkdim mb-1 font-mono">Elder: <span className="text-ink">{v.elder}</span></div>
      <div className="text-[11px] text-inkdim mb-2 font-mono">Pop ~{v.population} · {v.censusDone ? "censused" : "no census"} · wants a {v.wants}</div>
      <div className="space-y-1.5 mb-3">
        <Bar label="Attitude" value={(v.attitude + 100) / 2} color={attColor} />
        <Bar label="Coop." value={v.cooperation} color="#5b9bd8" />
        <Bar label="ACM Symp." value={v.sympathy} color="#c0392b" />
      </div>
      {/* Elder's ASK — the promise the player can keep or break. Surfacing it lets a human DRIVE
          the kept-promise mechanic (the headless harness can't align the build to the ask). */}
      {v.ask && !v.ask.fulfilled && (
        <div className="bg-bg border border-amber p-1.5 mb-2 text-[10px] font-mono">
          <div className="text-amber stencil text-[9px]">Elder Request · by D{v.ask.deadlineDay}</div>
          <div className="text-ink mt-0.5 leading-snug normal-case">{v.ask.desc}</div>
          {v.ask.kind === "project" && v.ask.projectType && <div className="text-inkdim mt-0.5">— build the {v.ask.projectType} below to keep this promise</div>}
        </div>
      )}
      {(v.keptPromises > 0 || v.brokenPromises > 0) && (
        <div className="text-[9px] text-inkdim mb-2 font-mono">promises kept <span className="text-good">{v.keptPromises}</span> · broken <span className="text-rust">{v.brokenPromises}</span></div>
      )}
      {v.projects.length > 0 && <div className="text-[10px] text-inkdim mb-2 font-mono">Built: <span className="text-us">{v.projects.join(", ")}</span></div>}
      {proj && (
        <div className="bg-bg border border-line p-1.5 mb-2 text-[10px] font-mono">
          <div className="text-ink">{proj.type} — <span className={proj.stage === "building" ? "text-us" : proj.stage === "sabotaged" ? "text-rust" : "text-amber"}>{securing && proj.stage !== "sabotaged" ? "securing" : proj.stage.replace(/_/g, " ")}</span></div>
          {proj.stage === "building" && <div className="h-1 bg-panel2 mt-1 border border-line"><div className="h-full bg-us" style={{ width: `${proj.progress * 100}%` }} /></div>}
          {proj.stage !== "sabotaged" && (
            <div className={`mt-0.5 ${securing ? "text-good" : "text-rust"}`}>{securing ? "● an element is securing the site — the work proceeds" : "⚠ unsecured — assign a squad to hold the site or it will be SABOTAGED"}</div>
          )}
          {proj.stage === "sabotaged" && <div className="text-rust mt-0.5">sabotaged — the elders saw you could not protect it</div>}
        </div>
      )}
      {/* SECURE-BUILD order (TARGET 1): assign the active squad to garrison the project site. Routes
          via the normal patrol machinery (no map gesture). Disabled with a reason when not driveable. */}
      {canSecure && (
        <button className={`tac-btn w-full mb-2 ${securing ? "active" : ""}`} disabled={securing} onClick={() => secureBuild(v.id)}>
          🛡 {securing ? "Site being secured" : `Secure the Build Site${klePax ? ` — ${kleSquad?.name ?? "squad"}` : " — HQ element"}`}
        </button>
      )}
      <button className="tac-btn w-full mb-2" onClick={() => conductKLE(v.id)}>
        ☕ Send for Shura (KLE){klePax ? ` — ${kleSquad?.name ?? "squad"}` : " — HQ element"}
      </button>
      <div className="stencil text-[10px] text-amber mb-1">CERP Projects <span className="text-inkdim normal-case">(${world.state.cerp.toLocaleString()} · $5k ea){cerpNextHint(world)}</span></div>
      <div className="flex flex-wrap gap-1">
        {CERP_PROJECTS.map((p) => {
          const asked = v.ask?.kind === "project" && v.ask.projectType === p; // the elder specifically asked for this one
          return (
            <button key={p} disabled={world.state.cerp < 5000 || v.projects.includes(p) || !!proj}
              title={v.projects.includes(p) ? `${p} is already built here` : proj ? "A project is already in progress here" : world.state.cerp < 5000 ? `Need $5k — you have $${world.state.cerp.toLocaleString()}` : `Fund a ${p} ($5k)${asked ? " — the elder asked for this" : ""}`}
              className={`tac-btn inline-flex items-center gap-1 text-[10px] px-2 py-1 ${asked ? "border-amber tac-btn-danger" : v.wants === p ? "border-amber" : ""}`} onClick={() => fundProject(v.id, p)}>
              <Icon name={cerpIcon(p)} size={12} />{v.projects.includes(p) ? "✓ " : ""}{asked ? "★ " : ""}{p}
            </button>
          );
        })}
      </div>
      <div className="text-inkdim text-[9px] mt-1 font-mono">Projects need materials trucked in, a contractor, and a squad SECURING the site for days — fund it, then secure it. ★ = the elder asked for it.</div>
    </div>
  );
}

// CERP is a two-way budget now: a battalion stipend lands on a cadence (income) and a delivered
// project earns a partial refund. Surface the next disbursement so the player reads it as managed
// money, not a one-way drain. (DAY = 86400 s; this is a UI display calc only, no sim state.)
function cerpNextHint(world: NonNullable<ReturnType<typeof useGame.getState>["world"]>): string {
  const next = world.state.nextCerpStipendAt;
  if (typeof next !== "number") return "";
  const days = Math.max(0, Math.ceil((next - world.state.clock) / 86400));
  return ` · next stipend ~${days}d`;
}

const SUPPLY_ROWS: { key: keyof Supplies; label: string; max: number; warn: number; icon: string; desc: string }[] = [
  { key: "ammo_556", label: "5.56mm", max: 24000, warn: 6000, icon: "ico-ammo", desc: "5.56mm rifle & SAW ammunition" },
  { key: "ammo_762", label: "7.62mm", max: 9000, warn: 2000, icon: "ico-ammo", desc: "7.62mm machine-gun ammunition" },
  { key: "mortar_60", label: "60mm", max: 120, warn: 20, icon: "ico-mortar", desc: "60mm mortar rounds" },
  { key: "mortar_81", label: "81mm", max: 80, warn: 15, icon: "ico-mortar", desc: "81mm mortar rounds" },
  { key: "construction", label: "build mat.", max: 80, warn: 12, icon: "ico-construction", desc: "Construction materials for CERP projects" },
  { key: "medical", label: "med kits", max: 44, warn: 8, icon: "ico-medical", desc: "Medical supplies / IFAKs" },
  { key: "water", label: "water", max: 600, warn: 100, icon: "ico-water", desc: "Drinking water (gallons)" },
  { key: "food", label: "food", max: 560, warn: 100, icon: "ico-food", desc: "Rations (man-days)" },
];

// Convoy/Air request buttons — live in the Logistics dock header right slot. The wrapper in
// RightColumn stops propagation so clicking these never toggles the panel collapse.
function ResupplyButtons() {
  const world = useGame((s) => s.world)!;
  const requestResupply = useGame((s) => s.requestResupply);
  useGame((s) => s.tick);
  const inbound = world.state.resupplies[0];
  return (
    <span className="inline-flex gap-1">
      <button className="tac-btn text-[9px] px-1.5 py-0.5" disabled={!!inbound} title={inbound ? "A resupply is already inbound" : "Request a ground convoy resupply"} onClick={() => requestResupply("convoy")}>Convoy</button>
      <button className="tac-btn text-[9px] px-1.5 py-0.5" disabled={!!inbound || !world.state.weather.airAvailable} title={inbound ? "A resupply is already inbound" : !world.state.weather.airAvailable ? "Air is NO-GO — weather below mins" : "Request an air resupply"} onClick={() => requestResupply("air")}>Air</button>
    </span>
  );
}

// Low-supply warning glyph for the collapsed Logistics header.
function LogiBadge() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const s = world.state.supplies;
  const low = SUPPLY_ROWS.some((row) => s[row.key] < row.warn);
  return low ? <span className="text-rust mr-1">⚠</span> : null;
}

function LogisticsBody() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const s = world.state.supplies;
  const inbound = world.state.resupplies[0];
  return (
    <div className="p-2">
      {inbound && <div className="text-us text-[10px] font-mono mb-1">⟳ {inbound.kind} resupply inbound (~{Math.max(0, Math.round((inbound.eta - world.state.clock) / 3600))} h)</div>}
      <div className="space-y-1">
        {SUPPLY_ROWS.map((row) => {
          const val = s[row.key];
          const low = val < row.warn;
          return <Bar key={row.key} title={`${row.desc} — ${val.toLocaleString()} on hand${low ? " (LOW)" : ""}`} label={<><Icon name={row.icon} size={11} className="text-inkdim" />{row.label}</>} value={val} max={row.max} suffix="" color={low ? "#c0392b" : "#6b7a3a"} />;
        })}
      </div>
      <div className="text-[10px] text-inkdim mt-2 font-mono">CERP funds: <span className="text-amber">${world.state.cerp.toLocaleString()}</span>{cerpNextHint(world)}</div>
      <div className="text-[9px] text-inkdim/70 font-mono">Battalion disburses a stipend on a cadence; delivered projects earn a partial refund.</div>
    </div>
  );
}

// ---------------------------------------------------------------- modals
function AttrBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <span className="w-[78px] text-inkdim">{label}</span>
      <div className="flex-1 h-1.5 bg-bg border border-line overflow-hidden">
        <div className="h-full bg-olive" style={{ width: Math.round(v * 100) + "%" }} />
      </div>
    </div>
  );
}

function SoldierJacket() {
  const world = useGame((s) => s.world)!;
  const jacketId = useGame((s) => s.jacketId);
  const setJacket = useGame((s) => s.setJacket);
  useGame((s) => s.tick);
  if (!jacketId) return null;
  const m = world.platoon.members.find((x) => x.id === jacketId);
  if (!m) return null;
  const sq = world.platoon.squads.find((s) => s.memberIds.includes(jacketId));
  const statusColor = m.status === "ready" ? "#6fae54" : m.status === "wounded" ? "#c0392b" : m.status === "kia" ? "#777" : "#e0a72b";
  return (
    <Modal onClose={() => setJacket(null)} labelledBy="jacket-title" width="w-[460px]">
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="stencil text-[10px] text-amber">Service Record</div>
            <h2 id="jacket-title" className="text-ink text-xl font-bold leading-tight">{m.rank} {m.name}</h2>
            {m.nickname && <div className="text-tan text-sm italic">&ldquo;{m.nickname}&rdquo;</div>}
          </div>
          <button className="tac-btn text-[10px] px-2 py-0.5" onClick={() => setJacket(null)} aria-label="Close service record">✕</button>
        </div>
        <div className="flex gap-3 text-[11px] font-mono text-inkdim mb-3 flex-wrap">
          <span>{roleAbbr(m.role)} · <span className="text-ink">{m.role.replace(/_/g, " ")}</span></span>
          <span>{sq?.name ?? "—"}</span>
          <span>{m.homeState}</span>
          <span style={{ color: statusColor }}>● {m.status.toUpperCase()}</span>
        </div>
        <p className="text-inkdim text-[12px] italic border-l-2 border-line pl-3 mb-3">{m.bio}</p>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 mb-3">
          <AttrBar label="Marksmanship" v={m.marksmanship} />
          <AttrBar label="Composure" v={m.composureMax} />
          <AttrBar label="Leadership" v={m.leadership} />
          <AttrBar label="Medical" v={m.medical} />
          <AttrBar label="Fitness" v={m.fitnessMax} />
          <AttrBar label="Stealth" v={m.stealth} />
          <AttrBar label="Experience" v={m.experience} />
          <AttrBar label="Aggression" v={m.aggression} />
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2 font-mono text-[11px]">
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">REST</div><div className="text-ink">{Math.round(m.rest * 100)}%</div></div>
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">MORALE</div><div className="text-ink">{Math.round(m.morale * 100)}%</div></div>
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">ENEMY KIA</div><div className="text-ink">{m.kills}</div></div>
        </div>
        {m.status === "wounded" && <div className="text-rust text-[11px] font-mono">WIA — est. {Math.ceil(m.daysToRecover)} day(s) to return.{m.wounds.length ? ` Wounds: ${m.wounds.map((w) => w.region).join(", ")}.` : ""}</div>}
        {m.status === "kia" && <div className="text-rust text-[12px]">Killed in action. Rest easy, {m.name.split(" ").pop()}.</div>}
    </Modal>
  );
}

function EventModal() {
  const world = useGame((s) => s.world)!;
  const resolveEvent = useGame((s) => s.resolveEvent);
  useGame((s) => s.tick);
  const ev = world.pendingEvent;
  if (!ev) return null;
  // decision-forcing: focus is trapped + labelled, but Escape/backdrop do NOT dismiss —
  // the commander must choose. (Modal swallows Escape so the global handler stays inert.)
  return (
    <Modal onClose={() => {}} dismissable={false} labelledBy="event-title" width="w-[520px]">
        <div className="stencil text-amber text-xs mb-1">Situation · {ev.kind.replace(/^dwell_/, "").replace(/_/g, " ")} · {world.clockLabel()}</div>
        <h2 id="event-title" className="text-ink text-xl font-bold mb-2">{ev.title}</h2>
        <p className="text-inkdim text-sm leading-relaxed mb-4">{ev.body}</p>
        <div className="flex flex-col gap-2">
          {ev.choices.map((c) => (
            <button key={c.id} className="tac-btn text-left normal-case w-full py-2" onClick={() => resolveEvent(c.id)}>
              <span className="text-ink">{c.label}</span>
              {c.hint && <span className="block text-[10px] text-inkdim normal-case mt-0.5">{c.hint}</span>}
            </button>
          ))}
        </div>
    </Modal>
  );
}
