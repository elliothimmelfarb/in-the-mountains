"use client";
import { useState, useEffect } from "react";
import { useGame } from "@/state/store";

export default function MenuScreen() {
  const newCampaign = useGame((s) => s.newCampaign);
  const hasCampaign = useGame((s) => !!s.world);
  const resume = useGame((s) => s.resume);
  const startTutorial = useGame((s) => s.startTutorial);
  const savedExists = useGame((s) => s.savedExists);
  const loadCampaign = useGame((s) => s.loadCampaign);
  const refreshSave = useGame((s) => s.refreshSave);
  const [seed, setSeed] = useState("");
  const [days, setDays] = useState(120);
  const [showCredits, setShowCredits] = useState(false);

  useEffect(() => {
    refreshSave();
  }, [refreshSave]);

  return (
    <div className="relative w-full h-full flex items-center justify-center scanlines vignette overflow-hidden">
      <div
        className="absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 30% 20%, #2a3018 0%, transparent 55%), radial-gradient(circle at 80% 80%, #1a1d12 0%, transparent 60%), linear-gradient(160deg,#0c0d0a,#141609)",
        }}
      />
      <div className="relative z-10 w-[640px] max-w-[92vw] fade-in">
        <div className="text-center mb-1">
          <div className="stencil text-inkdim text-xs tracking-[0.4em]">A TACTICAL DEPLOYMENT SIMULATION</div>
        </div>
        <h1 className="text-center text-6xl font-black tracking-tight text-ink leading-none">
          IN THE <span className="text-amber">MOUNTAINS</span>
        </h1>
        <div className="text-center text-inkdim mt-3 text-sm italic max-w-[520px] mx-auto">
          Kunar Province, Afghanistan — 2011. You command a remote combat outpost in a valley the
          maps call contested and the men call worse. The valley does not care who you are.
        </div>

        <div className="panel mt-8 p-5">
          <div className="stencil text-xs text-amber mb-3">New Deployment</div>
          <div className="flex gap-3 items-end flex-wrap">
            <label className="flex flex-col gap-1 text-[11px] text-inkdim font-mono flex-1 min-w-[180px]">
              VALLEY SEED (optional)
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                placeholder="random"
                className="bg-bg border border-line px-2 py-1.5 text-ink font-mono text-sm outline-none focus:border-amber"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-inkdim font-mono">
              TOUR LENGTH
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="bg-bg border border-line px-2 py-1.5 text-ink font-mono text-sm outline-none focus:border-amber"
              >
                <option value={60}>60 days</option>
                <option value={120}>120 days</option>
                <option value={180}>180 days</option>
                <option value={270}>270 days</option>
              </select>
            </label>
            <button className="tac-btn active text-sm px-6 py-2" onClick={() => newCampaign(seed, days)}>
              Deploy ▸
            </button>
          </div>
        </div>

        <div className="flex gap-2 mt-3 justify-center flex-wrap">
          <button className="tac-btn" onClick={startTutorial}>
            ▸ Guided Tutorial
          </button>
          {hasCampaign ? (
            <button className="tac-btn active" onClick={resume}>
              Resume Command
            </button>
          ) : (
            savedExists && (
              <button className="tac-btn active" onClick={loadCampaign}>
                Continue Tour
              </button>
            )
          )}
          <a className="tac-btn no-underline" href="/manual/index.html" target="_blank" rel="noreferrer">
            Field Manual
          </a>
          <a className="tac-btn no-underline" href="/manual/tutorial.html" target="_blank" rel="noreferrer">
            Tutorial
          </a>
          <a className="tac-btn no-underline" href="/manual/archive/index.html" target="_blank" rel="noreferrer">
            How It Was Built
          </a>
          <button className="tac-btn" onClick={() => setShowCredits((s) => !s)}>
            About
          </button>
        </div>

        {showCredits && (
          <div className="panel mt-3 p-4 text-xs text-inkdim leading-relaxed fade-in">
            <p className="mb-2">
              <span className="text-ink">In the Mountains</span> is a deep tactical-strategic simulation of
              counterinsurgency at the platoon/company level, inspired by Sebastian Junger&apos;s{" "}
              <em>War</em> and the documentaries <em>Restrepo</em> and <em>Korengal</em>, by Jake
              Tapper&apos;s <em>The Outpost</em>, and by the field manuals and after-action accounts of the
              units who fought in the Pech and Korengal valleys.
            </p>
            <p className="mb-2">
              Every round fired is simulated. Line of sight is computed against the terrain; the ridgelines,
              draws, and dead ground are as much a part of the fight as the enemy. The valley is procedurally
              generated from your seed — no two deployments are the same.
            </p>
            <p className="text-[10px] opacity-70">
              This is a work of fiction and a game. It is dedicated, with respect, to those who served there.
            </p>
          </div>
        )}
        <div className="text-center text-[10px] text-inkdim/60 mt-6 font-mono">
          ONE CONTINUOUS CLOCK · SPACE pause · 1–5 speed · T skip to next event · the valley never stops
        </div>
      </div>
    </div>
  );
}
