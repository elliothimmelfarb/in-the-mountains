"use client";
import { useGame } from "@/state/store";

interface Step {
  screen: string | null; // restrict to a screen, or null for any
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    screen: "command",
    title: "Welcome to the COP",
    body:
      "You command this combat outpost and the soldiers in it. This is the Command view — the strategic layer. The big map is your valley: shaded-relief terrain, contour lines, your COP (the blue flag), and the villages. Drag to pan, scroll to zoom.",
  },
  {
    screen: "command",
    title: "Read the Command Bar",
    body:
      "Top-left is the day, the phase of day (Dawn/Day/Dusk/Night), the light level, and the weather — which decides whether you'll have air support. The five bars are your campaign: Stability, village Attitudes, estimated Enemy strength, your Combat Power, and Higher's Confidence in you. Win the valley, not the body count.",
  },
  {
    screen: "command",
    title: "Intel & Directives (left)",
    body:
      "The left column holds Battalion's Directives (your objectives and deadlines), the Intel Feed (SIGINT chatter, HUMINT from villagers, drone hits — each with a reliability %), and the Command Log. Intel is often wrong. Corroborate it.",
  },
  {
    screen: "command",
    title: "Plan a Patrol (right)",
    body:
      "On the right, pick a Mission type, then build your element by clicking soldiers or a squad header to toggle the whole squad. Bring a DOC (medic) — without one, your wounded bleed. Watch the readiness dots: green = ready, amber = resting, red = wounded.",
  },
  {
    screen: "command",
    title: "Draw the Route",
    body:
      "With 'Plan Route' selected (top-left of the map), click the map to drop waypoints from the COP outward. Distance is shown. Then press 'Step Off'. Most patrols are uneventful — but when the valley decides to fight, you drop into the tactical layer.",
  },
  {
    screen: "command",
    title: "Engage the People",
    body:
      "Switch to 'Inspect' and click a village to meet its elder: hold a shura (KLE) to raise attitude and gather intel, or fund a CERP project (a well, a school) to win goodwill. Counterinsurgency is won here, over tea, as much as in any firefight.",
  },
  {
    screen: "command",
    title: "Advance Time",
    body:
      "When you've given your orders, press 'Advance' (top-right) to move to the next phase of the day. Events and enemy activity happen between phases. Your men rest and heal at the COP — but the valley never fully sleeps, especially at night.",
  },
  {
    screen: "tactical",
    title: "Troops in Contact",
    body:
      "This is the tactical layer. Every round fired is simulated against the terrain — line of sight, cover, concealment. LEFT-CLICK or drag a box to select soldiers. RIGHT-CLICK to move them, or right-click an enemy to engage. SPACE pauses; 1/2/3 set speed.",
  },
  {
    screen: "tactical",
    title: "Fight Smart",
    body:
      "Use the order bar to take cover, suppress, pop smoke, or assault. Get your people OFF the X and behind cover — being caught in the open kills. Call mortars or air from the Fire Support panel (mind DANGER CLOSE). MEDEVAC your wounded. When it's over, break contact with 'End Contact'.",
  },
  {
    screen: null,
    title: "You Have the Watch",
    body:
      "That's the loop: plan, patrol, fight, manage, repeat — for a whole deployment. Read the full Field Manual from the menu any time. Keep your soldiers alive and the valley leaning your way. Good luck, commander.",
  },
];

export default function TutorialCoach() {
  const tutorial = useGame((s) => s.tutorial);
  const step = useGame((s) => s.tutorialStep);
  const screen = useGame((s) => s.screen);
  const next = useGame((s) => s.tutorialNext);
  const prev = useGame((s) => s.tutorialPrev);
  const end = useGame((s) => s.endTutorial);
  if (!tutorial) return null;
  const s = STEPS[Math.min(step, STEPS.length - 1)];
  // If a step is bound to a screen we aren't on, show a gentle nudge instead.
  const onWrongScreen = s.screen && s.screen !== screen;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[60] w-[460px] max-w-[92vw] panel border-amber p-4 fade-in shadow-2xl">
      <div className="flex items-center justify-between mb-1">
        <div className="stencil text-[10px] text-amber">Tutorial · {step + 1}/{STEPS.length}</div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={end}>Skip ✕</button>
      </div>
      {onWrongScreen ? (
        <div className="text-inkdim text-sm py-2">
          {s.screen === "tactical"
            ? "When a patrol makes contact, you'll drop into the tactical view and the next tips will appear. Launch a patrol to continue — or skip."
            : "Return to the Command view to continue the tutorial."}
        </div>
      ) : (
        <>
          <h3 className="text-ink text-base font-bold mb-1">{s.title}</h3>
          <p className="text-inkdim text-[13px] leading-relaxed">{s.body}</p>
        </>
      )}
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
