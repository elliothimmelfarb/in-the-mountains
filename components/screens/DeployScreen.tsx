"use client";
import { useEffect } from "react";
import { useGame, OrderTool, SPEEDS } from "@/state/store";
import WorldView from "@/components/world/WorldView";
import { getWeapon } from "@/lib/sim/weapons";
import { Unit, MoveTechnique, MOVE_TECHNIQUES, TECHNIQUE_LABEL } from "@/lib/sim/entities";
import { MISSION_LABEL, MissionType } from "@/lib/sim/world";
import { Supplies, CERP_PROJECTS } from "@/lib/sim/campaign";

const ORDER_TOOLS: { id: OrderTool; label: string; key: string; danger?: boolean }[] = [
  { id: "select", label: "Select", key: "Q" },
  { id: "move", label: "Move", key: "W" },
  { id: "assault", label: "Assault", key: "E" },
  { id: "hold", label: "Hold", key: "A" },
  { id: "suppress", label: "Suppress", key: "S" },
  { id: "smoke", label: "Smoke", key: "D" },
  { id: "frag", label: "Frag", key: "F" },
  { id: "withdraw", label: "Withdraw", key: "X", danger: true },
];
const MISSIONS: MissionType[] = ["presence", "recon", "ambush", "census", "cordon", "overwatch"];

