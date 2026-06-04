import { Camera, worldToScreen } from "./topo";
import { Unit, Faction, Role } from "../sim/entities";
import { Terrain } from "../sim/terrain";
import { Projectile } from "../sim/ballistics";
import { Effect } from "../sim/combat";
import { SmokeScreen } from "../sim/los";
import { drawScreenSprite, drawWorldSprite, hasSprite, lodAlpha } from "./sprites";

const FAC_COLOR: Record<string, string> = {
  us: "#5b9bd8",
  ana: "#6fae9f",
  insurgent: "#d0473a",
  civilian: "#e3c44a",
};

// ---- figure-sprite LOD: symbol below FIG_FADE0, sprite above FIG_FADE1, crossfade between ----
const FIG_FADE0 = 0.5;
const FIG_FADE1 = 0.9;
function figurePx(ppm: number): number {
  return Math.max(15, Math.min(40, ppm * 7));
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

function roleGlyph(role: string): string {
  switch (role) {
    case "saw_gunner":
    case "auto_rifleman":
    case "machinegunner":
    case "mg_gunner":
      return "//"; // automatic weapon
    case "grenadier":
      return "◇";
    case "marksman":
    case "sniper":
    case "marksman_acm":
      return "+";
    case "medic":
      return "✚";
    case "rto":
    case "jtac":
      return "¥";
    case "squad_leader":
    case "team_leader":
    case "platoon_leader":
    case "platoon_sergeant":
    case "commander":
      return "▲";
    case "rpg_gunner":
      return "!";
    default:
      return "";
  }
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
  const r = Math.max(4.5, Math.min(13, 0.95 * cam.ppm));
  const dead = !u.alive;
  const down = u.alive && !u.conscious;

  // LOD: NATO symbol at low zoom, detailed figure sprite at high zoom (crossfaded).
  const spriteId = unitSpriteId(u.faction, u.role, !!opts.revealedSuspect);
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
    // role glyph
    const glyph = roleGlyph(u.role);
    if (glyph && (u.faction === "us" || u.faction === "ana") && cam.ppm > 4) {
      ctx.fillStyle = "#0c0d0a";
      ctx.font = `bold ${Math.round(r)}px var(--font-mono, monospace)`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph, 0, 0.5);
    }
    ctx.restore();
  }

  // --- detailed figure sprite (fades IN as we zoom in), rotated to facing ---
  if (sprA > 0.02 && spriteId) {
    // faction base ring under the figure: keeps US/ANA/ACM/civ legible at any size,
    // since the painted shoulder patch drops below a pixel once the sprite is small.
    const fr = figurePx(cam.ppm) * 0.46;
    ctx.save();
    ctx.globalAlpha *= sprA * 0.5;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(0, 0, fr, fr * 0.92, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawScreenSprite(ctx, spriteId, 0, 0, figurePx(cam.ppm), { rot: u.facing, alpha: sprA });
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

/**
 * Draw the combat outpost over the baked terrain: building sprites, the helicopter
 * LZ pad, the ECP gate, crew-served fighting positions/towers, the flag, and a couple
 * of vehicles in the motor pool. Sprites fade in at operational zoom; a wireframe
 * fallback covers the case where an asset hasn't loaded.
 */
export function drawCop(ctx: CanvasRenderingContext2D, cam: Camera, terrain: Terrain) {
  const cop = terrain.cop;
  if (!cop) return;
  const cs = terrain.cellSize;
  const bldA = lodAlpha(cam.ppm, 0.32, 0.7);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

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
    // stretch each building to its REAL footprint (width × depth) so the COP has size
    // variety instead of every roof reading as the same elongated barracks shape.
    const drew = bldA > 0.02 && hasSprite(id) && drawWorldSprite(ctx, cam, id, c.x, c.y, { widthM: wM * 1.12, heightM: hM * 1.32, alpha: bldA });
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
      // parked nose-toward-the-wall (north), slight heading scatter so it isn't a decal row
      drawWorldSprite(ctx, cam, id, mc.x + fx, yard + (i % 2 ? 1.5 : -0.5), { widthM: sz, alpha: bldA, rot: -1.57 + (i % 2 ? 0.08 : -0.06) });
    }
  }

  // fighting positions / towers on the wall (static, consistent light)
  for (const fp of cop.fightingPositions) {
    const c = terrain.cellCenter(fp.cx, fp.cy);
    const id = fp.tower ? "guard-tower" : "fighting-position";
    const drew = bldA > 0.02 && hasSprite(id) && drawWorldSprite(ctx, cam, id, c.x, c.y, { widthM: fp.tower ? 4.5 : 3.4, alpha: bldA });
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
  }

  // the COP flag at the center (fades in as the pin marker fades out)
  {
    const flagA = lodAlpha(cam.ppm, 1.1, 2.1);
    if (flagA > 0.02 && hasSprite("cop-flag")) {
      const c = terrain.cellCenter(cop.center.cx, cop.center.cy);
      drawWorldSprite(ctx, cam, "cop-flag", c.x, c.y, { widthM: 4, alpha: flagA });
    }
  }

  ctx.restore();
}

