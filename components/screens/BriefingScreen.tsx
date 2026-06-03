"use client";
import { useGame } from "@/state/store";
import { getWeapon } from "@/lib/sim/weapons";

export default function BriefingScreen() {
  const sim = useGame((s) => s.sim);
  const spec = useGame((s) => s.activeSpec);
  const beginTactical = useGame((s) => s.beginTactical);
  if (!sim || !spec) return null;

  const us = sim.units.filter((u) => u.faction === "us" || u.faction === "ana");
  const mortars = sim.mortars;

  return (
    <div className="w-full h-full flex items-center justify-center scanlines vignette">
      <div className="panel w-[640px] max-w-[94vw] p-6 fade-in">
        <div className="stencil text-rust text-xs mb-1 blink">▲ TROOPS IN CONTACT</div>
        <h1 className="text-ink text-2xl font-black mb-1">{spec.enemyInitiated ? "CONTACT" : "ENEMY SIGHTED"}</h1>
        <p className="text-tan italic text-sm mb-4 leading-relaxed">{spec.narrative}</p>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <div className="stencil text-[10px] text-amber mb-1">Friendly Element ({us.length})</div>
            <div className="bg-bg border border-line p-2 max-h-[180px] overflow-y-auto font-mono text-[11px]">
              {us.map((u) => (
                <div key={u.id} className="flex justify-between text-inkdim">
                  <span><span className="text-ink">{u.rank}</span> {u.name.split(" ").pop()}</span>
                  <span>{getWeapon(u.weaponId === "unarmed" ? "m9" : u.weaponId).short}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="stencil text-[10px] text-amber mb-1">Situation</div>
            <div className="bg-bg border border-line p-2 font-mono text-[11px] text-inkdim space-y-1">
              <div>LIGHT: <span className="text-ink">{sim.light < 0.2 ? "NIGHT (NODs)" : sim.light < 0.6 ? "LOW LIGHT" : "DAYLIGHT"}</span></div>
              <div>WEATHER: <span className="text-ink">{sim.weather.label}, vis {(sim.weather.visibilityM / 1000).toFixed(1)}km</span></div>
              <div>ENEMY EST: <span className="text-rust">{spec.enemyCount > 0 ? `~${spec.enemyCount} fighters` : "unknown"}</span></div>
              <div className="pt-1 border-t border-line mt-1">FIRE SUPPORT:</div>
              <div>{mortars.length ? mortars.map((m) => getWeapon(m.weaponId).short + ` (${m.rounds})`).join(", ") : <span className="text-rust">none in range</span>}</div>
              <div>CAS/CCA: <span className={sim.casAvailable ? "text-good" : "text-rust"}>{sim.casAvailable ? "available" : "no air (weather)"}</span></div>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-inkdim mb-4 leading-relaxed border-l-2 border-line pl-3">
          {spec.enemyInitiated
            ? "Your element is in the open and taking fire. Get them into cover, return fire, identify the enemy positions, and break contact or destroy them. Watch your ammo and your wounded."
            : "You have the drop on them. Hold your fire until the kill zone is set, then initiate on your terms. Don't let them slip up the draws."}
        </div>

        <div className="flex gap-2 justify-end">
          <button className="tac-btn active px-6 py-2" onClick={beginTactical}>
            ▸ Deploy to Contact
          </button>
        </div>
        <div className="text-[10px] text-inkdim/70 font-mono mt-3 text-center">
          LEFT-CLICK / DRAG select · RIGHT-CLICK move or engage · SPACE pause · order bar at bottom
        </div>
      </div>
    </div>
  );
}
