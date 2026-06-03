import { RNG, clamp, clamp01 } from "./rng";
import { CampaignState, pushLog, addIntel, currentPhase } from "./campaign";

export interface EventChoice {
  id: string;
  label: string;
  hint?: string;
}

export interface GameEvent {
  id: string;
  kind: string;
  title: string;
  body: string;
  choices: EventChoice[];
  cx?: number;
  cy?: number;
}

let _evid = 0;

/** Maybe generate a decision-point event during phase advance. Returns null most phases. */
export function maybeEvent(state: CampaignState, rng: RNG): GameEvent | null {
  if (state.ended) return null;
  if (!rng.chance(0.32)) return null;

  const pool: (() => GameEvent | null)[] = [
    () => walkInInformant(state, rng),
    () => sickChild(state, rng),
    () => anaFriction(state, rng),
    () => idedDiscovery(state, rng),
    () => elderComplaint(state, rng),
    () => resupplyOffer(state, rng),
    () => detaineeQuestion(state, rng),
  ];
  const ev = rng.pick(pool)();
  return ev;
}

function walkInInformant(state: CampaignState, rng: RNG): GameEvent {
  const v = rng.pick(state.villages);
  return {
    id: `ev-${_evid++}`,
    kind: "informant",
    title: "A Man at the Gate",
    body: `A nervous young man from ${v.name} approaches the COP wire after dark. Through the terp he says he knows where the fighters cache their weapons — but he wants money, and protection for his family. He could be telling the truth. He could be bait for an ambush, or settling a tribal score.`,
    choices: [
      { id: "pay", label: "Pay him and act on the intel", hint: "Costs CERP. Intel may be good — or a trap." },
      { id: "listen", label: "Hear him out, no money", hint: "Lower-quality intel, no cost." },
      { id: "turn_away", label: "Turn him away", hint: "Safe, but you learn nothing." },
    ],
    cx: v.cx,
    cy: v.cy,
  };
}

function sickChild(state: CampaignState, rng: RNG): GameEvent {
  const v = rng.pick(state.villages);
  return {
    id: `ev-${_evid++}`,
    kind: "sick_child",
    title: "A Sick Child",
    body: `A father carries his feverish daughter to the gate of ${v.name === undefined ? "the COP" : "the COP"}, begging for the doctor. Your medic could help — it would cost supplies and time, and the line between medicine and a propaganda risk is thin. But turning away a sick child has its own cost in the valley.`,
    choices: [
      { id: "treat", label: "Have the medic treat her", hint: "Costs medical supplies. Wins goodwill." },
      { id: "refuse", label: "Refuse — not a clinic", hint: "Saves supplies. Hurts attitudes." },
    ],
    cx: v.cx,
    cy: v.cy,
  };
}

function anaFriction(state: CampaignState, rng: RNG): GameEvent {
  void rng;
  return {
    id: `ev-${_evid++}`,
    kind: "ana",
    title: "Trouble with the ANA",
    body: `Your partnered ANA squad is refusing to go on tomorrow's patrol — they say they haven't been paid, and one of them was seen high on hash on guard. Your partnership metrics depend on keeping them in the fight, but so does your platoon's trust in them.`,
    choices: [
      { id: "lean", label: "Lean on their commander hard", hint: "May restore discipline — or breed resentment." },
      { id: "cover", label: "Cover for them, pull the patrol yourself", hint: "Fatigues your men; keeps the peace." },
      { id: "report", label: "Report them up the chain", hint: "Honest, but slow and politically costly." },
    ],
  };
}

function idedDiscovery(state: CampaignState, rng: RNG): GameEvent {
  void rng;
  return {
    id: `ev-${_evid++}`,
    kind: "ied",
    title: "Disturbed Earth",
    body: `A patrol reports freshly disturbed earth on the valley road near a culvert — a likely IED. EOD is two hours out by air, weather permitting. You can wait, blow it in place with what you have, or route around it and leave it for the locals to drive over.`,
    choices: [
      { id: "eod", label: "Wait for EOD", hint: "Safe, ties up a patrol for a phase." },
      { id: "blow", label: "Blow it in place yourself", hint: "Fast, small risk to the team." },
      { id: "mark", label: "Mark and bypass", hint: "Risk to civilians later; saves time." },
    ],
  };
}

function elderComplaint(state: CampaignState, rng: RNG): GameEvent {
  const v = rng.pick(state.villages);
  return {
    id: `ev-${_evid++}`,
    kind: "complaint",
    title: `Complaint from ${v.name}`,
    body: `${v.elder} sends word that a night patrol frightened the women of his compound and a door was broken. He wants a solatia payment and an apology. How you handle the small insults often matters more than the firefights.`,
    choices: [
      { id: "pay", label: "Pay solatia and apologize", hint: "Costs CERP. Restores trust." },
      { id: "apologize", label: "Apologize, no payment", hint: "Partial repair." },
      { id: "dismiss", label: "Dismiss the complaint", hint: "Saves money. Hardens the village." },
    ],
    cx: v.cx,
    cy: v.cy,
  };
}

