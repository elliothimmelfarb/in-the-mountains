import { clamp, clamp01 } from "../rng";
import type { World } from "./world";
import { PendingEvent, Ids } from "./types";

/**
 * Decision-point events — the human texture between firefights. They surface
 * occasionally on the continuous clock; the UI pauses time while you decide.
 */
export function makeWorldEvent(w: World): PendingEvent | null {
  const rng = w.rng;
  const v = rng.pick(w.state.villages);
  const pool: (() => PendingEvent)[] = [
    () => ({
      id: `ev-${Ids.ev++}`,
      kind: "informant",
      title: "A Man at the Gate",
      body: `A nervous young man from ${v.name} approaches the wire after dark. Through the terp he says he knows where the fighters cache their weapons — but he wants money and protection for his family. He could be telling the truth, or be bait, or settling a tribal score.`,
      choices: [
        { id: "pay", label: "Pay him and act on the intel", hint: "Costs CERP. Intel may be good — or a trap." },
        { id: "listen", label: "Hear him out, no money", hint: "Lower-quality intel, no cost." },
        { id: "turn_away", label: "Turn him away", hint: "Safe, but you learn nothing." },
      ],
      cx: v.cx,
      cy: v.cy,
    }),
    () => ({
      id: `ev-${Ids.ev++}`,
      kind: "sick_child",
      title: "A Sick Child",
      body: `A father carries his feverish daughter to the gate, begging for the doctor. Your medic could help — it costs supplies and time, and the line between medicine and propaganda risk is thin. Turning away a sick child carries its own cost in the valley.`,
      choices: [
        { id: "treat", label: "Have the medic treat her", hint: "Costs medical supplies. Wins goodwill." },
        { id: "refuse", label: "Refuse — not a clinic", hint: "Saves supplies. Hurts attitudes." },
      ],
      cx: v.cx,
      cy: v.cy,
    }),
    () => ({
      id: `ev-${Ids.ev++}`,
      kind: "complaint",
      title: `Complaint from ${v.name}`,
      body: `${v.elder} sends word that a patrol frightened the women of his compound and a door was broken. He wants a solatia payment and an apology. How you handle the small insults often matters more than the firefights.`,
      choices: [
        { id: "pay", label: "Pay solatia and apologize", hint: "Costs CERP. Restores trust." },
        { id: "apologize", label: "Apologize, no payment", hint: "Partial repair." },
        { id: "dismiss", label: "Dismiss the complaint", hint: "Saves money. Hardens the village." },
      ],
      cx: v.cx,
      cy: v.cy,
    }),
    () => ({
      id: `ev-${Ids.ev++}`,
      kind: "resupply",
      title: "Resupply Window",
      body: `Battalion offers a resupply. A ground convoy can bring everything but runs the gauntlet of the valley road. An air drop is safer but weather-dependent and limited.`,
      choices: [
        { id: "convoy", label: "Request ground convoy", hint: "Full resupply; IED/ambush risk." },
        { id: "air", label: "Request air resupply", hint: "Partial resupply; weather risk." },
        { id: "decline", label: "Decline — we're fine", hint: "No resupply this window." },
      ],
    }),
  ];
  return rng.pick(pool)();
}

export function applyWorldEventChoice(w: World, ev: PendingEvent, choiceId: string) {
  const rng = w.rng;
  const village = ev.cx !== undefined ? w.state.villages.find((v) => v.cx === ev.cx && v.cy === ev.cy) : undefined;
  switch (ev.kind) {
    case "informant": {
      if (choiceId === "pay") {
        w.state.cerp = Math.max(0, w.state.cerp - 2000);
        if (rng.chance(0.6)) {
          w.addIntel({
            source: "HUMINT",
            text: `Paid source: weapons cache near ${village?.name ?? "the upper village"}. High confidence.`,
            reliability: 0.85,
            cx: village ? village.cx + rng.int(-3, 3) : undefined,
            cy: village ? village.cy + rng.int(-3, 3) : undefined,
          });
          w.log("The source's intel checks out. A cache location is marked on the map.", "info");
        } else {
          w.state.enemyHeat = clamp01(w.state.enemyHeat + 0.15);
          w.log("The source led you wrong — possibly bait. The valley feels hotter tonight.", "info");
        }
      } else if (choiceId === "listen") {
        w.addIntel({ source: "HUMINT", text: `Walk-in claims fighters transit the draw above ${village?.name ?? "the village"} at night.`, reliability: 0.5 });
        w.log("You hear the man out and let him slip back into the dark.", "info");
      } else {
        w.log("You turn the man away from the wire.", "info");
      }
      break;
    }
    case "sick_child": {
      if (choiceId === "treat") {
        w.state.supplies.medical = Math.max(0, w.state.supplies.medical - 2);
        if (village) {
          village.attitude = clamp(village.attitude + 10, -100, 100);
          village.cooperation = clamp(village.cooperation + 8, 0, 100);
        }
        w.log("Doc treats the child. Her father presses his hand to his heart. Word spreads.", "info");
      } else {
        if (village) village.attitude = clamp(village.attitude - 8, -100, 100);
        w.log("You turn them away. The father carries his daughter back down the trail.", "info");
      }
      break;
    }
    case "complaint": {
      if (choiceId === "pay") {
        w.state.cerp = Math.max(0, w.state.cerp - 800);
        if (village) village.attitude = clamp(village.attitude + 9, -100, 100);
        w.log("You pay solatia and apologize through the terp. The elder nods, mollified.", "info");
      } else if (choiceId === "apologize") {
        if (village) village.attitude = clamp(village.attitude + 4, -100, 100);
        w.log("You apologize. It helps, a little.", "info");
      } else {
        if (village) {
          village.attitude = clamp(village.attitude - 7, -100, 100);
          village.sympathy = clamp(village.sympathy + 5, 0, 100);
        }
        w.log("You dismiss the complaint. The elder leaves with a cold look.", "info");
      }
      break;
    }
    case "resupply": {
      if (choiceId === "convoy") w.requestResupply("convoy");
      else if (choiceId === "air") w.requestResupply("air");
      else w.log("You decline the resupply window.", "info");
      break;
    }
  }
  w.pendingEvent = null;
}
