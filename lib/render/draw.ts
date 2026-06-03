import { Camera, worldToScreen } from "./topo";
import { Unit } from "../sim/entities";
import { Terrain } from "../sim/terrain";
import { Projectile } from "../sim/ballistics";
import { Effect } from "../sim/combat";
import { SmokeScreen } from "../sim/los";

const FAC_COLOR: Record<string, string> = {
  us: "#5b9bd8",
  ana: "#6fae9f",
  insurgent: "#d0473a",
  civilian: "#e3c44a",
};

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

  // label
  if (opts.showLabel && (u.faction === "us" || u.faction === "ana") && cam.ppm > 5) {
    ctx.save();
    ctx.fillStyle = "rgba(216,214,196,0.85)";
    ctx.font = "9px var(--font-mono, monospace)";
    ctx.textAlign = "center";
    const name = u.name.split(" ").pop() ?? "";
    ctx.fillText(name, sx, sy + r + 12);
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

/**
 * Draw the combat outpost's built structure over the baked terrain: labelled
 * building footprints, the helicopter LZ, the entry-control point, and the
 * crew-served fighting positions/towers on the wall.
 */
export function drawCop(ctx: CanvasRenderingContext2D, cam: Camera, terrain: Terrain) {
  const cop = terrain.cop;
  if (!cop) return;
  const cs = terrain.cellSize;
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // building footprints + labels
  for (const b of cop.buildings) {
    const c = terrain.cellCenter(b.cx, b.cy);
    const [sx, sy] = worldToScreen(cam, c.x, c.y);
    const w = (b.hw * 2 + 1) * cs * cam.ppm;
    const h = (b.hh * 2 + 1) * cs * cam.ppm;
    if (sx < -w || sy < -h || sx > cam.vw + w || sy > cam.vh + h) continue;
    ctx.strokeStyle = "rgba(18,20,16,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(sx - w / 2, sy - h / 2, w, h);
    if (cam.ppm > 1.0) {
      ctx.fillStyle = "rgba(232,229,212,0.82)";
      ctx.font = `${Math.min(11, Math.max(7, Math.round(cam.ppm * 2)))}px var(--font-mono, monospace)`;
      ctx.fillText(COP_LABEL[b.kind] ?? b.kind, sx, sy);
    }
  }

  // helicopter LZ — circle with an H
  {
    const c = terrain.cellCenter(cop.lz.cx, cop.lz.cy);
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

  // fighting positions / towers on the wall (sector chevrons pointing out)
  for (const fp of cop.fightingPositions) {
    const c = terrain.cellCenter(fp.cx, fp.cy);
    const [sx, sy] = worldToScreen(cam, c.x, c.y);
    const s = Math.max(3, 1.1 * cs * cam.ppm * 0.6);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(fp.facing);
    ctx.fillStyle = fp.tower ? "rgba(224,167,43,0.85)" : "rgba(120,150,200,0.8)";
    ctx.strokeStyle = "rgba(12,13,10,0.8)";
    ctx.lineWidth = 1;
    if (fp.tower) {
      ctx.beginPath();
      ctx.rect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(s, 0);
      ctx.lineTo(-s * 0.7, s * 0.7);
      ctx.lineTo(-s * 0.7, -s * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // entry-control point marker
  {
    const c = terrain.cellCenter(cop.gate.cx, cop.gate.cy);
    const [sx, sy] = worldToScreen(cam, c.x, c.y);
    const r = 1.4 * cs * cam.ppm;
    ctx.strokeStyle = "rgba(224,167,43,0.7)";
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(sx, sy, r, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (cam.ppm > 1.0) {
      ctx.fillStyle = "rgba(224,167,43,0.85)";
      ctx.font = "8px var(--font-mono, monospace)";
      ctx.fillText("ECP", sx, sy - r - 6);
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
