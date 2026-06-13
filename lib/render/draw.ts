import { Camera, worldToScreen } from "./topo";
import { Unit, Faction, Role } from "../sim/entities";
import { Terrain } from "../sim/terrain";
import { Projectile } from "../sim/ballistics";
import { Effect } from "../sim/combat";
import { SmokeScreen } from "../sim/los";
import { drawScreenSprite, drawWorldSprite, drawSunShadow, drawContactAO, hasSprite, lodAlpha, type SpriteLight } from "./sprites";

const FAC_COLOR: Record<string, string> = {
  us: "#5b9bd8",
  ana: "#6fae9f",
  insurgent: "#d0473a",
  civilian: "#e3c44a",
};

// One sim tick in seconds — MUST match SIM_DT in state/store.ts. Used to back-step a
// projectile/effect by the unrendered fraction of the current tick (render interpolation).
const SIM_TICK = 0.1;

/**
 * The on-screen world position of a direct-fire round, INTERPOLATED to the wall-clock
 * sub-tick fraction `frac` (0..1, from store.getSimFrac). The sim advances p.pos a full
 * ~88 m per 0.1 s tick, so reading p.pos verbatim makes a bullet teleport between ~2-3
 * frozen points (the "it appears midway" bug). We render it one tick behind, smoothly:
 * draw it where it was (1-frac) of a tick ago and let frac sweep it to the current point —
 * exactly lerp(prevTickPos, curTickPos, frac), continuous at 60 fps. Pure read of sim
 * fields; the sim is untouched (Law 7). Shared so the night-light glow tracks the same path.
 */
export function projRenderPos(p: Projectile, frac: number): { x: number; y: number } {
  if (p.indirect) return p.pos; // the lob already renders from age/timeToImpact (smooth arc)
  const rt = Math.max(0, Math.min(p.distToAim, p.traveled - p.speed * SIM_TICK * (1 - frac)));
  const m = Math.hypot(p.vel.x, p.vel.y) || 1;
  return { x: p.origin.x + (p.vel.x / m) * rt, y: p.origin.y + (p.vel.y / m) * rt };
}

// ---- figure-sprite LOD: symbol below FIG_FADE0, sprite above FIG_FADE1, crossfade between ----
// Pushed to genuinely TACTICAL zoom: below FIG_FADE0 a man is drawn as one small NATO dot
// (and his SQUAD as a single icon — see drawSquadIcon / WorldView), above FIG_FADE1 he's a
// detailed figure at near-true footprint. The default ppm 0.7 now sits firmly in the
// dot/squad-icon band, not mid-crossfade.
export const FIG_FADE0 = 2.5;
export const FIG_FADE1 = 3.5;
// A soldier occupies ~0.5–0.7 m top-down; we draw a generous shoulder-to-shoulder kit
// footprint of 1.6 m so the figure tracks reality with only a SMALL legibility floor (7 px),
// instead of the old fixed 15 px floor that painted a man 5–50 m wide on the ground.
// IMPORTANT: combat-fx.ts mirrors this exactly (figurePx there imports SOLDIER_FOOTPRINT_M /
// the same clamp) so the suppression crescent / bleed pool / casualty cues stay hugged to the
// figure base ring. Change one → change the other. (See lib/render/combat-fx.ts figurePx.)
export const SOLDIER_FOOTPRINT_M = 1.6;
export const FIG_FLOOR_PX = 7;
export const FIG_CAP_PX = 26;
export function figurePx(ppm: number): number {
  return Math.max(FIG_FLOOR_PX, Math.min(FIG_CAP_PX, ppm * SOLDIER_FOOTPRINT_M));
}
/** NATO symbol radius — smaller floor than before so a clustered garrison doesn't smear. */
export function dotR(ppm: number): number {
  return Math.max(3, Math.min(9, 0.7 * ppm));
}

const US_ROLE_SPRITE: Record<string, string> = {
  platoon_leader: "squadleader", platoon_sergeant: "squadleader", squad_leader: "squadleader", team_leader: "squadleader",
  rifleman: "rifleman", grenadier: "grenadier", saw_gunner: "saw", auto_rifleman: "saw",
  machinegunner: "machinegunner", marksman: "marksman", sniper: "sniper", medic: "medic",
  rto: "rto", jtac: "jtac", engineer: "engineer", interpreter: "interpreter",
};
const ANA_ROLE_SPRITE: Record<string, string> = {
  platoon_leader: "leader", platoon_sergeant: "leader", squad_leader: "leader", team_leader: "leader",
  machinegunner: "mg", saw_gunner: "mg", auto_rifleman: "mg", rpg_gunner: "rpg",
};
const ACM_ROLE_SPRITE: Record<string, string> = {
  fighter: "fighter", ied_team: "ied", rpg_gunner: "rpg", mg_gunner: "mg",
  marksman_acm: "marksman", spotter: "spotter", commander: "commander",
};
const CIV_ROLE_SPRITE: Record<string, string> = {
  farmer: "farmer", herder: "herder", elder: "elder", child: "child", villager: "villager",
};

/** Resolve a unit (faction+role) to a figure sprite id, with sensible fallbacks. */
function unitSpriteId(faction: Faction, role: Role, suspect: boolean): string | null {
  if (suspect && faction === "insurgent") return "acm-suspected";
  if (role === "interpreter") return "sol-interpreter";
  if (faction === "us") return "sol-us-" + (US_ROLE_SPRITE[role] ?? "rifleman");
  if (faction === "ana") return "sol-ana-" + (ANA_ROLE_SPRITE[role] ?? "rifleman");
  if (faction === "insurgent") return "acm-" + (ACM_ROLE_SPRITE[role] ?? "fighter");
  if (faction === "civilian") {
    // a little variety: some generic villagers render as the covered-civilian sprite
    if ((CIV_ROLE_SPRITE[role] ?? "villager") === "villager") return "civ-villager";
    return "civ-" + CIV_ROLE_SPRITE[role];
  }
  return null;
}

