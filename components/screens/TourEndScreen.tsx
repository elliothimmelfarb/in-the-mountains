"use client";
import { useGame } from "@/state/store";

function grade(score: number): { letter: string; verdict: string; color: string } {
  if (score >= 85) return { letter: "A", verdict: "A model counterinsurgency. The valley is quieter than you found it, and your soldiers came home.", color: "#6fae54" };
  if (score >= 70) return { letter: "B", verdict: "A hard tour handled well. Imperfect, but the line held and the valley leans your way.", color: "#9bbf55" };
  if (score >= 55) return { letter: "C", verdict: "A wash, like most of them. You held ground and lost some. The valley is no one's.", color: "#e0a72b" };
  if (score >= 40) return { letter: "D", verdict: "A grind that cost more than it bought. The valley remembers the wrong things.", color: "#d08030" };
  return { letter: "F", verdict: "The valley won. It usually does. Battalion will write it up in the language of lessons learned.", color: "#c0392b" };
}

export default function TourEndScreen() {
  const world = useGame((s) => s.world);
  const gotoMenu = useGame((s) => s.gotoMenu);
  if (!world) return null;
  const score = world.state.tourScore || world.computeTourScore();
  const g = grade(score);
  const kia = world.platoon.members.filter((m) => !m.alive);
  const m = world.state.metrics;

  return (
    <div className="w-full h-full flex items-center justify-center overflow-y-auto scanlines vignette py-8">
      <div className="panel w-[680px] max-w-[94vw] p-7 fade-in">
        <div className="stencil text-xs text-amber mb-1">End of Tour · {world.state.fob.name}</div>
        <div className="flex items-end gap-4 mb-3">
          <div className="text-7xl font-black leading-none" style={{ color: g.color }}>{g.letter}</div>
          <div>
            <div className="text-ink text-2xl font-bold">{score}/100</div>
            <div className="text-inkdim text-sm">Deployment Assessment</div>
          </div>
        </div>
        {world.state.endReason && <p className="text-tan text-sm mb-2">{world.state.endReason}</p>}
        <p className="text-tan italic text-sm mb-5 leading-relaxed border-l-2 border-line pl-3">{g.verdict}</p>

        <div className="grid grid-cols-4 gap-2 mb-5 font-mono text-center">
          <Metric label="Stability" v={m.stability} />
          <Metric label="Attitudes" v={m.attitude} />
          <Metric label="Enemy" v={m.enemyStrength} invert />
          <Metric label="Higher Conf." v={m.higherConfidence} />
        </div>

        <div className="stencil text-[10px] text-amber mb-2">The Cost · {kia.length} Killed in Action</div>
        {kia.length === 0 ? (
          <div className="text-good text-sm mb-5">Every soldier who deployed with you is going home alive. That is the rarest grade of all.</div>
        ) : (
          <div className="bg-bg border border-line p-3 mb-5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
            {kia.map((k) => (
              <div key={k.id} className="text-inkdim">
                <span className="text-ink">{k.rank} {k.name}</span> · {k.homeState}
              </div>
            ))}
          </div>
        )}

        <div className="flex justify-between items-center">
          <div className="text-[11px] text-inkdim font-mono">
            Tour: {world.day - 1} days · {world.platoon.members.reduce((a, x) => a + x.kills, 0)} enemy accounted for
          </div>
          <button className="tac-btn active px-6 py-2" onClick={gotoMenu}>▸ New Deployment</button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, v, invert }: { label: string; v: number; invert?: boolean }) {
  const good = invert ? v < 40 : v > 60;
  const bad = invert ? v > 60 : v < 40;
  const color = good ? "#6fae54" : bad ? "#c0392b" : "#e0a72b";
  return (
    <div className="bg-bg border border-line p-2">
      <div className="text-2xl font-bold" style={{ color }}>{Math.round(v)}</div>
      <div className="text-inkdim text-[9px] stencil">{label}</div>
    </div>
  );
}
