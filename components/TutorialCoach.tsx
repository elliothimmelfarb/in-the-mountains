"use client";
import { useGame } from "@/state/store";

interface Step {
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: "Welcome to the COP",
    body:
      "You command this combat outpost and the soldiers in it. There are no turns — one clock runs the whole valley, all the time. The big map is your ground: shaded-relief terrain at 5-metre fidelity, your COP (blue flag), and the villages. Drag to pan, scroll to zoom.",
  },
  {
    title: "Time Is Always Moving",
    body:
      "Top-right are the time controls. SPACE pauses. 1–5 set the speed (1× is real time; combat clamps to 4×). The ⏩ button (T) fast-forwards through the quiet hours and stops the instant something matters — contact, a patrol reaching its objective, a project finishing, a decision at the gate. Everything below takes real time.",
  },
  {
    title: "Read the Valley",
    body:
      "The five bars are your campaign: Stability, village Attitudes, estimated Enemy strength, your Combat Power, and Higher's Confidence. Top-left shows the clock, the light (day/night drives what you and the enemy can see), and the weather — which decides whether you'll have air. Win the valley, not the body count.",
  },
  {
    title: "Send a Patrol",
    body:
      "Select soldiers on the map (click or drag a box) or toggle whole squads in the Patrol Planner on the right. Pick a mission and a movement POSTURE — Concealed is slow and hard to spot and hugs forest and washes; Rush is fast, loud and exposed. Hit 'Draw Route', click waypoints on the map, then 'Step Off'. The element kits up, then moves — it all takes time.",
  },
  {
    title: "When Rounds Crack",
    body:
      "Contact happens organically when units see each other. The clock slows to combat speed. Select your soldiers and use the order bar — Move, Assault, Hold, Suppress, Smoke, Frag, Withdraw — and right-click to quick-move or engage. Get people behind cover; the terrace walls and qalats stop bullets, the open ground does not. Call mortars or air from Fire Support, and MEDEVAC your wounded.",
  },
  {
    title: "Win the People",
    body:
      "Click a village to meet its elder. Send an element for a shura (KLE) to raise attitude and gather intel. Fund a CERP project — but a well or clinic isn't instant: materials must be trucked in, a contractor brought on, and a squad must keep the site secure for days or the insurgents intimidate the crew. Counterinsurgency is logistics and patience.",
  },
  {
    title: "You Have the Watch",
    body:
      "That's the loop, and it never stops: patrol, fight, build, resupply, rest — across a whole deployment, on one clock. Read the full Field Manual from the menu any time. Keep your soldiers alive and the valley leaning your way. Good luck, commander.",
  },
];

export default function TutorialCoach() {
  const tutorial = useGame((s) => s.tutorial);
  const step = useGame((s) => s.tutorialStep);
  const next = useGame((s) => s.tutorialNext);
  const prev = useGame((s) => s.tutorialPrev);
  const end = useGame((s) => s.endTutorial);
  if (!tutorial) return null;
  const s = STEPS[Math.min(step, STEPS.length - 1)];

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] w-[480px] max-w-[92vw] panel border-amber p-4 fade-in shadow-2xl">
      <div className="flex items-center justify-between mb-1">
        <div className="stencil text-[10px] text-amber">Tutorial · {step + 1}/{STEPS.length}</div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={end}>Skip ✕</button>
      </div>
      <h3 className="text-ink text-base font-bold mb-1">{s.title}</h3>
      <p className="text-inkdim text-[13px] leading-relaxed">{s.body}</p>
      <div className="flex justify-between items-center mt-3">
        <button className="tac-btn text-[11px]" onClick={prev} disabled={step === 0}>◂ Back</button>
        {step < STEPS.length - 1 ? (
          <button className="tac-btn active text-[11px]" onClick={next}>Next ▸</button>
        ) : (
          <button className="tac-btn active text-[11px]" onClick={end}>Begin ▸</button>
        )}
      </div>
    </div>
  );
}