export function drawUnit(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  u: Unit,
  opts: { selected?: boolean; showLabel?: boolean; revealedSuspect?: boolean } = {}
) {
  const [sx, sy] = worldToScreen(cam, u.pos.x, u.pos.y);
  if (sx < -40 || sy < -40 || sx > cam.vw + 40 || sy > cam.vh + 40) return;
  const color = FAC_COLOR[u.faction] ?? "#aaa";
  const r = dotR(cam.ppm);
  const dead = !u.alive;
  const down = u.alive && !u.conscious;

  // LOD: NATO symbol at low zoom, detailed figure sprite at high zoom (crossfaded).
  // A down (unconscious-but-alive) US soldier renders as a prone casualty body so the
  // "man down" reads as a real silhouette, not an upright man with a cross over him.
  const spriteId =
    down && u.faction === "us" && hasSprite("sol-us-casualty")
      ? "sol-us-casualty"
      : unitSpriteId(u.faction, u.role, !!opts.revealedSuspect);
  const sprA = spriteId && hasSprite(spriteId) ? lodAlpha(cam.ppm, FIG_FADE0, FIG_FADE1) : 0;
  const symA = 1 - sprA;

  ctx.save();
  ctx.translate(sx, sy);

  if (opts.selected) {
    ctx.strokeStyle = "#e0a72b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (dead) {
    // KIA marker — dim cross
    ctx.strokeStyle = u.faction === "us" || u.faction === "ana" ? "rgba(91,155,216,0.5)" : "rgba(160,160,160,0.4)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-r, -r);
    ctx.lineTo(r, r);
    ctx.moveTo(r, -r);
    ctx.lineTo(-r, r);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // --- NATO symbol (fades OUT as we zoom in toward the figure sprite) ---
  if (symA > 0.02) {
    ctx.save();
    ctx.globalAlpha *= symA;
    // facing wedge (where they're oriented)
    if (u.faction !== "civilian") {
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath();
      ctx.moveTo(0, 0);
      const fa = u.facing;
      ctx.arc(0, 0, r * 2.4, fa - 0.38, fa + 0.38);
      ctx.closePath();
      ctx.fill();
    }
    // body symbol
    ctx.lineWidth = 1.4;
    if (u.faction === "us" || u.faction === "ana") {
      // friendly: filled rounded rectangle (rectangle = friendly per mil symbology)
      ctx.fillStyle = down ? "#34506b" : color;
      ctx.strokeStyle = "#0c0d0a";
      roundRect(ctx, -r, -r * 0.8, r * 2, r * 1.6, 2);
      ctx.fill();
      ctx.stroke();
    } else if (u.faction === "insurgent") {
      // hostile: diamond
      ctx.fillStyle = opts.revealedSuspect ? "rgba(208,71,58,0.4)" : color;
      ctx.strokeStyle = "#0c0d0a";
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      // civilian: small ring
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // --- detailed figure sprite (fades IN as we zoom in), rotated to facing ---
  if (sprA > 0.02 && spriteId) {
    const fpx = figurePx(cam.ppm);
    // contact-AO grounding: a soft squashed pool under the boots so a man/casualty SITS on the
    // resolving terrain instead of floating as a decal. Sun-independent (the long cast shadow
    // collapses at noon). Lighter than a building's, and we keep the figure itself UNTINTED so
    // faction colour + silhouette stay crisp below the grade seam (legibility law).
    if (cam.ppm > 2.6) {
      ctx.save();
      ctx.globalAlpha *= sprA * 0.5;
      const ar = fpx * 0.52;
      const ag = ctx.createRadialGradient(0, fpx * 0.18, 0, 0, fpx * 0.18, ar);
      ag.addColorStop(0, "rgba(12,10,7,0.42)");
      ag.addColorStop(0.6, "rgba(12,10,7,0.26)");
      ag.addColorStop(1, "rgba(12,10,7,0)");
      ctx.fillStyle = ag;
      ctx.beginPath();
      ctx.ellipse(0, fpx * 0.18, ar, ar * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    // faction base ring under the figure: keeps US/ANA/ACM/civ legible at any size,
    // since the painted shoulder patch drops below a pixel once the sprite is small.
    const fr = fpx * 0.46;
    ctx.save();
    ctx.globalAlpha *= sprA * 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, fr, fr * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawScreenSprite(ctx, spriteId, 0, 0, fpx, { rot: u.facing, alpha: sprA });
  }

  // suppression / down indicator
  if (u.suppression > 0.25 && !down) {
    ctx.strokeStyle = `rgba(224,167,43,${0.3 + u.suppression * 0.5})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r + 2.5, 0, Math.PI * 2 * u.suppression);
    ctx.stroke();
  }
  if (down) {
    ctx.fillStyle = "#9c2c20";
    ctx.font = `bold ${Math.round(r * 1.1)}px var(--font-mono, monospace)`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("✚", 0, 0);
  }

  // health bar for friendlies (and revealed wounded enemies)
  if ((u.faction === "us" || u.faction === "ana") && cam.ppm > 3) {
    const w = r * 2.2;
    const hpFrac = Math.max(0, u.hp / 100);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(-w / 2, -r - 6, w, 3);
    ctx.fillStyle = hpFrac > 0.5 ? "#6fae54" : hpFrac > 0.25 ? "#e0a72b" : "#c0392b";
    ctx.fillRect(-w / 2, -r - 6, w * hpFrac, 3);
  }

  ctx.restore();

  // label — only the SELECTED unit and squad/team leaders get a nameplate, so dense
  // garrison clusters don't smear into illegible mush. A dark plate keeps it readable.
  const isLeader = u.role === "squad_leader" || u.role === "team_leader" || u.role === "platoon_leader" || u.role === "platoon_sergeant";
  if (opts.showLabel && (u.faction === "us" || u.faction === "ana") && cam.ppm > 2.5 && (opts.selected || isLeader)) {
    ctx.save();
    const name = u.name.split(" ").pop() ?? "";
    ctx.font = "9px var(--font-mono, monospace)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(name).width;
    const ly = sy + figurePx(cam.ppm) * 0.5 + 8;
    ctx.fillStyle = "rgba(12,13,10,0.7)";
    roundRect(ctx, sx - tw / 2 - 3, ly - 6, tw + 6, 12, 2);
    ctx.fill();
    ctx.fillStyle = opts.selected ? "#f0e4c0" : "rgba(216,214,196,0.85)";
    ctx.fillText(name, sx, ly);
    ctx.restore();
  }
}

/**
 * One NATO unit symbol for a whole squad/element at its centroid — drawn BELOW tactical
 * zoom (cam.ppm < FIG_FADE0) IN PLACE OF the 9 individual men, so a zoomed-out COP reads as
 * a handful of unit icons instead of a swarm of oversized dots. This generalizes the
 * existing garrison-hide LOD instinct in WorldView: at operational zoom you track UNITS, not
 * individuals (NATO APP-6 / MIL-STD-2525 convention).
 *
 * A friendly element = a rectangle (filled, dark keyline) with the squad-echelon tick (a
 * single centered dot = squad) and a small count + name label. Crossfades OUT (alpha) as the
 * individual figures crossfade IN above FIG_FADE0, so the dot→icon→figure progression is
 * smooth and nothing pops.
 */
export function drawSquadIcon(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  centroid: { x: number; y: number },
  opts: { count: number; label: string; faction: Faction; selected?: boolean; alpha?: number; engaged?: boolean }
) {
  const [sx, sy] = worldToScreen(cam, centroid.x, centroid.y);
  if (sx < -60 || sy < -40 || sx > cam.vw + 60 || sy > cam.vh + 40) return;
  const a = opts.alpha ?? 1;
  if (a <= 0.02) return;
  const color = FAC_COLOR[opts.faction] ?? "#5b9bd8";
  // a fixed-size screen glyph — a unit symbol does NOT scale with the ground footprint
  const hw = 11, hh = 7; // half-width / half-height of the rectangle
  ctx.save();
  ctx.globalAlpha *= a;
  ctx.translate(sx, sy);

  if (opts.selected) {
    ctx.strokeStyle = "#e0a72b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, hw + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // body rectangle (rectangle = friendly per mil symbology)
  ctx.fillStyle = color;
  ctx.strokeStyle = "#0c0d0a";
  ctx.lineWidth = 1.4;
  roundRect(ctx, -hw, -hh, hw * 2, hh * 2, 2);
  ctx.fill();
  ctx.stroke();
  // echelon tick: a single dot above the rectangle = squad
  ctx.fillStyle = "#e8e5d4";
  ctx.beginPath();
  ctx.arc(0, -hh - 4, 1.6, 0, Math.PI * 2);
  ctx.fill();
  // a contact tint so an engaged element stands out on the sheet
  if (opts.engaged) {
    ctx.strokeStyle = "rgba(224,80,40,0.9)";
    ctx.lineWidth = 1.4;
    roundRect(ctx, -hw - 2, -hh - 2, (hw + 2) * 2, (hh + 2) * 2, 3);
    ctx.stroke();
  }

  // label + strength under the icon (e.g. "1st ×9") — only once the icons aren't tiny
  if (cam.ppm > 0.42) {
    const txt = `${opts.label} ×${opts.count}`;
    ctx.font = "bold 8px var(--font-mono, monospace)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(txt).width;
    ctx.fillStyle = "rgba(12,13,10,0.7)";
    roundRect(ctx, -tw / 2 - 3, hh + 3, tw + 6, 11, 2);
    ctx.fill();
    ctx.fillStyle = opts.selected ? "#f0e4c0" : "rgba(216,214,196,0.9)";
    ctx.fillText(txt, 0, hh + 9);
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const COP_LABEL: Record<string, string> = {
  barracks: "BKS",
  toc: "TOC",
  dfac: "DFAC",
  armory: "ARM",
  aid: "AID",
  motorpool: "MOTOR",
  latrine: "WC",
  tower: "TWR",
};

const BLD_SPRITE: Record<string, string> = {
  toc: "bld-toc", barracks: "bld-barracks", dfac: "bld-dfac", armory: "bld-armory",
  aid: "bld-aid", motorpool: "bld-motorpool", latrine: "bld-latrine", tower: "guard-tower",
};

/** Per-crew-served stroke colour for the sector-of-fire fan (recognition cue, not a panel). */
const WEAPON_TINT: Record<string, string> = {
  m2: "rgba(224,167,43,0.85)", // .50 cal — amber
  m240: "rgba(120,170,235,0.85)", // M240 — blue
  mk19: "rgba(120,210,140,0.85)", // Mk19 AGL — green
  rifle: "rgba(150,160,175,0.4)",
};
const WEAPON_LABEL: Record<string, string> = { m2: "M2", m240: "240", mk19: "Mk19", rifle: "" };

/**
 * Render-only environment for the COP: the diurnal/weather darkness, the prevailing wind
 * vector (for animated atmosphere), and a wall-clock phase. NEVER feeds back into lib/sim —
 * it is a pure view struct, mirroring drawWeather's. Optional so headless callers still work.
 */
export interface CopEnv {
  night: number; // 0 (full day) .. 1 (fully dark)
  windX: number;
  windY: number;
  tNow: number; // wall-clock seconds (render-only animation phase)
  sunShadow?: { dx: number; dy: number; lengthPerM: number; alpha: number }; // SkyState.spriteShadow
  light?: SpriteLight; // per-frame directional form-light (issue 028) — undefined on the 2D fallback
}
const DEFAULT_ENV: CopEnv = { night: 0, windX: 0, windY: 0, tNow: 0 };

/**
 * Draw the combat outpost over the baked terrain: the HESCO bastion wall, building
 * sprites, the helicopter LZ pad, the ECP gate, the comms mast, the mortar pit, the
 * crew-served fighting positions with their interlocking sectors of fire, the flag, a
 * couple of vehicles in the motor pool, and — at night — the warm life-signs that make
 * the COP the one human place in a dark valley. Sprites fade in at operational zoom; a
 * wireframe fallback covers the case where an asset hasn't loaded.
 */
export function drawCop(ctx: CanvasRenderingContext2D, cam: Camera, terrain: Terrain, env: CopEnv = DEFAULT_ENV) {
  const cop = terrain.cop;
  if (!cop) return;
  const cs = terrain.cellSize;
  const bldA = lodAlpha(cam.ppm, 0.32, 0.7);
  const center = terrain.cellCenter(cop.center.cx, cop.center.cy);
  const ga = Math.atan2(cop.gateDir.y, cop.gateDir.x);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // ---- HESCO bastion wall: real gabion segments around the perimeter ring (under everything).
  // The wire was only a tan terrain tint (topo.ts) — drawing hesco-straight tangent to the same
  // ring buildCop bakes gives the COP its defining fortified silhouette. Skips the gate gap.
  if (bldA > 0.04) {
    const ringR = cop.radius * cs;
    const segLen = 11; // m per gabion segment
    const segCount = Math.max(16, Math.round((2 * Math.PI * ringR) / segLen));
    for (let i = 0; i < segCount; i++) {
      const a = (i / segCount) * Math.PI * 2;
      const d = Math.abs(((a - ga + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (d < 0.42) continue; // leave the ECP gate clear
      const wx = center.x + Math.cos(a) * ringR;
      const wy = center.y + Math.sin(a) * ringR;
      const drew = hasSprite("hesco-straight") &&
        drawWorldSprite(ctx, cam, "hesco-straight", wx, wy, { widthM: segLen + 1.5, alpha: bldA, rot: a + Math.PI / 2, light: env.light });
      if (!drew) {
        const [sx, sy] = worldToScreen(cam, wx, wy);
        const half = (segLen / 2) * cs * cam.ppm * 0.18;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a + Math.PI / 2);
        ctx.fillStyle = "rgba(150,138,96,0.85)";
        ctx.strokeStyle = "rgba(40,38,28,0.7)";
        ctx.lineWidth = 1;
        ctx.fillRect(-half, -2.2, half * 2, 4.4);
        ctx.strokeRect(-half, -2.2, half * 2, 4.4);
        ctx.restore();
      }
    }
  }

  // helicopter LZ pad (under everything else)
  {
    const c = terrain.cellCenter(cop.lz.cx, cop.lz.cy);
    const drew = bldA > 0.02 && hasSprite("lz-pad") && drawWorldSprite(ctx, cam, "lz-pad", c.x, c.y, { widthM: 26, alpha: bldA });
    if (!drew) {
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const r = 2.4 * cs * cam.ppm;
      ctx.strokeStyle = "rgba(232,229,212,0.55)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      if (cam.ppm > 0.8) {
        ctx.fillStyle = "rgba(232,229,212,0.7)";
        ctx.font = `bold ${Math.round(r)}px var(--font-mono, monospace)`;
        ctx.fillText("H", sx, sy + 0.5);
      }
    }
  }

  // ECP gate — oriented along the gate direction
  {
    const c = terrain.cellCenter(cop.gate.cx, cop.gate.cy);
    const ang = Math.atan2(cop.gateDir.y, cop.gateDir.x);
    const drew = bldA > 0.02 && hasSprite("ecp-gate") && drawWorldSprite(ctx, cam, "ecp-gate", c.x, c.y, { widthM: 9, alpha: bldA, rot: ang });
    if (!drew) {
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const r = 1.4 * cs * cam.ppm;
      ctx.strokeStyle = "rgba(224,167,43,0.7)";
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(sx, sy, r, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // ECP serpentine — staggered T-walls (jersey barriers) forming a chicane just outside the
    // gate, so the entry reads as a controlled access point, not an open driveway. Render-only:
    // the terrain apron is untouched (the sim half was cut to protect the proven egress corridor).
    if (bldA > 0.05) {
      const ux = Math.cos(ang), uy = Math.sin(ang); // outward through the gate
      const px = -uy, py = ux; // perpendicular
      for (let i = 0; i < 3; i++) {
        const along = (i + 0.4) * 6;
        const side = (i % 2 === 0 ? 1 : -1) * 3.4; // alternate sides → vehicles must weave
        const bx = c.x + ux * along + px * side;
        const by = c.y + uy * along + py * side;
        const drew = hasSprite("jersey-barrier") &&
          drawWorldSprite(ctx, cam, "jersey-barrier", bx, by, { widthM: 5, alpha: bldA, rot: ang + Math.PI / 2, light: env.light });
        if (!drew) {
          const [sx, sy] = worldToScreen(cam, bx, by);
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(ang + Math.PI / 2);
          ctx.fillStyle = `rgba(122,120,114,${bldA})`;
          ctx.strokeStyle = `rgba(30,30,26,${bldA})`;
          ctx.fillRect(-2.4 * cam.ppm, -0.9 * cam.ppm, 4.8 * cam.ppm, 1.8 * cam.ppm);
          ctx.strokeRect(-2.4 * cam.ppm, -0.9 * cam.ppm, 4.8 * cam.ppm, 1.8 * cam.ppm);
          ctx.restore();
        }
      }
    }
  }

  // buildings
  for (const b of cop.buildings) {
    const c = terrain.cellCenter(b.cx, b.cy);
    const [sx, sy] = worldToScreen(cam, c.x, c.y);
    const wM = (b.hw * 2 + 1) * cs;
    const w = wM * cam.ppm;
    const h = (b.hh * 2 + 1) * cs * cam.ppm;
    if (sx < -w * 2 || sy < -h * 3 || sx > cam.vw + w * 2 || sy > cam.vh + h * 2) continue;
    const id = BLD_SPRITE[b.kind] ?? "bld-bhut";
    const hM = (b.hh * 2 + 1) * cs;
    // contact-AO grounding halo (sun-independent — keeps the building planted at high noon when
    // the long cast shadow vanishes), then the long sun-tracked cast shadow (~3 m tall) that
    // sweeps with the clock so the COP sits IN the light instead of floating on a frozen diorama.
    if (env.light && bldA > 0.04) drawContactAO(ctx, cam, c.x, c.y, Math.max(wM, hM) * 1.05, 1, bldA);
    if (env.sunShadow && bldA > 0.02) drawSunShadow(ctx, cam, c.x, c.y, 3, wM, env.sunShadow);
    // stretch each building to its REAL footprint (width × depth) so the COP has size
    // variety instead of every roof reading as the same elongated barracks shape.
    const drew = bldA > 0.02 && hasSprite(id) && drawWorldSprite(ctx, cam, id, c.x, c.y, { widthM: wM * 1.12, heightM: hM * 1.32, alpha: bldA, light: env.light });
    if (!drew) {
      ctx.strokeStyle = "rgba(18,20,16,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(sx - w / 2, sy - h / 2, w, h);
    }
    // faint identifying label only in a mid-zoom band (fades out when detail is obvious)
    if (cam.ppm > 0.95 && cam.ppm < 3.2 && COP_LABEL[b.kind]) {
      ctx.fillStyle = "rgba(232,229,212,0.5)";
      ctx.font = "8px var(--font-mono, monospace)";
      ctx.fillText(COP_LABEL[b.kind], sx, sy + h / 2 + 6);
    }
  }

  // vehicles parked in a row on the motor-pool hardstand
  const motor = cop.buildings.find((b) => b.kind === "motorpool");
  if (motor && bldA > 0.4) {
    const mc = terrain.cellCenter(motor.cx, motor.cy);
    const wM = (motor.hw * 2 + 1) * cs;
    const types: [string, number][] = [["veh-mrap", 6], ["veh-hmmwv", 5], ["veh-mrap", 6], ["veh-pickup", 5]];
    const nv = Math.max(2, Math.min(4, Math.floor(wM / 7)));
    const yard = mc.y + (motor.hh + 1) * cs * 0.6;
    for (let i = 0; i < nv; i++) {
      const fx = nv > 1 ? (i / (nv - 1) - 0.5) * (wM - 6) : 0;
      const [id, sz] = types[i];
      const vx = mc.x + fx, vy = yard + (i % 2 ? 1.5 : -0.5);
      // parked nose-toward-the-wall (north), slight heading scatter so it isn't a decal row
      if (env.light) drawContactAO(ctx, cam, vx, vy, sz * 0.9, 0.85, bldA);
      drawWorldSprite(ctx, cam, id, vx, vy, { widthM: sz, alpha: bldA, rot: -1.57 + (i % 2 ? 0.08 : -0.06), light: env.light });
    }
  }

  // crew-served sectors of fire — a faint interlocking fan per position, colour-coded by
  // weapon (amber .50 / blue 240 / green Mk19). A recognition cue that the fire plan covers
  // the frontage; only at tactical zoom so it never clutters the operational map.
  const secA = lodAlpha(cam.ppm, 1.0, 1.8);
  if (secA > 0.03) {
    for (const fp of cop.fightingPositions) {
      if (fp.weapon === "rifle") continue;
      const c = terrain.cellCenter(fp.cx, fp.cy);
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const fanM = Math.min(fp.avenueScore, 30) + 12; // a short local wedge hugging the wall
      const rpx = fanM * cam.ppm;
      ctx.save();
      ctx.globalAlpha *= secA;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.arc(sx, sy, rpx, fp.rightLimit, fp.leftLimit);
      ctx.closePath();
      const tint = WEAPON_TINT[fp.weapon] ?? WEAPON_TINT.rifle;
      ctx.fillStyle = tint.replace(/0\.\d+\)/, "0.12)");
      ctx.fill();
      ctx.strokeStyle = tint.replace(/0\.\d+\)/, "0.34)");
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }

  // fighting positions / towers on the wall (static, consistent light)
  for (const fp of cop.fightingPositions) {
    const c = terrain.cellCenter(fp.cx, fp.cy);
    const id = fp.tower ? "guard-tower" : "fighting-position";
    // a guard tower (~3.5 m) throws a long shadow at low sun; the fighting position is low
    if (env.light && bldA > 0.04) drawContactAO(ctx, cam, c.x, c.y, fp.tower ? 4.0 : 3.0, 1, bldA);
    if (env.sunShadow && bldA > 0.02 && fp.tower) drawSunShadow(ctx, cam, c.x, c.y, 3.5, 4.5, env.sunShadow);
    const drew = bldA > 0.02 && hasSprite(id) && drawWorldSprite(ctx, cam, id, c.x, c.y, { widthM: fp.tower ? 4.5 : 3.4, alpha: bldA, light: env.light });
    if (!drew) {
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const s = Math.max(3, 1.1 * cs * cam.ppm * 0.6);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(fp.facing);
      ctx.fillStyle = fp.tower ? "rgba(224,167,43,0.85)" : "rgba(120,150,200,0.8)";
      ctx.strokeStyle = "rgba(12,13,10,0.8)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (fp.tower) ctx.rect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
      else { ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, s * 0.7); ctx.lineTo(-s * 0.7, -s * 0.7); ctx.closePath(); }
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    // crew-served weapon tag at tactical zoom (which gun holds this sector)
    if (secA > 0.2 && WEAPON_LABEL[fp.weapon]) {
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      ctx.fillStyle = WEAPON_TINT[fp.weapon];
      ctx.font = "bold 8px var(--font-mono, monospace)";
      ctx.fillText(WEAPON_LABEL[fp.weapon], sx, sy - 9);
    }
  }

  // mortar pit — the indirect-fire installation (rear defilade). ico-mortar with a
  // sandbag-ring wireframe fallback.
  {
    const mp = terrain.cellCenter(cop.mortarPit.cx, cop.mortarPit.cy);
    const drew = bldA > 0.04 && hasSprite("ico-mortar") && drawWorldSprite(ctx, cam, "ico-mortar", mp.x, mp.y, { widthM: 6, alpha: bldA, light: env.light });
    if (!drew && bldA > 0.04) {
      const [sx, sy] = worldToScreen(cam, mp.x, mp.y);
      const r = Math.max(4, 1.6 * cs * cam.ppm * 0.6);
      ctx.save();
      ctx.strokeStyle = `rgba(150,138,96,${bldA})`;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  // comms / SATCOM antenna mast by the TOC — the silhouette that says "manned outpost".
  {
    const toc = cop.buildings.find((b) => b.kind === "toc");
    if (toc && bldA > 0.04) {
      const tc = terrain.cellCenter(toc.cx, toc.cy);
      const mx = tc.x + (toc.hw + 1.2) * cs;
      const drew = hasSprite("antenna-array") && drawWorldSprite(ctx, cam, "antenna-array", mx, tc.y, { widthM: 5, alpha: bldA, light: env.light });
      if (!drew) {
        const [sx, sy] = worldToScreen(cam, mx, tc.y);
        const h = Math.max(8, 3 * cs * cam.ppm);
        ctx.strokeStyle = `rgba(40,44,40,${bldA})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx, sy - h);
        ctx.stroke();
      }
    }
  }

  // burn-pit / generator smoke — a thin column drifting downwind. A COP always burns its trash
  // and runs a generator; the plume is advected along the prevailing wind and animated off the
  // wall clock. Render-only (env.wind/tNow never re-enter the sim). Rises from the rear (latrines).
  if (bldA > 0.15) {
    const rear = cop.buildings.find((b) => b.kind === "latrine") ?? cop.buildings.find((b) => b.kind === "motorpool");
    if (rear) {
      const bp = terrain.cellCenter(rear.cx, rear.cy);
      const wsp = Math.hypot(env.windX, env.windY);
      const wx = wsp > 0.2 ? env.windX / wsp : 0.3;
      const wy = wsp > 0.2 ? env.windY / wsp : -0.95; // default drift up-valley when calm
      ctx.save();
      for (let i = 0; i < 6; i++) {
        const age = (env.tNow * 0.22 + i / 6) % 1; // 0..1 puff lifecycle
        const drift = age * (16 + wsp * 7);
        const ppx = bp.x + wx * drift + Math.sin(env.tNow * 0.7 + i * 1.7) * 2.2;
        const ppy = bp.y + wy * drift - age * 5;
        const [sx, sy] = worldToScreen(cam, ppx, ppy);
        const rad = (1.4 + age * 5) * cam.ppm;
        const a = (1 - age) * 0.15 * bldA;
        const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
        g.addColorStop(0, `rgba(66,62,56,${a})`);
        g.addColorStop(1, "rgba(66,62,56,0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // the COP flag at the center, streaming downwind (fades in as the pin marker fades out)
  {
    const flagA = lodAlpha(cam.ppm, 1.1, 2.1);
    if (flagA > 0.02 && hasSprite("cop-flag")) {
      const c = terrain.cellCenter(cop.center.cx, cop.center.cy);
      const wsp = Math.hypot(env.windX, env.windY);
      const wang = wsp > 0.4 ? Math.atan2(env.windY, env.windX) : -Math.PI / 2;
      const flutter = Math.sin(env.tNow * 3.2) * 0.06 * Math.min(1, wsp / 3 + 0.35);
      drawWorldSprite(ctx, cam, "cop-flag", c.x, c.y, { widthM: 4, alpha: flagA, rot: wang + flutter });
    }
  }

  // ---- night life-signs: the COP is the one warm, lit, human place in a dark valley.
  // Additive 'lighter' pass, gated on darkness + operational zoom so day frames pay nothing.
  if (env.night > 0.15 && bldA > 0.04) {
    const lit = (env.night - 0.15) / 0.85; // 0 at dusk threshold .. 1 fully dark
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    // warm window glow on the occupied buildings (TOC/aid/dfac brightest — always manned)
    for (const b of cop.buildings) {
      if (b.kind === "latrine" || b.kind === "motorpool") continue;
      const c = terrain.cellCenter(b.cx, b.cy);
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const rad = (b.hw + b.hh + 3.5) * cs * cam.ppm;
      const warm = (b.kind === "toc" || b.kind === "aid" || b.kind === "dfac") ? 0.6 : 0.34;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      g.addColorStop(0, `rgba(255,186,104,${warm * lit * bldA})`);
      g.addColorStop(0.5, `rgba(255,170,90,${0.4 * warm * lit * bldA})`);
      g.addColorStop(1, "rgba(255,170,90,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    // cold floodlight pools over the ECP gate and the LZ pad (security/aviation lighting)
    for (const lp of [cop.gate, cop.lz]) {
      const gc = terrain.cellCenter(lp.cx, lp.cy);
      const [sx, sy] = worldToScreen(cam, gc.x, gc.y);
      const rad = 12 * cs * cam.ppm * 0.5;
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      g.addColorStop(0, `rgba(208,224,255,${0.34 * lit * bldA})`);
      g.addColorStop(1, "rgba(208,224,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    // red tower hazard beacons, slow blink off the wall-clock phase
    for (const fp of cop.fightingPositions) {
      if (!fp.tower) continue;
      const c = terrain.cellCenter(fp.cx, fp.cy);
      const [sx, sy] = worldToScreen(cam, c.x, c.y);
      const blink = 0.55 + 0.45 * Math.sin(env.tNow * 1.6 + fp.cx);
      const rad = Math.max(4, 1.8 * cs * cam.ppm * 0.5);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
      g.addColorStop(0, `rgba(255,70,55,${0.85 * blink * lit * bldA})`);
      g.addColorStop(1, "rgba(255,70,55,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore();
}

export function drawProjectiles(ctx: CanvasRenderingContext2D, cam: Camera, projectiles: Projectile[], frac = 0) {
  for (const p of projectiles) {
    if (p.indirect) {
      // A lobbed round (thrown frag) arcing toward its airburst — read "something is
      // in the air, take cover." Progress is EXACT: age + timeToImpact equals the
      // launch time-of-flight (both update each tick), so the round never jumps.
      const prog = p.age / Math.max(1e-3, p.age + p.timeToImpact);
      if (prog <= 0.02 || prog >= 0.98) continue;
      const gx = p.origin.x + (p.aimpoint.x - p.origin.x) * prog;
      const gy = p.origin.y + (p.aimpoint.y - p.origin.y) * prog;
      const [gsx, gsy] = worldToScreen(cam, gx, gy);
      if (gsx < -20 || gsy < -40 || gsx > cam.vw + 20 || gsy > cam.vh + 20) continue;
      const lift = p.arcHeight * 4 * prog * (1 - prog) * cam.ppm * 0.5; // parabola → px
      const friendly = p.faction === "us" || p.faction === "ana";
      const col = friendly ? "230,210,150" : "210,120,70";
      // ground shadow grounds the lob to a real spot on the map
      ctx.fillStyle = "rgba(28,22,14,0.26)";
      ctx.beginPath();
      ctx.ellipse(gsx, gsy, 2.2, 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
      // faint smoke wisp trailing the round, then the lifted round itself
      const pprev = Math.max(0, prog - 0.09);
      const wx = p.origin.x + (p.aimpoint.x - p.origin.x) * pprev;
      const wy = p.origin.y + (p.aimpoint.y - p.origin.y) * pprev;
      const [wsx, wsy] = worldToScreen(cam, wx, wy);
      const wlift = p.arcHeight * 4 * pprev * (1 - pprev) * cam.ppm * 0.5;
      ctx.strokeStyle = "rgba(182,178,170,0.22)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(wsx, wsy - wlift);
      ctx.lineTo(gsx, gsy - lift);
      ctx.stroke();
      ctx.fillStyle = `rgba(${col},0.95)`;
      ctx.beginPath();
      ctx.arc(gsx, gsy - lift, 1.9, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // direct fire — below strategic zoom these collapse into the combat haze (combat-fx),
    // so skip the per-round draw there (declutter + far fewer draws in a big fight).
    const directFade = lodAlpha(cam.ppm, 0.45, 1.0);
    if (directFade <= 0.03) continue;
    // INTERPOLATED head position (smooth 60 fps sweep, not the teleporting per-tick p.pos)
    const rp = projRenderPos(p, frac);
    const [sx, sy] = worldToScreen(cam, rp.x, rp.y);
    const dirx = p.vel.x;
    const diry = p.vel.y;
    const m = Math.hypot(dirx, diry) || 1;
    const tlen = p.tracer ? 18 : 9;
    const bx = sx - (dirx / m) * tlen;
    const by = sy - (diry / m) * tlen;
    // Friendly tracers burn warm amber; ComBloc (insurgent) tracers burn GREEN — the
    // instantly-recognizable "green coming AT you, red going OUT" read every Korengal account
    // describes (7.62×39/×54R tracer compound). The white-hot head dot stays white for both.
    const col = p.faction === "us" || p.faction === "ana" ? "255,220,120" : "120,235,90";
    // two solid segments (dim tail + bright head) instead of a per-frame createLinearGradient
    // — the gradient allocation was the main 116fps risk at high round counts.
    const headA = (p.tracer ? 0.95 : 0.5) * directFade;
    ctx.lineWidth = p.tracer ? 1.8 : 1;
    ctx.strokeStyle = `rgba(${col},${headA * 0.28})`;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${col},${headA})`;
    ctx.beginPath();
    ctx.moveTo(bx + (sx - bx) * 0.5, by + (sy - by) * 0.5);
    ctx.lineTo(sx, sy);
    ctx.stroke();
    if (p.tracer) {
      ctx.fillStyle = `rgba(255,240,200,${headA})`;
      ctx.beginPath();
      ctx.arc(sx, sy, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function drawEffects(ctx: CanvasRenderingContext2D, cam: Camera, effects: Effect[], frac = 0) {
  for (const e of effects) {
    const [sx, sy] = worldToScreen(cam, e.pos.x, e.pos.y);
    // INTERPOLATED age. e.t is advanced a whole tick at the END of the tick it's born in, so a
    // 0.12 s muzzle flash is already at k=0.83 before any frame samples it → past the k>0.6 draw
    // cutoff → INVISIBLE (0/453 flashes ever rendered in the probe). Rendering one tick behind —
    // k = (e.t - (1-frac)·dt)/ttl — lands the flash at k≈0 when fresh and fades it smoothly across
    // its whole on-screen life, killing the strobe for EVERY effect from this one line.
    const k = Math.max(0, (e.t - SIM_TICK * (1 - frac)) / e.ttl); // 0..1 age
    switch (e.kind) {
      case "muzzle": {
        // a punchy flash. TTL is tiny (0.12s) so a burst strobes and reads as rate of
        // fire; a SAW/MG (size 1.6) flashes bigger. If the shooter's facing is known we
        // draw a forward flash CONE along the gun line (so you see WHICH WAY he's firing);
        // otherwise a symmetric flare-star.
        if (k > 0.6 || cam.ppm < 0.45) break; // ppm<0.45 → aggregated into the combat haze
        const f = 1 - k / 0.6;
        const s = (e.size ?? 1) * (3.6 + cam.ppm * 0.7);
        if (e.facing != null) {
          ctx.save();
          ctx.translate(sx, sy);
          ctx.rotate(e.facing);
          const L = s * 2.1;
          const grad = ctx.createLinearGradient(0, 0, L, 0);
          grad.addColorStop(0, `rgba(255,240,205,${0.95 * f})`);
          grad.addColorStop(0.5, `rgba(255,206,110,${0.7 * f})`);
          grad.addColorStop(1, "rgba(255,150,60,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(-s * 0.3, 0);
          ctx.lineTo(0, -s * 0.42);
          ctx.lineTo(L, 0);
          ctx.lineTo(0, s * 0.42);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = `rgba(255,244,214,${0.95 * f})`;
          ctx.beginPath();
          ctx.arc(0, 0, s * 0.34, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = `rgba(255,238,200,${0.95 * f})`;
          ctx.beginPath();
          ctx.arc(sx, sy, s * 0.42, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = `rgba(255,204,108,${0.8 * f})`;
          star(ctx, sx, sy, s, 4);
        }
        break;
      }
      case "impact": {
        // a warm-tan dust kick + a few spall flecks (deterministic from id, so they
        // don't crawl frame to frame) — reads as "a round struck the dirt here."
        if (cam.ppm < 0.45) break; // aggregated into the combat haze at strategic zoom
        const f = 1 - k;
        const s = (2.2 + cam.ppm * 0.6) * (0.6 + k * 0.9);
        ctx.fillStyle = `rgba(156,141,99,${0.5 * f})`;
        ctx.beginPath();
        ctx.arc(sx, sy, s, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(120,108,84,${0.5 * f})`;
        for (let i = 0; i < 3; i++) {
          const a = e.id * 2.4 + i * 2.1;
          const d = s * (0.9 + i * 0.55) * (0.5 + k);
          ctx.fillRect(sx + Math.cos(a) * d - 0.6, sy + Math.sin(a) * d - 0.6, 1.3, 1.3);
        }
        break;
      }
      case "ricochet": {
        ctx.strokeStyle = `rgba(255,200,120,${0.7 * (1 - k)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(sx, sy, 2 + k * 6, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "blast": {
        // GROUND HE (mortar/IED/RPG). Layered per the bible: white-hot flash → a warm,
        // DIRTY fireball pulled into the dust palette (not the old too-hot orange) → a
        // tan dust dome rolling out past it → a dark frag/smoke rim. Scaled to the round's
        // TRUE beaten radius (size encodes radius/8, so size*8 = metres).
        const R = (e.size ?? 1) * 8 * cam.ppm;
        const f = 1 - k;
        if (k < 0.22) {
          const cf = 1 - k / 0.22;
          ctx.fillStyle = `rgba(255,242,214,${0.95 * cf})`;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(3, R * 0.5 * (0.5 + k)), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = `rgba(201,112,54,${0.55 * f})`; // dirty fireball
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(4, R * (0.35 + k * 0.7)), 0, Math.PI * 2);
        ctx.fill();
        const dome = Math.max(6, R * (0.7 + k * 1.1));
        ctx.fillStyle = `rgba(156,141,99,${0.4 * f})`; // tan dust dome
        ctx.beginPath();
        ctx.arc(sx, sy, dome, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(34,26,18,${0.5 * f})`; // smoke rim
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, dome * 1.04, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "frag_air": {
        // AIRBURST (thrown frag / GL). Tighter, brighter, cleaner than ground HE: a quick
        // flash and a fast thin frag ring with only light dust.
        const f = 1 - k;
        const s = (e.size ?? 1) * cam.ppm * 8;
        if (k < 0.3) {
          const cf = 1 - k / 0.3;
          ctx.fillStyle = `rgba(255,236,180,${0.9 * cf})`;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(3, s * 0.4), 0, Math.PI * 2);
          ctx.fill();
        }
        const ring = Math.max(4, s * (0.3 + k * 1.0));
        ctx.fillStyle = `rgba(156,141,99,${0.22 * f})`;
        ctx.beginPath();
        ctx.arc(sx, sy, ring * 0.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,214,150,${0.7 * f})`;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(sx, sy, ring, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "blood": {
        // a small dark-red spatter — a soft center + a few flecks, all capped & deterministic
        if (cam.ppm < 0.45) break; // aggregated into the combat haze at strategic zoom
        const f = 1 - k;
        ctx.fillStyle = `rgba(124,28,22,${0.6 * f})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5 + cam.ppm * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(110,24,18,${0.5 * f})`;
        for (let i = 0; i < 3; i++) {
          const a = e.id * 1.7 + i * 2.3;
          const d = (3 + cam.ppm) * (0.4 + k);
          ctx.fillRect(sx + Math.cos(a) * d - 0.55, sy + Math.sin(a) * d - 0.55, 1.1, 1.1);
        }
        break;
      }
      case "smoke_pop": {
        ctx.fillStyle = `rgba(176,172,162,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 6 + k * 20, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, points: number) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const ang = (i / (points * 2)) * Math.PI * 2;
    const rad = i % 2 === 0 ? r : r * 0.4;
    ctx.lineTo(x + Math.cos(ang) * rad, y + Math.sin(ang) * rad);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * Smoke screens, now WIND-AWARE. The sim owns the screen's position/radius/density (and its
 * LOS effect); this is the purely-visual drift: each disc's painted center is nudged
 * DOWNWIND and the gradient is stretched into an ellipse along the wind axis, so a screen
 * visibly leans the way the wind is blowing instead of sitting as a static radial puff.
 * `wind` is the live sim wind vector (m/s). We never mutate sim.smoke — this is render-only.
 */
export function drawSmoke(ctx: CanvasRenderingContext2D, cam: Camera, smoke: SmokeScreen[], wind: { x: number; y: number } = { x: 0, y: 0 }) {
  const wmag = Math.hypot(wind.x, wind.y);
  const wux = wmag > 1e-3 ? wind.x / wmag : 0;
  const wuy = wmag > 1e-3 ? wind.y / wmag : 0;
  for (const s of smoke) {
    const R = s.radius * cam.ppm;
    // bounded downwind drift of the painted center: ~min(0.4·radius, wind·k) in metres → px.
    const driftM = Math.min(s.radius * 0.4, wmag * 3.5);
    const cxw = s.x + wux * driftM;
    const cyw = s.y + wuy * driftM;
    const [sx, sy] = worldToScreen(cam, cxw, cyw);
    if (wmag < 0.4) {
      // calm air: the original symmetric radial puff
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
      grad.addColorStop(0, `rgba(190,190,185,${s.density})`);
      grad.addColorStop(1, "rgba(190,190,185,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    // windy: an elliptical puff stretched along the wind axis (a downwind tail). We draw in
    // a rotated frame so the gradient + ellipse share one wind-aligned axis.
    const ang = Math.atan2(wuy, wux);
    const stretch = 1 + Math.min(0.9, wmag * 0.12); // longer tail in stronger wind
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(ang);
    // offset the gradient origin slightly UPWIND so the dense head sits at the source and
    // the thin tail trails off downwind.
    const headOff = -R * 0.18 * stretch;
    const grad = ctx.createRadialGradient(headOff, 0, 0, 0, 0, R * stretch);
    grad.addColorStop(0, `rgba(190,190,185,${s.density})`);
    grad.addColorStop(0.55, `rgba(190,190,185,${(s.density * 0.5).toFixed(3)})`);
    grad.addColorStop(1, "rgba(190,190,185,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(0, 0, R * stretch, R / Math.sqrt(stretch), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Engagement / LOS lines from a unit to its perceived enemies. */
export function drawLOSLines(ctx: CanvasRenderingContext2D, cam: Camera, u: Unit, enemies: Unit[]) {
  const [sx, sy] = worldToScreen(cam, u.pos.x, u.pos.y);
  ctx.save();
  ctx.lineWidth = 1;
  for (const e of enemies) {
    const [ex, ey] = worldToScreen(cam, e.pos.x, e.pos.y);
    ctx.strokeStyle = u.targetId === e.id ? "rgba(224,80,40,0.6)" : "rgba(224,167,43,0.22)";
    ctx.setLineDash(u.targetId === e.id ? [] : [3, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

export function drawPath(ctx: CanvasRenderingContext2D, cam: Camera, u: Unit) {
  if (u.path.length === 0) return;
  const [sx, sy] = worldToScreen(cam, u.pos.x, u.pos.y);
  ctx.save();
  ctx.strokeStyle = "rgba(224,167,43,0.5)";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  for (const p of u.path) {
    const [px, py] = worldToScreen(cam, p.x, p.y);
    ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // destination diamond
  const last = u.path[u.path.length - 1];
  const [lx, ly] = worldToScreen(cam, last.x, last.y);
  ctx.fillStyle = "rgba(224,167,43,0.8)";
  ctx.beginPath();
  ctx.moveTo(lx, ly - 4);
  ctx.lineTo(lx + 4, ly);
  ctx.lineTo(lx, ly + 4);
  ctx.lineTo(lx - 4, ly);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