function resupplyOffer(state: CampaignState, rng: RNG): GameEvent {
  void state;
  void rng;
  return {
    id: `ev-${_evid++}`,
    kind: "resupply",
    title: "Resupply Window",
    body: `Battalion offers a resupply. A ground convoy can bring everything but runs the gauntlet of the valley road and its IEDs. An air drop is safer but weather-dependent and limited to what a bird can sling.`,
    choices: [
      { id: "convoy", label: "Request ground convoy", hint: "Full resupply; IED/ambush risk." },
      { id: "air", label: "Request air resupply", hint: "Partial resupply; weather risk." },
      { id: "decline", label: "Decline — we're fine", hint: "No resupply this window." },
    ],
  };
}

function detaineeQuestion(state: CampaignState, rng: RNG): GameEvent {
  void state;
  void rng;
  return {
    id: `ev-${_evid++}`,
    kind: "detainee",
    title: "A Detainee",
    body: `A patrol detained a military-age male near a cache site. He matches no biometric record and won't talk. You can hold and evidence him for higher (the system rarely holds them), release him to keep the village calm, or hand him to the ANA — whose methods you can't fully control.`,
    choices: [
      { id: "evidence", label: "Evidence package to higher", hint: "By the book; likely released anyway." },
      { id: "release", label: "Release with a warning", hint: "Keeps the village calm." },
      { id: "ana", label: "Hand to the ANA", hint: "Intel possible; moral and political risk." },
    ],
  };
}