function Bar({ label, value, color = "#6b7a3a", max = 100, suffix = "%" }: { label: string; value: number; color?: string; max?: number; suffix?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <div className="w-[80px] text-inkdim shrink-0">{label}</div>
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
  const setOrderTool = useGame((s) => s.setOrderTool);
  const setFireSupport = useGame((s) => s.setFireSupport);
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
      const tool = ORDER_TOOLS.find((t) => t.key === k);
      if (tool) setOrderTool(tool.id);
      if (e.key === "1") setSpeed(1);
      if (e.key === "2") setSpeed(2);
      if (e.key === "3") setSpeed(4);
      if (e.key === "4") setSpeed(8);
      if (e.key === "5") setSpeed(16);
      if (k === "T") toggleWarp();
      if (e.key === "Escape") setFireSupport(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, setSpeed, toggleWarp, setOrderTool, setFireSupport]);

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
      <div className="flex items-center px-3 gap-3 border-r border-line">
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
          <div className="text-ink leading-none text-sm">{wx.label}</div>
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
  const selection = useGame((s) => s.selection);
  const orderTool = useGame((s) => s.orderTool);
  const setOrderTool = useGame((s) => s.setOrderTool);
  const posture = useGame((s) => s.posture);
  const setPosture = useGame((s) => s.setPosture);
  const fireSupport = useGame((s) => s.fireSupport);
  const setFireSupport = useGame((s) => s.setFireSupport);
  const medevacSelected = useGame((s) => s.medevacSelected);
  useGame((s) => s.tick);
  const sim = world.sim;

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-panel/95 border-t border-line p-2 z-10">
      <div className="flex items-start gap-3 flex-wrap">
        <div>
          <div className="stencil text-[9px] text-amber mb-1">Orders {selection.length === 0 && <span className="text-inkdim normal-case">— select soldiers</span>}{selection.length > 0 && <span className="text-inkdim normal-case"> ({selection.length})</span>}</div>
          <div className="flex flex-wrap gap-1 max-w-[460px]">
            {ORDER_TOOLS.map((t) => (
              <button key={t.id} className={`tac-btn ${orderTool === t.id ? "active" : ""} ${t.danger ? "tac-btn-danger" : ""}`} onClick={() => setOrderTool(t.id)}>
                {t.label} <span className="text-inkdim text-[9px]">[{t.key}]</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1 mt-1.5 items-center">
            <span className="text-inkdim text-[9px] font-mono">POSTURE</span>
            <select value={posture} onChange={(e) => setPosture(e.target.value as MoveTechnique)} className="bg-bg border border-line text-ink text-[10px] font-mono px-1 py-0.5 outline-none focus:border-amber">
              {MOVE_TECHNIQUES.map((t) => (<option key={t} value={t}>{TECHNIQUE_LABEL[t]}</option>))}
            </select>
            <button className="tac-btn text-[10px]" onClick={() => sim.issueOrder(selection, { type: "holdfire" })}>Hold Fire</button>
            <button className="tac-btn text-[10px]" onClick={() => sim.issueOrder(selection, { type: "weaponsfree" })}>Wpns Free</button>
            <button className="tac-btn text-[10px]" onClick={() => sim.issueOrder(selection, { type: "halt" })}>Halt</button>
            <button className="tac-btn tac-btn-danger text-[10px]" onClick={medevacSelected}>✚ MEDEVAC</button>
          </div>
        </div>
        <div className="border-l border-line pl-3">
          <div className="stencil text-[9px] text-amber mb-1">Fire Support</div>
          <div className="flex flex-col gap-1 max-w-[220px]">
            {sim.mortars.map((mt) => {
              const wp = getWeapon(mt.weaponId);
              return (
                <button key={mt.weaponId} disabled={mt.rounds <= 0} className={`tac-btn text-left text-[10px] ${fireSupport?.weaponId === mt.weaponId ? "active" : ""}`} onClick={() => setFireSupport(mt.weaponId, `${wp.short} ×4`, 4)}>
                  ◎ {wp.name} <span className="text-inkdim">({mt.rounds})</span>
                </button>
              );
            })}
            <div className="flex gap-1">
              <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn text-[10px] flex-1 ${fireSupport?.weaponId === "cas_gun" ? "active" : ""}`} onClick={() => setFireSupport("cas_gun", "CAS GUN RUN")}>✈ Gun</button>
              <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn text-[10px] flex-1 ${fireSupport?.weaponId === "cas_rocket" ? "active" : ""}`} onClick={() => setFireSupport("cas_rocket", "CAS HELLFIRE")}>✈ Hellfire</button>
            </div>
          </div>
        </div>
        <SelectionReadout />
      </div>
    </div>
  );
}

function SelectionReadout() {
  const world = useGame((s) => s.world)!;
  const selection = useGame((s) => s.selection);
  useGame((s) => s.tick);
  const units = selection.map((id) => world.sim.unit(id)).filter((u): u is Unit => !!u);
  if (units.length === 0) return null;
  if (units.length === 1) return <div className="border-l border-line pl-3 min-w-[230px]"><UnitCard u={units[0]} /></div>;
  const alive = units.filter((u) => u.alive);
  const avgHp = alive.reduce((a, u) => a + u.hp, 0) / Math.max(1, alive.length);
  const avgMorale = alive.reduce((a, u) => a + u.composure, 0) / Math.max(1, alive.length);
  return (
    <div className="border-l border-line pl-3 font-mono text-[10px] min-w-[200px]">
      <div className="stencil text-[9px] text-amber mb-1">Selected ({units.length})</div>
      <div className="text-inkdim">{alive.length} effective · {units.length - alive.length} down</div>
      <div className="text-inkdim">Avg HP {Math.round(avgHp)} · Morale {Math.round(avgMorale * 100)}</div>
      <div className="text-inkdim/70 text-[9px] mt-1">Orders apply to the whole selection.</div>
    </div>
  );
}

function statBar(v: number, color: string) {
  return (
    <div className="flex-1 h-1.5 bg-bg border border-line overflow-hidden">
      <div className="h-full" style={{ width: Math.max(0, Math.min(100, v * 100)) + "%", background: color }} />
    </div>
  );
}

function UnitCard({ u }: { u: Unit }) {
  const w = getWeapon(u.weaponId === "unarmed" ? "m9" : u.weaponId);
  const state = !u.alive ? "KIA" : !u.conscious ? "DOWN" : u.brainState;
  return (
    <div className="font-mono text-[11px]">
      <div className="flex justify-between gap-2">
        <span className="text-ink font-semibold truncate">{u.rank} {u.name}</span>
        <span className={`${!u.alive ? "text-rust" : u.suppression > 0.5 ? "text-amber" : "text-good"}`}>{state}</span>
      </div>
      <div className="text-inkdim mb-1 truncate">{w.name} · {u.stance}</div>
      <div className="flex items-center gap-1.5 mb-0.5"><span className="w-9 text-inkdim">HP</span>{statBar(u.hp / 100, u.hp > 50 ? "#6fae54" : u.hp > 25 ? "#e0a72b" : "#c0392b")}</div>
      <div className="flex items-center gap-1.5 mb-0.5"><span className="w-9 text-inkdim">Suppr</span>{statBar(u.suppression, "#e0a72b")}</div>
      <div className="flex justify-between text-inkdim mt-0.5">
        <span>AMMO <span className="text-ink">{u.ammo}</span>/{u.reserveAmmo}</span>
        {u.grenades > 0 && <span>FRAG {u.grenades}</span>}
        {u.smokes > 0 && <span>SMK {u.smokes}</span>}
      </div>
      {u.wounds.length > 0 && <div className="text-rust mt-0.5">WOUNDS: {u.wounds.map((wd) => wd.region).join(", ")}{u.bleedRate > 0 ? " · BLEEDING" : ""}</div>}
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

function ElementPanel() {
  const world = useGame((s) => s.world)!;
  const selection = useGame((s) => s.selection);
  const selectUnits = useGame((s) => s.selectUnits);
  const squadIds = useGame((s) => s.squadIds);
  const planning = useGame((s) => s.planning);
  const planRoute = useGame((s) => s.planRoute);
  const planMission = useGame((s) => s.planMission);
  const setMission = useGame((s) => s.setMission);
  const setPlanning = useGame((s) => s.setPlanning);
  const stepOff = useGame((s) => s.stepOff);
  const setJacket = useGame((s) => s.setJacket);
  useGame((s) => s.tick);

  const hasMedic = selection.some((id) => world.platoon.members.find((x) => x.id === id)?.role === "medic");
  const canStep = selection.length > 0 && planRoute.length > 0;

  const toggleSquad = (sid: string) => {
    const ids = squadIds(sid);
    const allIn = ids.every((id) => selection.includes(id));
    if (allIn) selectUnits(selection.filter((id) => !ids.includes(id)));
    else selectUnits([...new Set([...selection, ...ids])]);
  };

  return (
    <div className="border-b border-line flex flex-col min-h-0 flex-1">
      <div className="p-2 border-b border-line">
        <div className="stencil text-[10px] text-amber mb-1.5">Patrol Planner</div>
        <div className="flex flex-wrap gap-1 mb-1.5">
          {MISSIONS.map((mt) => (
            <button key={mt} className={`tac-btn text-[10px] px-2 py-1 ${planMission === mt ? "active" : ""}`} onClick={() => setMission(mt)}>{MISSION_LABEL[mt]}</button>
          ))}
        </div>
        {!hasMedic && selection.length > 0 && <div className="text-rust text-[10px] mb-1 font-mono">⚠ NO MEDIC — wounded will bleed.</div>}
        <div className="text-inkdim text-[10px] mb-1 font-mono">{selection.length} selected · {planRoute.length} waypoints{planning ? " · click the map to draw" : ""}</div>
        <div className="flex gap-1">
          <button className={`tac-btn flex-1 ${planning ? "active" : ""}`} onClick={() => setPlanning(!planning)}>{planning ? "Drawing route…" : "✚ Draw Route"}</button>
          <button className={`tac-btn flex-1 ${canStep ? "active" : ""}`} disabled={!canStep} onClick={stepOff}>▸ Step Off</button>
        </div>
      </div>
      <div className="p-2 overflow-y-auto flex-1 min-h-0">
        <div className="flex items-center justify-between mb-1.5">
          <div className="stencil text-[10px] text-amber">Task Organization</div>
          <span className="font-mono text-[10px] text-inkdim">{selection.length} sel</span>
        </div>
        {world.platoon.squads.map((sq) => {
          const members = sq.memberIds.map((id) => world.platoon.members.find((x) => x.id === id)).filter(Boolean) as NonNullable<ReturnType<typeof world.platoon.members.find>>[];
          const readyCount = members.filter((mm) => mm.alive && mm.status === "ready").length;
          return (
            <div key={sq.id} className="mb-2">
              <button className="w-full flex justify-between items-center text-[11px] text-ink hover:text-amber py-0.5" onClick={() => toggleSquad(sq.id)}>
                <span className="font-semibold">{sq.name}</span>
                <span className="font-mono text-[9px] text-inkdim">{readyCount}/{members.length} ready ▾</span>
              </button>
              <div className="grid grid-cols-1 gap-0.5 mt-0.5">
                {members.map((mm) => {
                  const sel = selection.includes(mm.id);
                  const tasked = world.state.tasks.some((t) => t.memberIds.includes(mm.id));
                  return (
                    <div key={mm.id} className={`flex items-center gap-1.5 px-1.5 py-1 border text-left text-[10px] ${sel ? "border-amber bg-[#3a4126]" : "border-line bg-bg"} ${!mm.alive ? "opacity-40" : "hover:border-olive"}`}>
                      <button disabled={!mm.alive} onClick={() => selectUnits(sel ? selection.filter((x) => x !== mm.id) : [...selection, mm.id])} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${mm.status === "ready" ? "bg-good" : mm.status === "wounded" ? "bg-rust" : mm.status === "kia" ? "bg-[#444]" : "bg-amber"}`} />
                        <span className="font-mono text-inkdim w-9 shrink-0">{mm.rank}</span>
                        <span className="text-ink flex-1 truncate">{mm.name.split(" ").pop()}</span>
                        {tasked && <span className="text-amber text-[9px]">●</span>}
                        <span className="text-inkdim font-mono">{roleAbbr(mm.role)}</span>
                      </button>
                      <button title="Service record" onClick={() => setJacket(mm.id)} className="text-inkdim hover:text-amber px-1 shrink-0">ⓘ</button>
                    </div>
                  );
                })}
              </div>
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
  const selection = useGame((s) => s.selection);
  useGame((s) => s.tick);
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
        ☕ Send element for Shura (KLE){selection.length ? ` — ${selection.length} pax` : " — HQ"}
      </button>
      <div className="stencil text-[10px] text-amber mb-1">CERP Projects <span className="text-inkdim normal-case">(${world.state.cerp.toLocaleString()} · $5k ea)</span></div>
      <div className="flex flex-wrap gap-1">
        {CERP_PROJECTS.map((p) => (
          <button key={p} disabled={world.state.cerp < 5000 || v.projects.includes(p) || !!proj} className={`tac-btn text-[10px] px-2 py-1 ${v.wants === p ? "border-amber" : ""}`} onClick={() => fundProject(v.id, p)}>
            {v.projects.includes(p) ? "✓ " : "+ "}{p}
          </button>
        ))}
      </div>
      <div className="text-inkdim text-[9px] mt-1 font-mono">Projects need materials trucked in, a contractor, and security on the site for days.</div>
    </div>
  );
}

const SUPPLY_ROWS: { key: keyof Supplies; label: string; max: number; warn: number }[] = [
  { key: "ammo_556", label: "5.56mm", max: 24000, warn: 6000 },
  { key: "ammo_762", label: "7.62mm", max: 9000, warn: 2000 },
  { key: "mortar_60", label: "60mm", max: 120, warn: 20 },
  { key: "mortar_81", label: "81mm", max: 80, warn: 15 },
  { key: "construction", label: "build mat.", max: 80, warn: 12 },
  { key: "medical", label: "med kits", max: 44, warn: 8 },
  { key: "water", label: "water", max: 600, warn: 100 },
  { key: "food", label: "food", max: 560, warn: 100 },
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
          return <Bar key={row.key} label={row.label} value={val} max={row.max} suffix="" color={low ? "#c0392b" : "#6b7a3a"} />;
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
