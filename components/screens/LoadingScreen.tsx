"use client";
import { useGame } from "@/state/store";

// Status glyph for one generation phase: a live spinner while it runs, a check when it
// lands, a dim ring while it waits. The spinner is a CSS rotate (compositor-driven), so it
// keeps turning even while a phase blocks the main thread carving the heightmap.
function StepGlyph({ status }: { status: "pending" | "active" | "done" }) {
  if (status === "done")
    return <span className="text-good text-[13px] leading-none w-4 text-center shrink-0">✓</span>;
  if (status === "active")
    return (
      <span className="w-4 flex justify-center shrink-0">
        <span className="w-3.5 h-3.5 rounded-full border-2 border-amber/25 border-t-amber animate-spin inline-block" />
      </span>
    );
  return <span className="text-inkdim/40 text-[13px] leading-none w-4 text-center shrink-0">○</span>;
}

export default function LoadingScreen() {
  const lp = useGame((s) => s.loadProgress);
  if (!lp) return null;
  const pct = Math.round(lp.pct * 100);
  const activeIdx = lp.steps.findIndex((s) => s.status === "active");
  const phaseOf = activeIdx >= 0 ? activeIdx + 1 : lp.steps.filter((s) => s.status === "done").length;

  return (
    <div className="relative w-full h-full flex items-center justify-center scanlines vignette overflow-hidden">
      {/* same valley-at-dusk wash as the menu, so the deploy feels continuous */}
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 30% 20%, #2a3018 0%, transparent 55%), radial-gradient(circle at 80% 80%, #1a1d12 0%, transparent 60%), linear-gradient(160deg,#0c0d0a,#141609)",
        }}
      />
      {/* faint military map grid — the valley being plotted onto a map sheet */}
      <div
        className="absolute inset-0 opacity-[0.07]"
        style={{
          backgroundImage:
            "linear-gradient(#e0a72b 1px, transparent 1px), linear-gradient(90deg, #e0a72b 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage: "radial-gradient(circle at 50% 45%, black 0%, transparent 72%)",
          WebkitMaskImage: "radial-gradient(circle at 50% 45%, black 0%, transparent 72%)",
        }}
      />

      <div className="relative z-10 w-[580px] max-w-[92vw] fade-in">
        <div className="text-center mb-1">
          <div className="stencil text-inkdim text-[11px] tracking-[0.4em]">ESTABLISHING COMBAT OUTPOST</div>
        </div>
        <h1 className="text-center text-5xl font-black tracking-tight text-ink leading-none">
          {lp.title.split(" ").map((w, i) =>
            i === 0 ? <span key={i} className="text-amber">{w} </span> : <span key={i}>{w} </span>,
          )}
        </h1>
        <div className="text-center text-inkdim mt-2 text-[12px] font-mono">{lp.sub}</div>

        <div className="panel mt-7 p-5">
          {/* phase header: which step of how many, and the live percentage */}
          <div className="flex items-baseline justify-between mb-3">
            <span className="stencil text-[10px] text-amber">
              Phase {Math.min(phaseOf, lp.steps.length)} / {lp.steps.length}
            </span>
            <span className="font-mono text-amber text-2xl tabular-nums leading-none">{pct}%</span>
          </div>

          {/* the checklist of what's actually happening */}
          <div className="flex flex-col gap-2 mb-4">
            {lp.steps.map((s) => (
              <div
                key={s.id}
                className={`flex items-center gap-2.5 text-[12px] font-mono transition-colors duration-300 ${
                  s.status === "active"
                    ? "text-amber"
                    : s.status === "done"
                      ? "text-ink"
                      : "text-inkdim/45"
                }`}
              >
                <StepGlyph status={s.status} />
                <span className="leading-snug">{s.label}</span>
              </div>
            ))}
          </div>

          {/* overall progress bar — width glides between chunky phase steps so the bar feels
              alive even though the work lands in big synchronous blocks */}
          <div className="h-2 bg-bg border border-line relative overflow-hidden">
            <div
              className="h-full bg-amber transition-[width] duration-500 ease-out"
              style={{ width: pct + "%", boxShadow: "0 0 8px rgba(224,167,43,0.6)" }}
            />
            {/* a faint scanning shimmer riding the filled portion */}
            <div className="absolute inset-0 pointer-events-none scanlines opacity-40" />
          </div>
        </div>

        <div className="text-center text-inkdim/80 mt-5 text-[12px] italic px-6 leading-relaxed">{lp.flavor}</div>
        <div className="text-center text-[10px] text-inkdim/50 mt-4 font-mono tracking-wider">
          STAND BY · THE VALLEY IS COMING UP ON THE NET
        </div>
      </div>
    </div>
  );
}
