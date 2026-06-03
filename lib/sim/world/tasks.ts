import { clamp } from "../rng";
import { dist, Vec2 } from "../vec";
import { Unit } from "../entities";
import type { World } from "./world";
import { Task } from "./types";
import { centroidOf, dwellFor } from "./helpers";

/**
 * Strategic tasks: the orders that take time. A patrol kits up at the wire,
 * steps off along a terrain-routed path, dwells on its objective, then comes
 * home — and combat AI takes over the instant rounds start cracking, with the
 * task resuming on the lull. KLEs and project-security work run the same way.
 */
export function tickTasks(w: World, dt: number) {
  for (const t of w.state.tasks) {
    if (t.phase === "complete") continue;
    const members = t.memberIds.map((id) => w.sim.unit(id)).filter((u): u is Unit => !!u && u.alive && !u.evac);
    if (members.length === 0) {
      t.phase = "complete";
      continue;
    }
    const centroid = centroidOf(members);
    const contact = members.some((m) => m.visibleEnemyIds.length > 0 || m.suppression > 0.3);

    switch (t.phase) {
      case "assembling": {
        t.timer -= dt;
        for (const m of members) {
          if (m.path.length === 0 && dist(m.pos, w.copWorld()) > 30) w.sim.moveTo(m, w.copWorld());
        }
        if (t.timer <= 0) {
          t.phase = "moving";
          t.legIndex = 0;
          issueLeg(w, t, members);
          w.log(`${t.label}: ${members.length} pax stepping off (${t.technique}).`, "radio");
          w.interrupt(`${t.label} steps off`);
        }
        break;
      }
      case "moving": {
        if (!contact) driveLeg(w, t, members, centroid);
        break;
      }
      case "onstation": {
        if (!contact) {
          t.timer -= dt;
          onStationEffects(w, t, members, dt);
          if (t.timer <= 0) {
            t.phase = "returning";
            for (const m of members) {
              m.technique = t.technique;
              w.sim.pathTo(m, w.copWorld());
            }
            w.log(`${t.label}: objective complete, returning to ${w.state.fob.name}.`, "radio");
          }
        }
        break;
      }
      case "returning": {
        if (!contact) {
          if (dist(centroid, w.copWorld()) < 45) {
            t.phase = "complete";
          } else {
            for (const m of members) {
              if (m.path.length === 0 && dist(m.pos, w.copWorld()) > 22) w.sim.pathTo(m, w.copWorld());
            }
          }
        }
        break;
      }
    }
  }

  // clean up finished tasks and stand the men down
  const done = w.state.tasks.filter((t) => t.phase === "complete");
  for (const t of done) {
    for (const id of t.memberIds) {
      const m = w.platoon.members.find((x) => x.id === id);
      if (m && m.alive) {
        m.status = m.rest < 0.5 ? "rest" : "ready";
        m.brainState = "garrison";
        m.technique = undefined;
        m.path = [];
      }
    }
    if (t.kind !== "standto") {
      w.log(`${t.label}: element back inside the wire.`, "info");
      w.interrupt(`${t.label} returned`);
    }
  }
  w.state.tasks = w.state.tasks.filter((t) => t.phase !== "complete");
}

function issueLeg(w: World, t: Task, members: Unit[]) {
  const target = t.route[t.legIndex];
  if (!target) return;
  for (const m of members) {
    m.technique = t.technique;
    m.brainState = "moving";
    m.rof = t.missionType === "ambush" || t.missionType === "overwatch" ? "hold" : "free";
    w.sim.pathTo(m, target, { concealBias: t.technique === "concealed" ? 0.7 : t.technique === "tactical" ? 0.35 : 0 });
  }
}

function driveLeg(w: World, t: Task, members: Unit[], centroid: Vec2) {
  const target = t.route[t.legIndex];
  if (!target) {
    t.phase = "onstation";
    t.timer = dwellFor(t);
    return;
  }
  if (dist(centroid, target) < 28) {
    t.legIndex++;
    if (t.legIndex >= t.route.length) {
      t.phase = "onstation";
      t.timer = dwellFor(t);
      for (const m of members) m.path = [];
      w.interrupt(`${t.label} on objective`);
    } else {
      issueLeg(w, t, members);
    }
    return;
  }
  for (const m of members) {
    if (m.path.length === 0 && m.brainState !== "moving" && dist(m.pos, target) > 22) {
      m.technique = t.technique;
      m.brainState = "moving";
      w.sim.pathTo(m, target, { concealBias: t.technique === "concealed" ? 0.7 : 0 });
    }
  }
}

function onStationEffects(w: World, t: Task, members: Unit[], dt: number) {
  const here = centroidOf(members);
  const near = w.nearestVillage(here, 70);
  if (t.kind === "kle" && near) {
    near.attitude = clamp(near.attitude + (8 / 360) * dt, -100, 100);
    near.cooperation = clamp(near.cooperation + (10 / 360) * dt, 0, 100);
    near.lastVisitedDay = w.day;
    if (w.rng.chance(0.02 * dt)) {
      w.addIntel({
        source: "HUMINT",
        text: `${near.elder} hints outsiders pressure his village and cache weapons up the draw.`,
        reliability: 0.5 + near.cooperation / 250,
        cx: near.cx,
        cy: near.cy,
      });
    }
    w.advanceDirective("kle", (0.5 / 360) * dt);
  } else if (near && (t.missionType === "presence" || t.missionType === "cordon")) {
    near.attitude = clamp(near.attitude + (3 / dwellFor(t)) * dt, -100, 100);
    near.lastVisitedDay = w.day;
    w.advancePresence();
    if (t.missionType === "cordon" && w.rng.chance(0.015 * dt) && near.sympathy > 30) {
      near.sympathy = clamp(near.sympathy - 1, 0, 100);
    }
  } else if (t.missionType === "census" && near) {
    near.censusDone = true;
    near.lastVisitedDay = w.day;
    w.advanceCensus();
  } else if (t.missionType === "recon" && w.rng.chance(0.02 * dt)) {
    w.addIntel({
      source: "PATROL",
      text: `Patrol reports trail use and fresh tracks in the ${w.bearingDesc(here)} valley.`,
      reliability: 0.6,
      cx: Math.round(here.x / w.terrain.cellSize),
      cy: Math.round(here.y / w.terrain.cellSize),
    });
  }
}
