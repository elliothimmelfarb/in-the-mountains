import { clamp, clamp01 } from "../rng";
import { dist } from "../vec";
import { Supplies, VillageState, PROJECT_PAYOFF, PROJECT_PAYOFF_DEFAULT } from "../campaign";
import type { World } from "./world";
import { spawnRoadAmbush } from "./director";

/**
 * CERP projects and resupply — the logistics half of counterinsurgency. A
 * project can't just be "bought": materials have to be trucked in, a local
 * contractor and labor brought on, and the site kept secure for days of work,
 * or the insurgents intimidate the crew and the job stalls.
 */
export function tickProjects(w: World, dt: number) {
  for (const p of w.state.projects) {
    if (p.stage === "complete" || p.stage === "sabotaged") continue;
    const v = w.state.villages.find((x) => x.id === p.villageId);
    if (!v) continue;

    if (!p.materialsDelivered && w.state.clock >= p.etaMaterials) {
      if (w.state.supplies.construction >= 6) {
        w.state.supplies.construction -= 6;
        p.materialsDelivered = true;
        w.log(`Construction materials delivered to ${v.name} for the ${p.type}.`, "support");
      } else {
        p.etaMaterials = w.state.clock + 2 * 3600; // short on materials — wait
      }
    }
    if (!p.contractorOnSite && w.state.clock >= p.etaContractor) {
      p.contractorOnSite = true;
      w.log(`Local contractor and labor arrive at ${v.name} to start the ${p.type}.`, "info");
    }
    if (p.materialsDelivered && p.contractorOnSite && p.stage !== "building") {
      p.stage = "building";
      w.log(`Work begins on the ${p.type} at ${v.name}. It will need securing.`, "info");
      w.interrupt(`${v.name} ${p.type} broke ground`);
    }

    if (p.stage === "building") {
      if (securityAt(w, v, 80)) {
        p.progress = clamp01(p.progress + dt / p.buildSeconds);
        p.stalledS = 0;
        if (p.progress >= 1) {
          p.stage = "complete";
          v.projects.push(p.type);
          // Per-type payoff, amplified if this was what the village WANTED (or the elder asked
          // for), damped if it's off-want (you built a wall when they wanted a clinic). FM 3-24:
          // deliver what they need, not what's easy.
          const base = PROJECT_PAYOFF[p.type] ?? PROJECT_PAYOFF_DEFAULT;
          const wanted = v.wants === p.type || (v.ask?.kind === "project" && v.ask.projectType === p.type);
          const gain = base * (wanted ? 1.6 : 0.6);
          v.attitude = clamp(v.attitude + gain, -100, 100);
          v.sympathy = clamp(v.sympathy - gain * 0.6, 0, 100);
          v.cooperation = clamp(v.cooperation + gain * 0.5, 0, 100);
          // A completed project that fulfills an outstanding project ASK = a kept promise (A6).
          if (v.ask && !v.ask.fulfilled && v.ask.kind === "project" && (v.ask.projectType === p.type || !v.ask.projectType)) {
            w.fulfillAsk(v, `the promised ${p.type}`);
          }
          // The battalion partially reimburses a delivered project — the second CERP income path
          // (A4), tying spend → delivery → budget so CERP is a managed economy, not a countdown.
          w.state.cerp += 1500;
          w.advanceDirective("construct", 1);
          w.state.metrics.higherConfidence = clamp(w.state.metrics.higherConfidence + 2, 0, 100);
          w.log(
            `The ${p.type} at ${v.name} is finished${wanted ? " — exactly what they asked for" : ""}. The valley will notice who built it.`,
            "objective"
          );
          w.interrupt(`${v.name} ${p.type} complete`);
        }
      } else {
        p.stalledS += dt;
        if (p.stalledS > 6 * 3600 && w.rng.chance((dt / 3600) * 0.05 * (1 + v.sympathy / 100))) {
          p.stage = "sabotaged";
          p.progress = clamp01(p.progress - 0.4);
          v.attitude = clamp(v.attitude - 4, -100, 100);
          w.log(`Insurgents intimidated the work crew at ${v.name}. The ${p.type} is stalled and damaged.`, "casualty");
          w.interrupt(`${v.name} project sabotaged`);
        }
      }
    }
  }
}

function securityAt(w: World, v: VillageState, radius: number): boolean {
  const c = w.terrain.cellCenter(v.cx, v.cy);
  // A dedicated secure-build element holding this village's site counts as security — it's an
  // all-round perimeter ON the site, so we use a more generous radius (it may still be filing in).
  const secure = w.state.tasks.find(
    (t) => t.kind === "secure" && t.secureVillageId === v.id && t.phase !== "complete" && t.phase !== "returning"
  );
  if (secure) {
    let onSite = 0;
    for (const id of secure.memberIds) {
      const u = w.sim.unit(id);
      if (u && u.alive && !u.evac && dist(u.pos, c) < radius * 1.6) onSite++;
      if (onSite >= 2) return true;
    }
  }
  // Fallback: any 2 friendlies within the tight radius (a patrol passing through / holding it).
  let n = 0;
  for (const u of w.sim.units) {
    if ((u.faction === "us" || u.faction === "ana") && u.alive && !u.evac && dist(u.pos, c) < radius) n++;
    if (n >= 2) return true;
  }
  return false;
}

export function tickResupplies(w: World) {
  const ready = w.state.resupplies.filter((r) => w.state.clock >= r.eta);
  for (const r of ready) {
    if (r.kind === "air" && !w.state.weather.airAvailable) {
      r.eta = w.state.clock + 2 * 3600; // weather scrubbed it
      continue;
    }
    restock(w, r.frac);
    if (r.kind === "convoy" && w.rng.chance(0.22)) {
      w.log(`The resupply convoy was ambushed on the valley road but fought through.`, "casualty");
      spawnRoadAmbush(w);
    } else {
      w.log(`Resupply complete (${r.kind === "air" ? "air" : "ground convoy"}). The COP is topped up.`, "support");
    }
    w.interrupt("resupply arrived");
  }
  w.state.resupplies = w.state.resupplies.filter(
    (r) => !(w.state.clock >= r.eta && !(r.kind === "air" && !w.state.weather.airAvailable))
  );
}

function restock(w: World, frac: number) {
  const s = w.state.supplies;
  const cap = (k: keyof Supplies, max: number, add: number) => (s[k] = Math.min(max, s[k] + add * frac));
  cap("ammo_556", 24000, 14000); cap("ammo_762", 9000, 5000); cap("ammo_50", 1800, 900);
  cap("ammo_40mm", 300, 160); cap("mortar_60", 120, 70); cap("mortar_81", 80, 45);
  cap("grenades", 110, 60); cap("smoke", 90, 50); cap("water", 600, 320);
  cap("food", 560, 300); cap("fuel", 2800, 1400); cap("medical", 44, 24);
  cap("batteries", 180, 90); cap("construction", 80, 40);
  for (const m of w.sim.mortars) {
    if (m.weaponId === "mortar60") m.rounds = s.mortar_60;
    if (m.weaponId === "mortar81") m.rounds = s.mortar_81;
  }
}
