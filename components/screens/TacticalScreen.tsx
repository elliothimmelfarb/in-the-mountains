"use client";
import { useEffect } from "react";
import { useGame, OrderTool } from "@/state/store";
import TacticalView from "@/components/tactical/TacticalView";
import { getWeapon } from "@/lib/sim/weapons";
import { Unit } from "@/lib/sim/entities";

const ORDER_TOOLS: { id: OrderTool; label: string; key: string; danger?: boolean }[] = [
  { id: "select", label: "Select", key: "Q" },
  { id: "move", label: "Move", key: "W" },
  { id: "movefast", label: "Rush", key: "E" },
  { id: "assault", label: "Assault", key: "R" },
  { id: "hold", label: "Hold", key: "A" },
  { id: "suppress", label: "Suppress", key: "S" },
  { id: "smoke", label: "Smoke", key: "D" },
  { id: "frag", label: "Frag", key: "F" },
  { id: "withdraw", label: "Withdraw", key: "X", danger: true },
];

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export default function TacticalScreen() {
  const sim = useGame((s) => s.sim);
  const selection = useGame((s) => s.selection);
  const orderTool = useGame((s) => s.orderTool);
  const setOrderTool = useGame((s) => s.setOrderTool);
  const paused = useGame((s) => s.paused);
  const speed = useGame((s) => s.speed);
  const setSpeed = useGame((s) => s.setSpeed);
  const togglePause = useGame((s) => s.togglePause);
  const fireSupport = useGame((s) => s.fireSupport);
  const setFireSupport = useGame((s) => s.setFireSupport);
  const medevacSelected = useGame((s) => s.medevacSelected);
  useGame((s) => s.tick);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        togglePause();
        return;
      }
      const k = e.key.toUpperCase();
      const tool = ORDER_TOOLS.find((t) => t.key === k);
      if (tool) setOrderTool(tool.id);
      if (k === "1") setSpeed(1);
      if (k === "2") setSpeed(2);
      if (k === "3") setSpeed(4);
      if (e.key === "Escape") setFireSupport(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, setOrderTool, setSpeed, setFireSupport]);

  if (!sim) return null;

  const us = sim.units.filter((u) => (u.faction === "us" || u.faction === "ana") && u.alive);
  const usDown = sim.units.filter((u) => (u.faction === "us" || u.faction === "ana") && (!u.alive || !u.conscious)).length;
  const enemyVisible = sim.revealed.size;
  const selUnits = selection.map((id) => sim.unit(id)).filter((u): u is Unit => !!u);

  return (
    <div className="w-full h-full relative flex flex-col">
      {/* top bar */}
      <div className="panel border-x-0 border-t-0 h-11 flex items-center px-3 gap-3 shrink-0 z-20">
        <span className="stencil text-rust text-xs blink">● TIC</span>
        <span className="font-mono text-ink text-lg tabular-nums">{fmtTime(sim.timeS)}</span>
        <div className="flex gap-1">
          <button className={`tac-btn px-2 py-1 ${paused ? "active" : ""}`} onClick={togglePause}>{paused ? "▶" : "⏸"}</button>
          <button className={`tac-btn px-2 py-1 ${!paused && speed === 1 ? "active" : ""}`} onClick={() => setSpeed(1)}>1×</button>
          <button className={`tac-btn px-2 py-1 ${!paused && speed === 2 ? "active" : ""}`} onClick={() => setSpeed(2)}>2×</button>
          <button className={`tac-btn px-2 py-1 ${!paused && speed === 4 ? "active" : ""}`} onClick={() => setSpeed(4)}>4×</button>
        </div>
        <div className="flex-1 text-center font-mono text-[11px] text-inkdim truncate px-2">{sim.context}</div>
        <div className="font-mono text-[11px] flex gap-3">
          <span className="text-us">FRIENDLY {us.length}{usDown > 0 && <span className="text-rust"> ·{usDown} down</span>}</span>
          <span className="text-enemy">CONTACT {enemyVisible}</span>
        </div>
        <button className="tac-btn tac-btn-danger px-3 py-1" onClick={() => sim.withdraw()}>End Contact</button>
      </div>

      {/* map */}
      <div className="flex-1 relative min-h-0">
        <TacticalView />

        {fireSupport && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 panel px-4 py-1.5 z-20 fade-in border-amber">
            <span className="stencil text-amber text-xs blink">◎ SELECT IMPACT POINT — {fireSupport.label}</span>
            <button className="tac-btn ml-3 text-[10px] px-2 py-0.5" onClick={() => setFireSupport(null)}>cancel (Esc)</button>
          </div>
        )}

        {/* radio log */}
        <div className="absolute top-2 right-2 w-[280px] max-h-[40%] panel p-2 z-10 overflow-hidden flex flex-col">
          <div className="stencil text-[9px] text-amber mb-1">Net Traffic</div>
          <div className="overflow-y-auto flex flex-col gap-0.5">
            {sim.log.slice(-22).reverse().map((l) => (
              <div key={l.id} className={`text-[10px] leading-snug font-mono ${l.kind === "kia" ? "text-rust" : l.kind === "contact" ? "text-amber" : l.kind === "support" ? "text-us" : l.kind === "casualty" ? "text-tan" : "text-inkdim"}`}>
                <span className="opacity-50">{fmtTime(l.timeS)}</span> {l.msg}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* bottom HUD */}
      <div className="shrink-0 flex items-stretch gap-0 border-t border-line bg-panel z-20" style={{ minHeight: 116 }}>
        {/* selected units */}
        <div className="w-[300px] border-r border-line p-2 overflow-y-auto">
          <div className="stencil text-[9px] text-amber mb-1">Selected ({selUnits.length})</div>
          {selUnits.length === 0 && <div className="text-inkdim text-[11px] italic">Click or drag-box to select your soldiers.</div>}
          {selUnits.length === 1 && <UnitCard u={selUnits[0]} />}
          {selUnits.length > 1 && <SquadSummary units={selUnits} />}
        </div>

        {/* order tools */}
        <div className="flex-1 p-2">
          <div className="stencil text-[9px] text-amber mb-1">Orders {selection.length === 0 && <span className="text-inkdim normal-case">— select units first</span>}</div>
          <div className="flex flex-wrap gap-1">
            {ORDER_TOOLS.map((t) => (
              <button
                key={t.id}
                className={`tac-btn ${orderTool === t.id ? "active" : ""} ${t.danger ? "tac-btn-danger" : ""}`}
                onClick={() => setOrderTool(t.id)}
              >
                {t.label} <span className="text-inkdim text-[9px]">[{t.key}]</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1 mt-1.5">
            <button className="tac-btn" onClick={() => { sim.issueOrder(selection, { type: "holdfire" }); }}>✋ Hold Fire</button>
            <button className="tac-btn" onClick={() => { sim.issueOrder(selection, { type: "weaponsfree" }); }}>Weapons Free</button>
            <button className="tac-btn" onClick={() => { sim.issueOrder(selection, { type: "halt" }); }}>Halt</button>
            <button className="tac-btn tac-btn-danger" onClick={medevacSelected}>✚ MEDEVAC</button>
          </div>
          <div className="text-[10px] text-inkdim mt-1.5 font-mono leading-snug">
            {orderTool === "select" ? "SELECT: click a soldier or drag a box. RIGHT-CLICK = move / engage."
              : `ORDER [${orderTool.toUpperCase()}]: click the map to issue. RIGHT-CLICK for quick move/engage.`}
          </div>
        </div>

        {/* fire support */}
        <div className="w-[260px] border-l border-line p-2">
          <div className="stencil text-[9px] text-amber mb-1">Fire Support</div>
          <div className="flex flex-col gap-1">
            {sim.mortars.map((m) => {
              const w = getWeapon(m.weaponId);
              return (
                <button key={m.weaponId} disabled={m.rounds <= 0} className={`tac-btn text-left ${fireSupport?.weaponId === m.weaponId ? "active" : ""}`} onClick={() => setFireSupport(m.weaponId, `${w.short} ×4`, 4)}>
                  ◎ {w.name} <span className="text-inkdim">({m.rounds} rds)</span>
                </button>
              );
            })}
            <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn text-left ${fireSupport?.weaponId === "cas_gun" ? "active" : ""}`} onClick={() => setFireSupport("cas_gun", "CAS GUN RUN")}>
              ✈ CAS — Gun Run
            </button>
            <button disabled={!sim.casAvailable || sim.casUsed} className={`tac-btn text-left ${fireSupport?.weaponId === "cas_rocket" ? "active" : ""}`} onClick={() => setFireSupport("cas_rocket", "CAS HELLFIRE")}>
              ✈ CAS — Hellfire
            </button>
          </div>
          <div className="text-[9px] text-inkdim mt-1.5 font-mono leading-snug">
            Select an asset, then click the impact point. Mind DANGER CLOSE — frag does not pick sides.
          </div>
        </div>
      </div>
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
      <div className="flex justify-between">
        <span className="text-ink font-semibold">{u.rank} {u.name}</span>
        <span className={`${!u.alive ? "text-rust" : u.suppression > 0.5 ? "text-amber" : "text-good"}`}>{state}</span>
      </div>
      <div className="text-inkdim mb-1">{u.nickname ? `"${u.nickname}" · ` : ""}{w.name}</div>
      <div className="flex items-center gap-1.5 mb-0.5"><span className="w-10 text-inkdim">HP</span>{statBar(u.hp / 100, u.hp > 50 ? "#6fae54" : u.hp > 25 ? "#e0a72b" : "#c0392b")}<span className="w-7 text-right">{Math.round(u.hp)}</span></div>
      <div className="flex items-center gap-1.5 mb-0.5"><span className="w-10 text-inkdim">Morale</span>{statBar(u.composure, "#5b9bd8")}<span className="w-7 text-right">{Math.round(u.composure * 100)}</span></div>
      <div className="flex items-center gap-1.5 mb-0.5"><span className="w-10 text-inkdim">Suppr.</span>{statBar(u.suppression, "#e0a72b")}<span className="w-7 text-right">{Math.round(u.suppression * 100)}</span></div>
      <div className="flex items-center gap-1.5 mb-1"><span className="w-10 text-inkdim">Fatigue</span>{statBar(u.fatigue, "#c2a878")}<span className="w-7 text-right">{Math.round(u.fatigue * 100)}</span></div>
      <div className="flex justify-between text-inkdim">
        <span>AMMO <span className="text-ink">{u.ammo}</span>/{u.reserveAmmo}</span>
        <span>{u.stance.toUpperCase()}</span>
        {u.grenades > 0 && <span>FRAG {u.grenades}</span>}
        {u.smokes > 0 && <span>SMK {u.smokes}</span>}
      </div>
      {u.wounds.length > 0 && (
        <div className="text-rust mt-0.5">WOUNDS: {u.wounds.map((wd) => wd.region).join(", ")}{u.bleedRate > 0 ? " · BLEEDING" : ""}</div>
      )}
    </div>
  );
}

function SquadSummary({ units }: { units: Unit[] }) {
  const alive = units.filter((u) => u.alive);
  const avgHp = alive.reduce((a, u) => a + u.hp, 0) / Math.max(1, alive.length);
  const avgMorale = alive.reduce((a, u) => a + u.composure, 0) / Math.max(1, alive.length);
  const ammo = units.reduce((a, u) => a + u.ammo + u.reserveAmmo, 0);
  return (
    <div className="font-mono text-[11px] space-y-0.5">
      <div className="text-inkdim">{alive.length} effective · {units.length - alive.length} down</div>
      <div className="flex items-center gap-1.5"><span className="w-12 text-inkdim">Avg HP</span>{statBar(avgHp / 100, "#6fae54")}</div>
      <div className="flex items-center gap-1.5"><span className="w-12 text-inkdim">Morale</span>{statBar(avgMorale, "#5b9bd8")}</div>
      <div className="text-inkdim">Total ammo on hand: <span className="text-ink">{ammo}</span></div>
      <div className="text-inkdim/70 text-[10px] mt-1">Orders apply to the whole selection.</div>
    </div>
  );
}
