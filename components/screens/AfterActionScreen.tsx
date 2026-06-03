"use client";
import { useGame } from "@/state/store";

function fmtTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}

const OUTCOME_LABEL: Record<string, { t: string; c: string }> = {
  us_victory: { t: "Contact Broken — Enemy Repelled", c: "#6fae54" },
  us_withdraw: { t: "Tactical Withdrawal", c: "#e0a72b" },
  us_destroyed: { t: "Element Combat-Ineffective", c: "#c0392b" },
  stalemate: { t: "Disengaged", c: "#c2a878" },
  ongoing: { t: "Disengaged", c: "#c2a878" },
};

export default function AfterActionScreen() {
  const aa = useGame((s) => s.afterAction);
  const gotoCommand = useGame((s) => s.gotoCommand);
  if (!aa) return null;
  const o = OUTCOME_LABEL[aa.outcome] ?? OUTCOME_LABEL.stalemate;

  return (
    <div className="w-full h-full flex items-center justify-center scanlines vignette">
      <div className="panel w-[660px] max-w-[94vw] p-6 fade-in">
        <div className="stencil text-xs text-amber mb-1">After-Action Review</div>
        <h1 className="text-2xl font-black mb-1" style={{ color: o.c }}>{o.t}</h1>
        <p className="text-inkdim text-sm italic mb-4">{aa.context}</p>

        <div className="grid grid-cols-3 gap-2 mb-4 font-mono">
          <Stat label="KIA (US)" value={aa.usKIA} color={aa.usKIA > 0 ? "#c0392b" : "#6fae54"} big />
          <Stat label="WIA (US)" value={aa.usWIA} color={aa.usWIA > 0 ? "#e0a72b" : "#6fae54"} big />
          <Stat label="Enemy KIA" value={aa.enemyKIA} color="#d8d6c4" big />
          <Stat label="Civ. Casualties" value={aa.civCasualties} color={aa.civCasualties > 0 ? "#c0392b" : "#6fae54"} />
          <Stat label="Duration" value={fmtTime(aa.durationS)} />
          <Stat label="Rounds Fired" value={aa.ammoExpended} />
        </div>

        {aa.civCasualties > 0 && (
          <div className="border border-rust bg-[#2a1310] p-2 text-[11px] text-tan mb-4 leading-relaxed">
            ⚠ Civilian casualties were sustained. Word will travel through the valley faster than any report you file.
            Attitudes have hardened and battalion will ask hard questions.
          </div>
        )}

        <div className="stencil text-[10px] text-amber mb-1">Net Traffic — Final Minutes</div>
        <div className="bg-bg border border-line p-2 max-h-[200px] overflow-y-auto font-mono text-[10px] mb-4">
          {aa.log.map((l, i) => (
            <div key={i} className={`${l.kind === "kia" ? "text-rust" : l.kind === "contact" ? "text-amber" : l.kind === "support" ? "text-us" : "text-inkdim"}`}>
              <span className="opacity-50">{Math.floor(l.timeS / 60)}:{String(Math.floor(l.timeS % 60)).padStart(2, "0")}</span> {l.msg}
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <button className="tac-btn active px-6 py-2" onClick={gotoCommand}>▸ Return to the COP</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color = "#d8d6c4", big = false }: { label: string; value: number | string; color?: string; big?: boolean }) {
  return (
    <div className="bg-bg border border-line p-2">
      <div className="text-inkdim text-[9px] stencil">{label}</div>
      <div className={`${big ? "text-2xl" : "text-lg"} font-bold leading-tight`} style={{ color }}>{value}</div>
    </div>
  );
}
