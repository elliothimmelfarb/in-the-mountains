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
      "You are the commander on the radio. You command SQUADS, never individual soldiers — you give a squad its ground and its orders, and the squad leader and his men do the rest. There are no turns — one clock runs the whole valley, all the time. The big map is your ground: shaded-relief terrain at 5-metre fidelity, your COP (blue flag), and the villages. Drag to pan, scroll to zoom.",
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
      "Pick a squad — click one in Task Organization on the right, or click any of its men on the map. Choose a mission, then set its SOP, the standing orders it fights by: MOVEMENT (Stealth hugs cover and is hard to spot; Fast takes the roads), ON CONTACT (Hold & Return Fire, Suppress & Call Fires, Assault, or Break Contact), and ROE (Weapons Hold / Tight / Free — Tight keeps your fire off civilians). Optionally send officers (the HQ medic/JTAC). Hit 'Draw Route', click waypoints, then 'Step Off'. The squad leader gets them there.",
  },
  {
    title: "The Fight You Don't Click",
    body:
      "When rounds crack, the squad fights itself — you do NOT move men or pull triggers. Watch it run the drill you set: it sets a base of fire and bounds a maneuver team onto the enemy (Assault), pins and calls for fire (Suppress), or peels back to a rally point (Break). A squad that is shot up breaks contact on its own. Its SOP locks the moment it's in contact — you set the conditions beforehand and live with them. When the JTAC requests fire support, APPROVE or DENY the call. Your levers are the radio: fires, MEDEVAC, and the orders you gave before they stepped off.",
  },
  {
    title: "Win the People",
    body:
      "Click a village to meet its elder. Send an element for a shura (KLE) to raise attitude and gather intel. Fund a CERP project — but a well or clinic isn't instant: materials must be trucked in, a contractor brought on, and a squad must keep the site secure for days or the insurgents intimidate the crew. Counterinsurgency is logistics and patience.",
  },
  {
    title: "You Have the Watch",
    body:
      "That's the loop, and it never stops: choose where your squads go and how they fight, then read the net and live with how it plays out — patrol, fight, build, resupply, rest, across a whole deployment on one clock. The hardest part of command is trusting your plan and your men. Read the full Field Manual from the menu any time. Keep your soldiers alive and the valley leaning your way. Good luck, commander.",
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
