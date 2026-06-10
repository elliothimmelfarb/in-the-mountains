import { clamp, clamp01 } from "../rng";
import type { World } from "./world";
import type { VillageState } from "../campaign";
import { PendingEvent, Ids, Task } from "./types";

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

/**
 * On-station DWELL events — the human texture of a multi-hour cordon-and-search, census, or shura.
 * Where makeWorldEvent surfaces at the gate, these surface AT the village while an element works it.
 * They're what make a realistic hours-long dwell worth warping through: the player skips the patient
 * hours and is pulled back the instant the search element turns up a cache, an enrolled man pings the
 * BOLO list, a herder demands solatia (the Restrepo "Cow Incident"), the FET gap blocks the women's
 * quarters, or a fighting-age male bolts the cordon. The mission type gates which can fire.
 */
export function makeDwellEvent(w: World, t: Task, v: VillageState, exclude?: string): PendingEvent | null {
  const rng = w.rng;
  const mk = (kind: string, title: string, body: string, choices: PendingEvent["choices"]): PendingEvent => ({
    id: `dv-${Ids.ev++}`,
    kind,
    title,
    body,
    choices,
    cx: v.cx,
    cy: v.cy,
  });
  const isSearch = t.missionType === "census" || t.missionType === "cordon";
  const isCensus = t.missionType === "census";
  const isCordon = t.missionType === "cordon";
  const isKLE = t.kind === "kle";

  const pool: { kind: string; make: () => PendingEvent }[] = [];
  const add = (cond: boolean, kind: string, title: string, body: string, choices: PendingEvent["choices"]) => {
    if (cond) pool.push({ kind, make: () => mk(kind, title, body, choices) });
  };

  // A grievance / MEDCAP can surface in any village engagement; the rest are gated by mission.
  // When the village carries an UNPAID BLOOD DEBT (a named civilian casualty of our fire — the
  // people-immersion ledger), the grievance is that, by name, and paying solatia settles it.
  const blood = (v.grievances ?? []).find((g) => !g.resolved);
  add(
    true,
    "dwell_grievance",
    blood ? "The Blood Debt" : "A Herder's Animals",
    blood
      ? `${v.elder} brings forward a man of ${blood.name}'s household. ${blood.name} was ${blood.killed ? "killed" : "wounded"} by your fire on day ${blood.day}, and the debt stands unpaid. The household asks for solatia and an acknowledgment in front of the village — and Pashtunwali will collect, one way or the other.`
      : `As your element works ${v.name}, ${v.elder} pushes through the terp, furious: a frightened goat was shot when it bolted the search, or a wall was knocked through. He wants solatia and an apology in front of the village. How you answer the small insults decides more than the firefights do.`,
    [
      { id: "pay", label: "Pay solatia and apologize publicly", hint: "Costs CERP. Restores trust." },
      { id: "apologize", label: "Apologize, no payment", hint: "Helps a little." },
      { id: "dismiss", label: "Dismiss it — not our problem", hint: "Saves money. Hardens the village." },
    ]
  );
  add(
    true,
    "dwell_medcap",
    "A Sick Child at the Cordon",
    `A mother brings a feverish child to your security element and won't be turned back. Doc could treat her on the spot — it costs medical supplies, and an impromptu MEDCAP in the middle of a search wins more goodwill than any patrol.`,
    [
      { id: "treat", label: "Have Doc treat the child", hint: "Costs medical supplies. Wins goodwill." },
      { id: "refuse", label: "Wave them off — we're working", hint: "Saves supplies. Hurts attitudes." },
    ]
  );
  add(
    isSearch,
    "dwell_find",
    "The Search Turns Up Something",
    `Your search element pulls back a false floor in a qalat in ${v.name}: a small cache — a couple of AKs wrapped in plastic, RPG rounds, a coil of det cord. The man of the house swears he's never seen it. He may be lying, or it may have been planted on him.`,
    [
      { id: "seize_quiet", label: "Seize it, photograph the household, move on", hint: "Removes the weapons. Mild resentment." },
      { id: "seize_detain", label: "Seize it and detain the head of household", hint: "Bigger blow to the fighters — heavy-handed, costs trust." },
      { id: "leave_watch", label: "Leave it, mark it, set surveillance", hint: "No cost to attitudes; intel on who comes for it." },
    ]
  );
  add(
    isCensus,
    "dwell_biometric",
    "A Biometric Hit",
    `An enrolled fighting-age male in ${v.name} lights up the BOLO list — his prints match a latent lifted off an IED that wounded two of your men months ago. He's calm, polite, and surrounded by his family.`,
    [
      { id: "detain", label: "Detain him for the prints", hint: "Likely removes a bomb-maker — wrong man = costly." },
      { id: "question", label: "Question and release with a tag", hint: "Some intel, no scene." },
      { id: "release", label: "Not enough to hold him — release", hint: "Plays it safe; he stays in the valley." },
    ]
  );
  add(
    isSearch,
    "dwell_fet",
    "The Women's Quarters",
    `To finish enrolling ${v.name} you'd have to search and biometric the women's side of the compounds — and you have no Female Engagement Team forward. The men of the household are planting themselves in the doorways. Push past them and you insult the whole village; respect it and a weapon or a fighter could be sitting behind that curtain.`,
    [
      { id: "respect", label: "Respect the quarters — leave them unsearched", hint: "Protects attitudes; the census stays incomplete." },
      { id: "wait_fet", label: "Hold and radio the FET forward", hint: "Slows things; the right answer culturally." },
      { id: "push", label: "Push your men in anyway", hint: "Finishes the census fast — a serious cultural insult." },
    ]
  );
  add(
    isCordon,
    "dwell_squirter",
    "A Squirter",
    `A fighting-age male breaks from a back compound and runs hard for the draw above ${v.name}, leaving his sandals in the dirt. Innocent men don't usually run — but the draw is perfect ambush ground, and a team that chases him is a team off the cordon.`,
    [
      { id: "pursue", label: "Send a team to run him down", hint: "May bag a fighter — or be led into the draw." },
      { id: "track", label: "Call it up, let the OP track him", hint: "Lower risk; he probably gets away." },
      { id: "let_go", label: "Hold the cordon, let him go", hint: "Keeps integrity; a fighter slips the net." },
    ]
  );
  add(
    isKLE || isCensus,
    "dwell_tip",
    "A Quiet Word",
    `While the shura breaks up, a boy presses a folded scrap into the terp's hand, or an old man holds your interpreter's sleeve a beat too long: a location, up one of the draws, where strangers come and go after dark. Acting on it openly could expose who talked.`,
    [
      { id: "act", label: "Act on it now", hint: "Strong lead — may burn the source." },
      { id: "note", label: "Note it quietly for later", hint: "Keeps the source safe; weaker lead." },
    ]
  );

  // Avoid firing the same kind twice in a row on one dwell (fall back to the full pool if excluding
  // it would leave nothing — e.g. a short cordon with only one eligible kind).
  const usable = pool.filter((p) => p.kind !== exclude);
  const choices = usable.length ? usable : pool;
  if (!choices.length) return null;
  return rng.pick(choices).make();
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
    // ---- on-station dwell events (cordon/census/KLE) -----------------------------------------
    case "dwell_grievance": {
      if (choiceId === "pay") {
        w.state.cerp = Math.max(0, w.state.cerp - 800);
        if (village) {
          village.attitude = clamp(village.attitude + 9, -100, 100);
          village.cooperation = clamp(village.cooperation + 4, 0, 100);
          // Settle the oldest unpaid blood debt by name (the people-immersion ledger):
          // the grievance stops feeding sympathy and the household stops grieving.
          const debt = (village.grievances ?? []).find((g) => !g.resolved);
          if (debt) {
            debt.resolved = true;
            w.log(`The ledger is settled for ${debt.name}. Not forgotten — but paid, in front of the village.`, "info");
          }
        }
        w.log("You pay solatia on the spot and apologize to the elder in front of his people.", "info");
      } else if (choiceId === "apologize") {
        if (village) village.attitude = clamp(village.attitude + 4, -100, 100);
        w.log("You apologize through the terp. It cools things, a little.", "info");
      } else {
        if (village) {
          village.attitude = clamp(village.attitude - 7, -100, 100);
          village.sympathy = clamp(village.sympathy + 5, 0, 100);
        }
        w.log("You wave the elder off and keep working. He walks away with a cold look.", "info");
      }
      break;
    }
    case "dwell_medcap": {
      if (choiceId === "treat") {
        w.state.supplies.medical = Math.max(0, w.state.supplies.medical - 2);
        if (village) {
          village.attitude = clamp(village.attitude + 9, -100, 100);
          village.cooperation = clamp(village.cooperation + 6, 0, 100);
        }
        w.log("Doc treats the child in the courtyard while the search goes on. Word of it spreads.", "info");
      } else {
        if (village) village.attitude = clamp(village.attitude - 7, -100, 100);
        w.log("You wave the mother off — the element is working. She carries the child away.", "info");
      }
      break;
    }
    case "dwell_find": {
      if (choiceId === "seize_quiet") {
        w.state.enemyStrengthAbs = clamp(w.state.enemyStrengthAbs - 3, 0, 100);
        if (village) village.cooperation = clamp(village.cooperation - 3, 0, 100);
        w.addIntel({ source: "PATROL", text: `Cache seized in ${village?.name ?? "the village"}: small arms, RPG, det cord.`, reliability: 0.7, cx: ev.cx, cy: ev.cy });
        w.log("You bag the cache, photograph the household, and move on. A few fighters just lost their guns.", "info");
      } else if (choiceId === "seize_detain") {
        w.state.enemyStrengthAbs = clamp(w.state.enemyStrengthAbs - 5, 0, 100);
        w.state.metrics.higherConfidence = clamp(w.state.metrics.higherConfidence + 1, 0, 100);
        if (village) {
          village.attitude = clamp(village.attitude - 8, -100, 100);
          village.sympathy = clamp(village.sympathy + 6, 0, 100);
        }
        w.log("You seize the cache and zip-cuff the head of household. His family watches from the wall.", "info");
      } else {
        w.addIntel({ source: "PATROL", text: `Cache left in place under surveillance near ${village?.name ?? "the village"} — watch who comes for it.`, reliability: 0.8, cx: ev.cx, cy: ev.cy });
        w.log("You leave the cache, mark it, and set eyes on it. Whoever comes back tells you more than the guns would.", "info");
      }
      break;
    }
    case "dwell_biometric": {
      if (choiceId === "detain") {
        if (w.rng.chance(0.6)) {
          w.state.enemyStrengthAbs = clamp(w.state.enemyStrengthAbs - 6, 0, 100);
          w.state.metrics.higherConfidence = clamp(w.state.metrics.higherConfidence + 2, 0, 100);
          w.log("The prints were his. A bomb-maker comes off the board — the village stays quiet about it.", "info");
        } else {
          if (village) {
            village.attitude = clamp(village.attitude - 10, -100, 100);
            village.sympathy = clamp(village.sympathy + 8, 0, 100);
          }
          w.log("You hold him for hours. It was a bad latent — the wrong man. The village does not forget it.", "casualty");
        }
      } else if (choiceId === "question") {
        w.addIntel({ source: "HUMINT", text: `Questioned a flagged male in ${village?.name ?? "the village"} — guarded, but a name or two slipped out.`, reliability: 0.5, cx: ev.cx, cy: ev.cy });
        w.log("You question him under the awning and let him go with a biometric tag.", "info");
      } else {
        if (village) village.sympathy = clamp(village.sympathy + 2, 0, 100);
        w.log("Not enough to hold him. You note the hit and release him to his family.", "info");
      }
      break;
    }
    case "dwell_fet": {
      if (choiceId === "push") {
        if (village) {
          village.censusProgress = clamp(village.censusProgress + 0.25, 0, 1);
          village.attitude = clamp(village.attitude - 12, -100, 100);
          village.sympathy = clamp(village.sympathy + 8, 0, 100);
        }
        w.log("You push your men past the doorway. The census finishes fast — and the whole village hardens against you.", "casualty");
      } else if (choiceId === "wait_fet") {
        if (village) village.attitude = clamp(village.attitude + 3, -100, 100);
        w.log("You hold the search and radio the Female Engagement Team forward. It costs time; it's the right call.", "info");
      } else {
        if (village) {
          village.attitude = clamp(village.attitude + 6, -100, 100);
          village.cooperation = clamp(village.cooperation + 4, 0, 100);
        }
        w.state.enemyHeat = clamp01(w.state.enemyHeat + 0.04);
        w.log("You leave the women's quarters alone. The elders note the respect — and a curtain or two goes unsearched.", "info");
      }
      break;
    }
    case "dwell_squirter": {
      if (choiceId === "pursue") {
        if (w.rng.chance(0.55)) {
          w.state.enemyStrengthAbs = clamp(w.state.enemyStrengthAbs - 4, 0, 100);
          w.state.metrics.higherConfidence = clamp(w.state.metrics.higherConfidence + 1, 0, 100);
          w.addIntel({ source: "PATROL", text: `Runner from ${village?.name ?? "the village"} run down in the draw — detained, weapon on him.`, reliability: 0.75, cx: ev.cx, cy: ev.cy });
          w.log("Your team runs him down in the draw. He was carrying — a fighter, not a farmer.", "info");
        } else {
          w.state.enemyHeat = clamp01(w.state.enemyHeat + 0.12);
          w.log("The draw was watched. Your team takes fire chasing the runner and breaks contact back to the cordon.", "casualty");
        }
      } else if (choiceId === "track") {
        w.addIntel({ source: "DRONE", text: `Squirter from ${village?.name ?? "the village"} tracked up the draw to a treeline — grid noted.`, reliability: 0.6, cx: ev.cx, cy: ev.cy });
        w.log("You call it up and let the OP track him. He goes to ground up the draw; the grid is marked.", "info");
      } else {
        if (village) village.sympathy = clamp(village.sympathy + 3, 0, 100);
        w.log("You hold the cordon and let him run. A fighter slips the net — the line stays unbroken.", "info");
      }
      break;
    }
    case "dwell_tip": {
      if (choiceId === "act") {
        w.addIntel({ source: "HUMINT", text: `Walk-in tip at ${village?.name ?? "the village"}: strangers transit a draw after dark — high confidence.`, reliability: 0.8, cx: village ? village.cx : ev.cx, cy: village ? village.cy : ev.cy });
        if (village) village.sympathy = clamp(village.sympathy + 3, 0, 100);
        w.log("You act on the tip. Good lead — but acting in the open may have marked who talked.", "info");
      } else {
        w.addIntel({ source: "HUMINT", text: `Quiet word at ${village?.name ?? "the village"}: a draw worth watching after dark.`, reliability: 0.5, cx: village ? village.cx : ev.cx, cy: village ? village.cy : ev.cy });
        w.log("You pocket the tip for later and keep the source safe.", "info");
      }
      break;
    }
  }
  w.pendingEvent = null;
}