/** Apply a chosen option's effects to campaign state. */
export function applyEventChoice(state: CampaignState, rng: RNG, ev: GameEvent, choiceId: string) {
  const village = ev.cx !== undefined ? state.villages.find((v) => v.cx === ev.cx && v.cy === ev.cy) : undefined;
  switch (ev.kind) {
    case "informant": {
      if (choiceId === "pay") {
        state.cerp = Math.max(0, state.cerp - 2000);
        const good = rng.chance(0.6);
        if (good) {
          addIntel(state, {
            source: "HUMINT",
            text: `Paid source: weapons cache and a fighters' rest house near ${village?.name ?? "the upper village"}. High confidence.`,
            reliability: 0.85,
            cx: village ? village.cx + rng.int(-3, 3) : undefined,
            cy: village ? village.cy + rng.int(-3, 3) : undefined,
          });
          pushLog(state, "The source's intel checks out. A cache location is marked on the map.", "info");
        } else {
          state.enemyHeat = clamp01(state.enemyHeat + 0.15);
          pushLog(state, "The source led you wrong — possibly bait. The valley feels hotter tonight.", "info");
        }
      } else if (choiceId === "listen") {
        addIntel(state, {
          source: "HUMINT",
          text: `Walk-in claims fighters transit the draw above ${village?.name ?? "the village"} at night.`,
          reliability: 0.5,
        });
        pushLog(state, "You hear the man out and let him slip back into the dark.", "info");
      } else {
        pushLog(state, "You turn the man away from the wire.", "info");
      }
      break;
    }
    case "sick_child": {
      if (choiceId === "treat") {
        state.supplies.medical = Math.max(0, state.supplies.medical - 2);
        if (village) {
          village.attitude = clamp(village.attitude + 10, -100, 100);
          village.cooperation = clamp(village.cooperation + 8, 0, 100);
        }
        pushLog(state, "Doc treats the child. Her father presses his hand to his heart. Word spreads.", "info");
      } else {
        if (village) village.attitude = clamp(village.attitude - 8, -100, 100);
        pushLog(state, "You turn them away. The father carries his daughter back down the trail.", "info");
      }
      break;
    }
    case "ana": {
      if (choiceId === "lean") {
        state.metrics.higherConfidence = clamp(state.metrics.higherConfidence + (rng.chance(0.6) ? 4 : -3), 0, 100);
        pushLog(state, "You corner the ANA commander. Tomorrow they'll patrol — sullenly.", "info");
      } else if (choiceId === "cover") {
        for (const m of state.platoon.members) if (m.alive) m.rest = clamp01(m.rest - 0.1);
        pushLog(state, "Your platoon picks up the slack. The men are more tired, but the line holds.", "info");
      } else {
        state.metrics.higherConfidence = clamp(state.metrics.higherConfidence - 2, 0, 100);
        pushLog(state, "You report the ANA up the chain. Nothing happens quickly, as usual.", "info");
      }
      break;
    }
    case "ied": {
      if (choiceId === "eod") {
        pushLog(state, "EOD reduces the device. The road is clear. A patrol was tied up for hours.", "info");
        state.metrics.stability = clamp(state.metrics.stability + 1, 0, 100);
      } else if (choiceId === "blow") {
        if (rng.chance(0.15)) {
          pushLog(state, "The charge cooked off early — a soldier caught fragments. Minor wounds.", "casualty");
          const m = rng.pick(state.platoon.members.filter((x) => x.alive && x.status === "ready"));
          if (m) {
            m.status = "wounded";
            m.daysToRecover = rng.int(2, 6);
          }
        } else {
          pushLog(state, "You blow the IED in place. A geyser of dust, and the road is open.", "info");
        }
      } else {
        if (rng.chance(0.4)) {
          pushLog(state, "Days later, a jingle truck hit the bypassed IED. Civilian dead. The village blames you.", "casualty");
          for (const v of state.villages) v.attitude = clamp(v.attitude - 6, -100, 100);
        } else {
          pushLog(state, "You mark and bypass the device. Nothing comes of it — this time.", "info");
        }
      }
      break;
    }
    case "complaint": {
      if (choiceId === "pay") {
        state.cerp = Math.max(0, state.cerp - 800);
        if (village) village.attitude = clamp(village.attitude + 9, -100, 100);
        pushLog(state, "You pay solatia and apologize through the terp. The elder nods, mollified.", "info");
      } else if (choiceId === "apologize") {
        if (village) village.attitude = clamp(village.attitude + 4, -100, 100);
        pushLog(state, "You apologize. It helps, a little.", "info");
      } else {
        if (village) {
          village.attitude = clamp(village.attitude - 7, -100, 100);
          village.sympathy = clamp(village.sympathy + 5, 0, 100);
        }
        pushLog(state, "You dismiss the complaint. The elder leaves with a cold look.", "info");
      }
      break;
    }
    case "resupply": {
      if (choiceId === "convoy") {
        if (rng.chance(0.25)) {
          pushLog(state, "The convoy was ambushed on the road. It fought through, but a vehicle was damaged.", "casualty");
          state.metrics.combatPower = clamp(state.metrics.combatPower - 3, 0, 100);
        } else {
          pushLog(state, "The convoy made it. The COP is fully resupplied.", "info");
        }
        restock(state, 1);
      } else if (choiceId === "air") {
        if (state.weather.airAvailable) {
          pushLog(state, "Slingloads come in under the rotors. Partial resupply complete.", "info");
          restock(state, 0.6);
        } else {
          pushLog(state, "Weather socked in the birds. The air resupply scrubbed.", "info");
        }
      } else {
        pushLog(state, "You decline the resupply window.", "info");
      }
      break;
    }
    case "detainee": {
      if (choiceId === "evidence") {
        state.metrics.higherConfidence = clamp(state.metrics.higherConfidence + 1, 0, 100);
        if (rng.chance(0.7)) pushLog(state, "Higher releases the detainee within days. The men are bitter about it.", "info");
        else {
          addIntel(state, { source: "HIGHER", text: "Detainee tied to a local cell. Names passed down to you.", reliability: 0.7 });
          pushLog(state, "The detainee was a real catch. Higher passes useful names back down.", "info");
        }
      } else if (choiceId === "release") {
        if (village) village.attitude = clamp(village.attitude + 3, -100, 100);
        pushLog(state, "You cut the detainee loose. The village notices the restraint.", "info");
      } else {
        if (rng.chance(0.5)) addIntel(state, { source: "HUMINT", text: "ANA questioning produced a cache location. Provenance unclear.", reliability: 0.6 });
        state.metrics.higherConfidence = clamp(state.metrics.higherConfidence - 2, 0, 100);
        pushLog(state, "You hand the man to the ANA. You don't ask what happens next.", "info");
      }
      break;
    }
  }
  void currentPhase;
}

function restock(state: CampaignState, frac: number) {
  const s = state.supplies;
  s.ammo_556 = Math.min(20000, s.ammo_556 + 12000 * frac);
  s.ammo_762 = Math.min(8000, s.ammo_762 + 4000 * frac);
  s.ammo_50 = Math.min(2000, s.ammo_50 + 800 * frac);
  s.ammo_40mm = Math.min(300, s.ammo_40mm + 150 * frac);
  s.mortar_60 = Math.min(120, s.mortar_60 + 60 * frac);
  s.mortar_81 = Math.min(90, s.mortar_81 + 40 * frac);
  s.grenades = Math.min(120, s.grenades + 60 * frac);
  s.smoke = Math.min(80, s.smoke + 40 * frac);
  s.water = Math.min(360, s.water + 200 * frac);
  s.food = Math.min(360, s.food + 200 * frac);
  s.fuel = Math.min(2500, s.fuel + 1200 * frac);
  s.medical = Math.min(40, s.medical + 20 * frac);
  s.batteries = Math.min(160, s.batteries + 80 * frac);
}
