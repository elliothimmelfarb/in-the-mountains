"use client";
import { useEffect, type ReactNode } from "react";
import { useGame, SPEEDS } from "@/state/store";
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

function Bar({ label, value, color = "#6b7a3a", max = 100, suffix = "%" }: { label: ReactNode; value: number; color?: string; max?: number; suffix?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <div className="w-[80px] text-inkdim shrink-0 inline-flex items-center gap-1">{label}</div>
      <div className="flex-1 h-2.5 bg-bg border border-line relative overflow-hidden">
        <div className="h-full" style={{ width: pct + "%", background: color }} />
      </div>
      <div className="w-[40px] text-right text-ink">{Math.round(value)}{suffix}</div>
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

export default function DeployScreen() {
  const world = useGame((s) => s.world);
  const togglePause = useGame((s) => s.togglePause);
  const setSpeed = useGame((s) => s.setSpeed);
  const toggleWarp = useGame((s) => s.toggleWarp);
  const setFireSupport = useGame((s) => s.setFireSupport);
  const setPlanning = useGame((s) => s.setPlanning);
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
      if (e.key === "1") setSpeed(1);
      if (e.key === "2") setSpeed(2);
      if (e.key === "3") setSpeed(4);
      if (e.key === "4") setSpeed(8);
      if (e.key === "5") setSpeed(16);
      if (k === "T") toggleWarp();
      if (k === "R") setPlanning(!useGame.getState().planning); // R = draw/route mode for the active squad
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
    <div className="w-full h-full flex flex-col">
      <CommandBar />
      <div className="flex-1 flex min-h-0">
        <div className="w-[272px] shrink-0 border-r border-line flex flex-col min-h-0">
          <TasksPanel />
          <DirectivesPanel />
          <IntelPanel />
          <LogPanel />
        </div>
        <div className="flex-1 relative min-w-0">
          <WorldView />
          <MapControls />
          <BannerOverlay />
          <OrderBar />
        </div>
        <RightColumn />
      </div>
      <EventModal />
      <SoldierJacket />
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
      <div className="flex-1 flex items-center px-3">
        <div className="flex-1 grid grid-cols-5 gap-2.5 max-w-[620px]">
          <Bar label="Stability" value={m.stability} color="#6fae54" />
          <Bar label="Attitudes" value={m.attitude} color="#e0a72b" />
          <Bar label="Enemy" value={m.enemyStrength} color="#c0392b" />
          <Bar label="Comb. Pwr" value={m.combatPower} color="#5b9bd8" />
          <Bar label="Higher" value={m.higherConfidence} color="#c2a878" />
        </div>
      </div>
      {/* time controls */}
      <div className="flex items-center px-2 gap-1 border-l border-line">
        {inContact && <span className="stencil text-rust text-[10px] blink mr-1">● TIC</span>}
        <button className={`tac-btn px-2 py-1 ${paused ? "active" : ""}`} onClick={togglePause} title="Pause (Space)">{paused ? "▶" : "⏸"}</button>
        {SPEEDS.map((s) => {
          const disabled = inContact && s > 4;
          return (
            <button key={s} disabled={disabled} className={`tac-btn px-2 py-1 ${!paused && !warp && speed === s ? "active" : ""}`} onClick={() => setSpeed(s)}>{s}×</button>
          );
        })}
        <button disabled={inContact} className={`tac-btn px-2 py-1 ${warp ? "active" : ""}`} onClick={toggleWarp} title="Skip to next event (T)">⏩</button>
      </div>
      <button className="tac-btn rounded-none border-y-0 border-r-0 px-3" onClick={gotoMenu}>☰</button>
    </div>
  );
}

// ---------------------------------------------------------------- left column
function TasksPanel() {
  const world = useGame((s) => s.world)!;
  const recallTask = useGame((s) => s.recallTask);
  useGame((s) => s.tick);
  const tasks = world.state.tasks;
  return (
    <div className="border-b border-line p-2">
      <div className="stencil text-[10px] text-amber mb-1.5">Active Elements</div>
      {tasks.length === 0 && <div className="text-inkdim text-[11px] italic">All elements at the COP.</div>}
      <div className="flex flex-col gap-1">
        {tasks.map((t) => (
          <div key={t.id} className="bg-bg border border-line p-1.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-ink text-[11px] font-semibold truncate">{t.label}</div>
              <div className="text-inkdim text-[9px] font-mono">{t.memberIds.length} pax · {t.phase}{t.phase === "assembling" ? ` ${Math.ceil(t.timer)}s` : ""} · {t.technique}</div>
            </div>
            <button className="tac-btn text-[9px] px-1.5 py-0.5 shrink-0" onClick={() => recallTask(t.id)}>recall</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DirectivesPanel() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const active = world.state.directives.filter((d) => d.status === "active");
  if (active.length === 0) return null;
  return (
    <div className="border-b border-line p-2">
      <div className="stencil text-[10px] text-amber mb-1.5">Battalion Directives</div>
      <div className="flex flex-col gap-1.5">
        {active.map((d) => (
          <div key={d.id} className="bg-bg border border-line p-1.5">
            <div className="flex justify-between items-baseline">
              <span className="text-ink text-[11px] font-semibold">{d.title}</span>
              <span className="text-inkdim font-mono text-[9px]">D{d.deadlineDay}</span>
            </div>
            <div className="text-inkdim text-[10px] leading-snug mt-0.5">{d.desc}</div>
            <div className="h-1 bg-panel2 mt-1 border border-line">
              <div className="h-full bg-olive" style={{ width: `${d.progress * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntelPanel() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  return (
    <div className="border-b border-line p-2 flex-1 min-h-0 flex flex-col">
      <div className="stencil text-[10px] text-amber mb-1.5">Intel Feed</div>
      <div className="overflow-y-auto flex-1 flex flex-col gap-1 pr-1">
        {world.state.intel.slice(0, 26).map((r) => (
          <div key={r.id} className="text-[10px] leading-snug border-l-2 pl-1.5" style={{ borderColor: r.source === "SIGINT" ? "#e0a72b" : r.source === "HUMINT" ? "#6fae54" : "#c89c5c" }}>
            <span className="font-mono text-inkdim">[{r.source} ·{Math.round(r.reliability * 100)}%] </span>
            <span className="text-ink">{r.text}</span>
          </div>
        ))}
        {world.state.intel.length === 0 && <div className="text-inkdim italic text-[11px]">No reporting yet. Patrol and talk to people.</div>}
      </div>
    </div>
  );
}

function LogPanel() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const recent = world.state.log.slice(-40).reverse();
  return (
    <div className="p-2 h-[150px] flex flex-col">
      <div className="stencil text-[10px] text-amber mb-1.5">Command Log</div>
      <div className="overflow-y-auto flex-1 flex flex-col gap-0.5 pr-1">
        {recent.map((l) => (
          <div key={l.id} className={`text-[10px] leading-snug ${l.kind === "kia" ? "text-rust" : l.kind === "objective" ? "text-amber" : l.kind === "casualty" ? "text-tan" : l.kind === "support" ? "text-us" : l.kind === "contact" ? "text-amber" : "text-inkdim"}`}>
            <span className="font-mono opacity-60">D{l.day} </span>
            {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
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
    <div className="absolute bottom-0 left-0 right-0 bg-panel/95 border-t border-line p-2 z-10">
      <div className="flex items-start gap-3 flex-wrap">
        <SquadReadout />
        {fr && (
          <div className="border-l border-rust pl-3 animate-pulse">
            <div className="stencil text-[9px] text-rust mb-1">▲ Call for Fire — {fr.label}</div>
            <div className="font-mono text-[10px] text-ink max-w-[200px] mb-1">{fr.reason}. Requesting <span className="text-amber">{getWeapon(fr.weaponId).short}</span> on grid {String(fr.cx).padStart(3, "0")}–{String(fr.cy).padStart(3, "0")}.</div>
            <div className="flex gap-1">
              <button className="tac-btn tac-btn-danger active flex-1 text-[10px]" onClick={approveFires}>✓ CLEARED HOT</button>
              <button className="tac-btn flex-1 text-[10px]" onClick={denyFires}>✕ DENY</button>
            </div>
          </div>
        )}
        <div className="border-l border-line pl-3">
          <div className="stencil text-[9px] text-amber mb-1">Fire Support <span className="text-inkdim normal-case">— click the map to place</span></div>
          <div className="flex flex-col gap-1 max-w-[230px]">
            {sim.mortars.map((mt) => {
              const wp = getWeapon(mt.weaponId);
              return (
                <button key={mt.weaponId} disabled={mt.rounds <= 0} className={`tac-btn inline-flex items-center gap-1.5 text-left text-[10px] ${fireSupport?.weaponId === mt.weaponId ? "active" : ""}`} onClick={() => setFireSupport(mt.weaponId, `${wp.short} ×4`, 4)}>
                  <Icon name="ico-mortar" size={13} /> {wp.name} <span className="text-inkdim">({mt.rounds})</span>
                </button>
              );
            })}
            <div className="flex gap-1">
              <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn inline-flex items-center justify-center gap-1 text-[10px] flex-1 ${fireSupport?.weaponId === "cas_gun" ? "active" : ""}`} onClick={() => setFireSupport("cas_gun", "CAS GUN RUN")}><Icon name="ico-cas-gun" size={13} /> Gun</button>
              <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn inline-flex items-center justify-center gap-1 text-[10px] flex-1 ${fireSupport?.weaponId === "cas_rocket" ? "active" : ""}`} onClick={() => setFireSupport("cas_rocket", "CAS HELLFIRE")}><Icon name="ico-cas-hellfire" size={13} /> Hellfire</button>
            </div>
            <button className={`tac-btn inline-flex items-center justify-center gap-1 text-[10px] ${casualtyInField ? "tac-btn-danger active" : ""}`} onClick={medevacSelected}>
              <Icon name="ico-medevac" size={13} /> 9-LINE MEDEVAC {casualtyInField && <span className="text-[9px]">· casualty down</span>}
            </button>
          </div>
        </div>
      </div>
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
  return (
    <div className="w-[336px] shrink-0 border-l border-line flex flex-col min-h-0">
      {selectedVillage && !planning ? <VillagePanel villageId={selectedVillage} /> : <ElementPanel />}
      <LogisticsPanel />
    </div>
  );
}

// A segmented button group — one row of the SOP card.
function Seg<T extends string>({ label, options, value, labelOf, onChange, disabled }: { label: string; options: T[]; value: T; labelOf: (v: T) => string; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="mb-1">
      <div className="text-inkdim text-[9px] font-mono mb-0.5">{label}</div>
      <div className="flex gap-0.5 flex-wrap">
        {options.map((o) => (
          <button key={o} disabled={disabled} onClick={() => onChange(o)} className={`tac-btn text-[10px] px-1.5 py-0.5 ${value === o ? "active" : ""} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}>
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
    <div className="border border-line bg-bg p-1.5 mb-1.5">
      <div className="flex justify-between items-center mb-1">
        <div className="stencil text-[9px] text-amber">Squad SOP</div>
        {locked && <span className="text-rust text-[9px] font-mono">LOCKED · in contact</span>}
      </div>
      <Seg label="MOVEMENT" options={MOVEMENTS} value={sop.movement} labelOf={(m) => MOVEMENT_SOP_LABEL[m]} disabled={locked} onChange={(m) => onChange({ movement: m })} />
      <Seg label="ON CONTACT" options={CONTACTS} value={sop.contact} labelOf={(c) => CONTACT_SOP_LABEL[c]} disabled={locked} onChange={(c) => onChange({ contact: c })} />
      <Seg label="RULES OF ENGAGEMENT" options={ROES} value={sop.roe} labelOf={(r) => ROE_LABEL[r]} disabled={locked} onChange={(r) => onChange({ roe: r })} />
    </div>
  );
}

function ElementPanel() {
  const world = useGame((s) => s.world)!;
  const activeSquadId = useGame((s) => s.activeSquadId);
  const selectSquad = useGame((s) => s.selectSquad);
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
  const setJacket = useGame((s) => s.setJacket);
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
    <div className="border-b border-line flex flex-col min-h-0 flex-1">
      {/* orders for the active squad */}
      <div className="p-2 border-b border-line">
        <div className="flex items-center justify-between mb-1.5">
          <div className="stencil text-[10px] text-amber">{activeSq ? `${activeSq.name} — Orders` : "Squad Orders"}</div>
          {activeTask && <span className="text-[9px] font-mono text-good">● DEPLOYED</span>}
        </div>
        {!activeSq ? (
          <div className="text-inkdim text-[10px] font-mono">Select a squad below (or click one on the map) to give it orders.</div>
        ) : (
          <>
            {!activeTask && (
              <div className="flex flex-wrap gap-1 mb-1.5">
                {MISSIONS.map((mt) => (
                  <button key={mt} className={`tac-btn inline-flex items-center gap-1 text-[10px] px-2 py-1 ${planMission === mt ? "active" : ""}`} onClick={() => setMission(mt)}><Icon name={`ico-${mt}`} size={12} />{MISSION_LABEL[mt]}</button>
                ))}
              </div>
            )}
            <SopCard sop={sop} onChange={onSop} locked={inContact} />
            {!activeTask && !hasMedic && <div className="text-rust text-[10px] mb-1 font-mono">⚠ NO MEDIC — attach officers (HQ) for the doc, or expect bleed-outs.</div>}
            {!activeTask && (
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-inkdim mb-1.5 cursor-pointer">
                <input type="checkbox" checked={attachOfficers} onChange={toggleOfficers} className="accent-amber" />
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
      {/* the platoon's fixed squads — pick which to command (never a man) */}
      <div className="p-2 overflow-y-auto flex-1 min-h-0">
        <div className="stencil text-[10px] text-amber mb-1.5">Task Organization</div>
        {world.platoon.squads.map((sq) => {
          const members = sq.memberIds.map((id) => world.platoon.members.find((x) => x.id === id)).filter(Boolean) as NonNullable<ReturnType<typeof world.platoon.members.find>>[];
          const readyCount = members.filter((mm) => mm.alive && (mm.status === "ready" || mm.status === "rest")).length;
          const tasked = world.state.tasks.some((t) => t.memberIds.some((id) => sq.memberIds.includes(id)));
          const active = sq.id === activeSquadId;
          return (
            <div key={sq.id} className="mb-2">
              <button className={`w-full flex justify-between items-center text-[11px] py-1 px-1.5 border ${active ? "border-amber bg-[#3a4126] text-amber" : "border-line bg-bg text-ink hover:border-olive"}`} onClick={() => selectSquad(sq.id)}>
                <span className="font-semibold inline-flex items-center gap-1.5">{active && <span>▸</span>}{sq.name}</span>
                <span className="font-mono text-[9px] text-inkdim">{tasked && <span className="text-good mr-1">●deployed</span>}{readyCount}/{members.length} ready</span>
              </button>
              {active && (
                <div className="grid grid-cols-1 gap-0.5 mt-0.5">
                  {members.map((mm) => (
                    <div key={mm.id} className={`flex items-center gap-1.5 px-1.5 py-0.5 border border-line bg-bg text-left text-[10px] ${!mm.alive ? "opacity-40" : ""}`}>
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${mm.status === "ready" ? "bg-good" : mm.status === "wounded" ? "bg-rust" : mm.status === "kia" ? "bg-[#444]" : "bg-amber"}`} />
                      <span className="font-mono text-inkdim w-9 shrink-0">{mm.rank}</span>
                      <span className="text-ink flex-1 truncate">{mm.name.split(" ").pop()}</span>
                      <Icon name={roleIcon(mm.role)} size={12} className="text-inkdim" />
                      <span className="text-inkdim font-mono">{roleAbbr(mm.role)}</span>
                      <button title="Service record" onClick={() => setJacket(mm.id)} className="text-inkdim hover:text-amber px-1 shrink-0">ⓘ</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VillagePanel({ villageId }: { villageId: string }) {
  const world = useGame((s) => s.world)!;
  const conductKLE = useGame((s) => s.conductKLE);
  const fundProject = useGame((s) => s.fundProject);
  const selectVillage = useGame((s) => s.selectVillage);
  const activeSquadId = useGame((s) => s.activeSquadId);
  const patrolIds = useGame((s) => s.patrolIds);
  useGame((s) => s.tick);
  const kleSquad = world.platoon.squads.find((s) => s.id === activeSquadId);
  const klePax = activeSquadId && activeSquadId !== "hq" ? patrolIds().length : 0;
  const v = world.state.villages.find((x) => x.id === villageId);
  if (!v) return null;
  const attColor = v.attitude > 20 ? "#6fae54" : v.attitude < -20 ? "#c0392b" : "#e0a72b";
  const proj = world.state.projects.find((p) => p.villageId === v.id && p.stage !== "complete");
  return (
    <div className="border-b border-line p-2 flex-1 min-h-0 overflow-y-auto">
      <div className="flex justify-between items-center mb-2">
        <div className="stencil text-[11px] text-amber">{v.name}</div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={() => selectVillage(null)}>✕</button>
      </div>
      <div className="text-[11px] text-inkdim mb-1 font-mono">Elder: <span className="text-ink">{v.elder}</span></div>
      <div className="text-[11px] text-inkdim mb-2 font-mono">Pop ~{v.population} · {v.censusDone ? "censused" : "no census"} · wants a {v.wants}</div>
      <div className="space-y-1.5 mb-3">
        <Bar label="Attitude" value={(v.attitude + 100) / 2} color={attColor} />
        <Bar label="Coop." value={v.cooperation} color="#5b9bd8" />
        <Bar label="ACM Symp." value={v.sympathy} color="#c0392b" />
      </div>
      {v.projects.length > 0 && <div className="text-[10px] text-inkdim mb-2 font-mono">Built: <span className="text-us">{v.projects.join(", ")}</span></div>}
      {proj && (
        <div className="bg-bg border border-line p-1.5 mb-2 text-[10px] font-mono">
          <div className="text-ink">{proj.type} — <span className={proj.stage === "building" ? "text-us" : proj.stage === "sabotaged" ? "text-rust" : "text-amber"}>{proj.stage.replace(/_/g, " ")}</span></div>
          {proj.stage === "building" && <div className="h-1 bg-panel2 mt-1 border border-line"><div className="h-full bg-us" style={{ width: `${proj.progress * 100}%` }} /></div>}
          {proj.stage === "building" && <div className="text-inkdim mt-0.5">needs a squad securing the site to progress</div>}
        </div>
      )}
      <button className="tac-btn w-full mb-2" onClick={() => conductKLE(v.id)}>
        ☕ Send for Shura (KLE){klePax ? ` — ${kleSquad?.name ?? "squad"}` : " — HQ element"}
      </button>
      <div className="stencil text-[10px] text-amber mb-1">CERP Projects <span className="text-inkdim normal-case">(${world.state.cerp.toLocaleString()} · $5k ea)</span></div>
      <div className="flex flex-wrap gap-1">
        {CERP_PROJECTS.map((p) => (
          <button key={p} disabled={world.state.cerp < 5000 || v.projects.includes(p) || !!proj} className={`tac-btn inline-flex items-center gap-1 text-[10px] px-2 py-1 ${v.wants === p ? "border-amber" : ""}`} onClick={() => fundProject(v.id, p)}>
            <Icon name={cerpIcon(p)} size={12} />{v.projects.includes(p) ? "✓ " : ""}{p}
          </button>
        ))}
      </div>
      <div className="text-inkdim text-[9px] mt-1 font-mono">Projects need materials trucked in, a contractor, and security on the site for days.</div>
    </div>
  );
}

const SUPPLY_ROWS: { key: keyof Supplies; label: string; max: number; warn: number; icon: string }[] = [
  { key: "ammo_556", label: "5.56mm", max: 24000, warn: 6000, icon: "ico-ammo" },
  { key: "ammo_762", label: "7.62mm", max: 9000, warn: 2000, icon: "ico-ammo" },
  { key: "mortar_60", label: "60mm", max: 120, warn: 20, icon: "ico-mortar" },
  { key: "mortar_81", label: "81mm", max: 80, warn: 15, icon: "ico-mortar" },
  { key: "construction", label: "build mat.", max: 80, warn: 12, icon: "ico-construction" },
  { key: "medical", label: "med kits", max: 44, warn: 8, icon: "ico-medical" },
  { key: "water", label: "water", max: 600, warn: 100, icon: "ico-water" },
  { key: "food", label: "food", max: 560, warn: 100, icon: "ico-food" },
];

function LogisticsPanel() {
  const world = useGame((s) => s.world)!;
  const requestResupply = useGame((s) => s.requestResupply);
  useGame((s) => s.tick);
  const s = world.state.supplies;
  const inbound = world.state.resupplies[0];
  return (
    <div className="p-2 h-[230px] overflow-y-auto">
      <div className="flex items-center justify-between mb-1.5">
        <div className="stencil text-[10px] text-amber">Logistics</div>
        <div className="flex gap-1">
          <button className="tac-btn text-[9px] px-1.5 py-0.5" disabled={!!inbound} onClick={() => requestResupply("convoy")}>Convoy</button>
          <button className="tac-btn text-[9px] px-1.5 py-0.5" disabled={!!inbound || !world.state.weather.airAvailable} onClick={() => requestResupply("air")}>Air</button>
        </div>
      </div>
      {inbound && <div className="text-us text-[10px] font-mono mb-1">⟳ {inbound.kind} resupply inbound (~{Math.max(0, Math.round((inbound.eta - world.state.clock) / 3600))} h)</div>}
      <div className="space-y-1">
        {SUPPLY_ROWS.map((row) => {
          const val = s[row.key];
          const low = val < row.warn;
          return <Bar key={row.key} label={<><Icon name={row.icon} size={11} className="text-inkdim" />{row.label}</>} value={val} max={row.max} suffix="" color={low ? "#c0392b" : "#6b7a3a"} />;
        })}
      </div>
      <div className="text-[10px] text-inkdim mt-2 font-mono">CERP funds: <span className="text-amber">${world.state.cerp.toLocaleString()}</span></div>
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 fade-in" onClick={() => setJacket(null)}>
      <div className="panel w-[460px] max-w-[92vw] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="stencil text-[10px] text-amber">Service Record</div>
            <h2 className="text-ink text-xl font-bold leading-tight">{m.rank} {m.name}</h2>
            {m.nickname && <div className="text-tan text-sm italic">&ldquo;{m.nickname}&rdquo;</div>}
          </div>
          <button className="tac-btn text-[10px] px-2 py-0.5" onClick={() => setJacket(null)}>✕</button>
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
      </div>
    </div>
  );
}

function EventModal() {
  const world = useGame((s) => s.world)!;
  const resolveEvent = useGame((s) => s.resolveEvent);
  useGame((s) => s.tick);
  const ev = world.pendingEvent;
  if (!ev) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 fade-in">
      <div className="panel w-[520px] max-w-[92vw] p-5">
        <div className="stencil text-amber text-xs mb-1">Situation · {ev.kind} · {world.clockLabel()}</div>
        <h2 className="text-ink text-xl font-bold mb-2">{ev.title}</h2>
        <p className="text-inkdim text-sm leading-relaxed mb-4">{ev.body}</p>
        <div className="flex flex-col gap-2">
          {ev.choices.map((c) => (
            <button key={c.id} className="tac-btn text-left normal-case w-full py-2" onClick={() => resolveEvent(c.id)}>
              <span className="text-ink">{c.label}</span>
              {c.hint && <span className="block text-[10px] text-inkdim normal-case mt-0.5">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