export function drawProjectiles(ctx: CanvasRenderingContext2D, cam: Camera, projectiles: Projectile[]) {
  for (const p of projectiles) {
    if (p.indirect) continue;
    const [sx, sy] = worldToScreen(cam, p.pos.x, p.pos.y);
    const dirx = p.vel.x;
    const diry = p.vel.y;
    const m = Math.hypot(dirx, diry) || 1;
    const tlen = p.tracer ? 18 : 9;
    const bx = sx - (dirx / m) * tlen;
    const by = sy - (diry / m) * tlen;
    const grad = ctx.createLinearGradient(bx, by, sx, sy);
    const col = p.faction === "us" || p.faction === "ana" ? "255,220,120" : "255,90,40";
    grad.addColorStop(0, `rgba(${col},0)`);
    grad.addColorStop(1, `rgba(${col},${p.tracer ? 0.95 : 0.5})`);
    ctx.strokeStyle = grad;
    ctx.lineWidth = p.tracer ? 1.8 : 1;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(sx, sy);
    ctx.stroke();
  }
}

export function drawEffects(ctx: CanvasRenderingContext2D, cam: Camera, effects: Effect[]) {
  for (const e of effects) {
    const [sx, sy] = worldToScreen(cam, e.pos.x, e.pos.y);
    const k = e.t / e.ttl; // 0..1 age
    switch (e.kind) {
      case "muzzle": {
        if (k > 0.5) break;
        const s = (e.size ?? 1) * (3 + cam.ppm * 0.6);
        ctx.fillStyle = `rgba(255,228,150,${0.9 * (1 - k * 2)})`;
        star(ctx, sx, sy, s, 4);
        break;
      }
      case "impact": {
        const s = (2 + cam.ppm * 0.5) * (0.6 + k);
        ctx.fillStyle = `rgba(150,140,120,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, s, 0, Math.PI * 2);
        ctx.fill();
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
      case "blast":
      case "frag_air": {
        const R = (e.size ?? 1) * cam.ppm * 8 * (0.2 + k);
        ctx.fillStyle = `rgba(255,180,80,${0.6 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(4, R), 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(60,50,40,${0.5 * (1 - k)})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(4, R * 1.2), 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "blood": {
        ctx.fillStyle = `rgba(120,30,24,${0.6 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 3 + cam.ppm * 0.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "smoke_pop": {
        ctx.fillStyle = `rgba(180,180,180,${0.5 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, 6 + k * 18, 0, Math.PI * 2);
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

export function drawSmoke(ctx: CanvasRenderingContext2D, cam: Camera, smoke: SmokeScreen[]) {
  for (const s of smoke) {
    const [sx, sy] = worldToScreen(cam, s.x, s.y);
    const R = s.radius * cam.ppm;
    const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, R);
    grad.addColorStop(0, `rgba(190,190,185,${s.density})`);
    grad.addColorStop(1, "rgba(190,190,185,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.fill();
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
