/** Weapon systems. Stats feed the per-projectile ballistics model. Values are
 *  game-tuned but grounded in the real systems fielded in the Pech/Korengal c.2011. */

export type WeaponClass =
  | "carbine"
  | "rifle"
  | "lmg" // squad automatic (belt/box, 5.56)
  | "mmg" // medium MG (7.62)
  | "hmg" // heavy MG (.50 / 12.7)
  | "agl" // automatic grenade launcher
  | "gl" // under-barrel / standalone grenade launcher
  | "dmr" // designated marksman
  | "sniper"
  | "rocket" // unguided AT rocket (AT4, RPG)
  | "missile" // guided (Javelin)
  | "mortar"
  | "pistol";

export type DamageType = "ball" | "frag" | "heat" | "blast";

export interface Weapon {
  id: string;
  name: string;
  short: string;
  cls: WeaponClass;
  caliber: string;
  faction: "us" | "insurgent" | "both";
  muzzleVel: number; // m/s
  effRange: number; // effective point/area range (m)
  maxRange: number; // m
  dispersionMOA: number; // mechanical dispersion (minutes of angle)
  cyclicRPM: number; // rounds/min when firing (semi = practical rate)
  magSize: number; // rounds per mag/belt segment carried
  burst: [number, number]; // typical burst length min..max
  auto: boolean; // capable of sustained automatic fire
  damage: number; // base wound severity (0..100 scale)
  damageType: DamageType;
  penetration: number; // 0..1 fraction of cover ignored
  suppressionRadius: number; // m around impact/flight that suppresses
  suppression: number; // suppression power per round
  indirect?: boolean; // lobbed (mortars, GL arc)
  minRange?: number; // for indirect
  blastRadius?: number; // m (explosive)
  reload: number; // seconds to reload
  roundWeight: number; // kg per round (logistics + carry)
  aimTime: number; // seconds to settle a deliberate shot
  backblast?: boolean; // dangerous behind (rockets) — affects positioning
  opticRange: number; // how far this system can spot/acquire (m)
}

export const WEAPONS: Record<string, Weapon> = {
  // ---------------------------------------------------------------- US small arms
  m4: {
    id: "m4", name: "M4A1 Carbine", short: "M4", cls: "carbine", caliber: "5.56×45mm", faction: "us",
    muzzleVel: 880, effRange: 500, maxRange: 3600, dispersionMOA: 4, cyclicRPM: 850, magSize: 30,
    burst: [3, 6], auto: true, damage: 34, damageType: "ball", penetration: 0.35,
    suppressionRadius: 4, suppression: 0.9, reload: 3.2, roundWeight: 0.012, aimTime: 0.8, opticRange: 700,
  },
  m16: {
    id: "m16", name: "M16A4 Rifle", short: "M16", cls: "rifle", caliber: "5.56×45mm", faction: "us",
    muzzleVel: 920, effRange: 550, maxRange: 3600, dispersionMOA: 3.4, cyclicRPM: 800, magSize: 30,
    burst: [3, 3], auto: false, damage: 35, damageType: "ball", penetration: 0.36,
    suppressionRadius: 4, suppression: 0.9, reload: 3.2, roundWeight: 0.012, aimTime: 0.9, opticRange: 750,
  },
  m249: {
    id: "m249", name: "M249 SAW", short: "SAW", cls: "lmg", caliber: "5.56×45mm", faction: "us",
    muzzleVel: 915, effRange: 800, maxRange: 3600, dispersionMOA: 7, cyclicRPM: 850, magSize: 200,
    burst: [6, 12], auto: true, damage: 34, damageType: "ball", penetration: 0.35,
    suppressionRadius: 8, suppression: 1.5, reload: 5.5, roundWeight: 0.012, aimTime: 0.6, opticRange: 800,
  },
  m240: {
    id: "m240", name: "M240B GPMG", short: "240", cls: "mmg", caliber: "7.62×51mm", faction: "us",
    muzzleVel: 853, effRange: 1100, maxRange: 3725, dispersionMOA: 6, cyclicRPM: 750, magSize: 100,
    burst: [6, 10], auto: true, damage: 52, damageType: "ball", penetration: 0.6,
    suppressionRadius: 11, suppression: 2.1, reload: 6.5, roundWeight: 0.024, aimTime: 0.6, opticRange: 1100,
  },
  m2: {
    id: "m2", name: "M2 Browning .50", short: "M2", cls: "hmg", caliber: "12.7×99mm", faction: "us",
    muzzleVel: 890, effRange: 1830, maxRange: 6800, dispersionMOA: 5, cyclicRPM: 550, magSize: 100,
    burst: [5, 9], auto: true, damage: 95, damageType: "ball", penetration: 0.92,
    suppressionRadius: 16, suppression: 3.4, reload: 8, roundWeight: 0.11, aimTime: 0.8, opticRange: 2000,
  },
  mk19: {
    id: "mk19", name: "Mk 19 AGL", short: "Mk19", cls: "agl", caliber: "40×53mm", faction: "us",
    muzzleVel: 240, effRange: 1500, maxRange: 2200, dispersionMOA: 14, cyclicRPM: 360, magSize: 48,
    burst: [3, 6], auto: true, damage: 70, damageType: "frag", penetration: 0.5,
    suppressionRadius: 14, suppression: 2.6, indirect: true, minRange: 75, blastRadius: 9,
    reload: 9, roundWeight: 0.34, aimTime: 1.4, opticRange: 1600,
  },
  m320: {
    id: "m320", name: "M320 Grenade Launcher", short: "203", cls: "gl", caliber: "40×46mm", faction: "us",
    muzzleVel: 76, effRange: 150, maxRange: 400, dispersionMOA: 30, cyclicRPM: 6, magSize: 1,
    burst: [1, 1], auto: false, damage: 62, damageType: "frag", penetration: 0.4,
    suppressionRadius: 9, suppression: 2.2, indirect: true, minRange: 31, blastRadius: 6,
    reload: 4, roundWeight: 0.23, aimTime: 1.8, opticRange: 400,
  },
  m110: {
    id: "m110", name: "M110 SASS", short: "M110", cls: "dmr", caliber: "7.62×51mm", faction: "us",
    muzzleVel: 783, effRange: 800, maxRange: 1200, dispersionMOA: 1.3, cyclicRPM: 30, magSize: 20,
    burst: [1, 1], auto: false, damage: 56, damageType: "ball", penetration: 0.62,
    suppressionRadius: 5, suppression: 1.3, reload: 3.5, roundWeight: 0.024, aimTime: 2.2, opticRange: 1400,
  },
  m24: {
    id: "m24", name: "M24 SWS", short: "M24", cls: "sniper", caliber: "7.62×51mm", faction: "us",
    muzzleVel: 790, effRange: 900, maxRange: 1300, dispersionMOA: 0.8, cyclicRPM: 10, magSize: 5,
    burst: [1, 1], auto: false, damage: 60, damageType: "ball", penetration: 0.62,
    suppressionRadius: 5, suppression: 1.4, reload: 4.5, roundWeight: 0.024, aimTime: 3.2, opticRange: 1600,
  },
  m107: {
    id: "m107", name: "M107 .50 Sniper", short: "M107", cls: "sniper", caliber: "12.7×99mm", faction: "us",
    muzzleVel: 853, effRange: 1800, maxRange: 6800, dispersionMOA: 1.1, cyclicRPM: 10, magSize: 10,
    burst: [1, 1], auto: false, damage: 98, damageType: "ball", penetration: 0.95,
    suppressionRadius: 8, suppression: 2.2, reload: 5, roundWeight: 0.11, aimTime: 3.5, opticRange: 2200,
  },
  at4: {
    id: "at4", name: "AT4 84mm", short: "AT4", cls: "rocket", caliber: "84mm HEAT", faction: "us",
    muzzleVel: 290, effRange: 300, maxRange: 500, dispersionMOA: 18, cyclicRPM: 1, magSize: 1,
    burst: [1, 1], auto: false, damage: 90, damageType: "heat", penetration: 0.9,
    suppressionRadius: 10, suppression: 2.8, blastRadius: 5, backblast: true,
    reload: 99, roundWeight: 6.7, aimTime: 2.4, opticRange: 400,
  },
  javelin: {
    id: "javelin", name: "FGM-148 Javelin", short: "Jav", cls: "missile", caliber: "127mm", faction: "us",
    muzzleVel: 70, effRange: 2500, maxRange: 4750, dispersionMOA: 2, cyclicRPM: 1, magSize: 1,
    burst: [1, 1], auto: false, damage: 100, damageType: "heat", penetration: 0.98,
    suppressionRadius: 12, suppression: 3, blastRadius: 6,
    reload: 99, roundWeight: 11.8, aimTime: 6, opticRange: 4750,
  },
  m9: {
    id: "m9", name: "M9 Pistol", short: "M9", cls: "pistol", caliber: "9×19mm", faction: "us",
    muzzleVel: 381, effRange: 50, maxRange: 1800, dispersionMOA: 12, cyclicRPM: 60, magSize: 15,
    burst: [1, 2], auto: false, damage: 26, damageType: "ball", penetration: 0.18,
    suppressionRadius: 2, suppression: 0.5, reload: 2.6, roundWeight: 0.0085, aimTime: 0.7, opticRange: 60,
  },
  // ---------------------------------------------------------- US indirect / crew
  mortar60: {
    id: "mortar60", name: "M224 60mm Mortar", short: "60mm", cls: "mortar", caliber: "60mm", faction: "us",
    muzzleVel: 170, effRange: 3500, maxRange: 3500, dispersionMOA: 40, cyclicRPM: 20, magSize: 1,
    burst: [1, 1], auto: false, damage: 80, damageType: "frag", penetration: 0.45,
    suppressionRadius: 22, suppression: 3.2, indirect: true, minRange: 70, blastRadius: 15,
    reload: 4, roundWeight: 1.7, aimTime: 0, opticRange: 0,
  },
  mortar81: {
    id: "mortar81", name: "M252 81mm Mortar", short: "81mm", cls: "mortar", caliber: "81mm", faction: "us",
    muzzleVel: 250, effRange: 5600, maxRange: 5600, dispersionMOA: 40, cyclicRPM: 16, magSize: 1,
    burst: [1, 1], auto: false, damage: 92, damageType: "frag", penetration: 0.55,
    suppressionRadius: 30, suppression: 3.8, indirect: true, minRange: 80, blastRadius: 24,
    reload: 5, roundWeight: 4.2, aimTime: 0, opticRange: 0,
  },
  mortar120: {
    id: "mortar120", name: "120mm Mortar", short: "120mm", cls: "mortar", caliber: "120mm", faction: "us",
    muzzleVel: 318, effRange: 7200, maxRange: 7200, dispersionMOA: 40, cyclicRPM: 10, magSize: 1,
    burst: [1, 1], auto: false, damage: 100, damageType: "frag", penetration: 0.65,
    suppressionRadius: 40, suppression: 4.4, indirect: true, minRange: 200, blastRadius: 35,
    reload: 7, roundWeight: 13, aimTime: 0, opticRange: 0,
  },
  // ----------------------------------------------------------- Insurgent arsenal
  akm: {
    id: "akm", name: "AKM", short: "AK", cls: "rifle", caliber: "7.62×39mm", faction: "insurgent",
    muzzleVel: 715, effRange: 350, maxRange: 1500, dispersionMOA: 6, cyclicRPM: 600, magSize: 30,
    burst: [3, 8], auto: true, damage: 42, damageType: "ball", penetration: 0.42,
    suppressionRadius: 5, suppression: 1, reload: 3.6, roundWeight: 0.016, aimTime: 0.9, opticRange: 400,
  },
  rpk: {
    id: "rpk", name: "RPK LMG", short: "RPK", cls: "lmg", caliber: "7.62×39mm", faction: "insurgent",
    muzzleVel: 745, effRange: 600, maxRange: 1500, dispersionMOA: 7, cyclicRPM: 600, magSize: 40,
    burst: [5, 10], auto: true, damage: 42, damageType: "ball", penetration: 0.42,
    suppressionRadius: 8, suppression: 1.6, reload: 4.5, roundWeight: 0.016, aimTime: 0.7, opticRange: 600,
  },
  pkm: {
    id: "pkm", name: "PKM GPMG", short: "PKM", cls: "mmg", caliber: "7.62×54mmR", faction: "insurgent",
    muzzleVel: 825, effRange: 1000, maxRange: 3800, dispersionMOA: 6.5, cyclicRPM: 650, magSize: 100,
    burst: [6, 12], auto: true, damage: 52, damageType: "ball", penetration: 0.6,
    suppressionRadius: 11, suppression: 2.1, reload: 7, roundWeight: 0.022, aimTime: 0.7, opticRange: 1000,
  },
  svd: {
    id: "svd", name: "SVD Dragunov", short: "SVD", cls: "dmr", caliber: "7.62×54mmR", faction: "insurgent",
    muzzleVel: 830, effRange: 800, maxRange: 1300, dispersionMOA: 2.2, cyclicRPM: 30, magSize: 10,
    burst: [1, 1], auto: false, damage: 56, damageType: "ball", penetration: 0.62,
    suppressionRadius: 5, suppression: 1.3, reload: 4, roundWeight: 0.022, aimTime: 2.4, opticRange: 1200,
  },
  enfield: {
    id: "enfield", name: "Lee–Enfield .303", short: "Enfield", cls: "dmr", caliber: ".303 British", faction: "insurgent",
    muzzleVel: 744, effRange: 600, maxRange: 1200, dispersionMOA: 3, cyclicRPM: 15, magSize: 10,
    burst: [1, 1], auto: false, damage: 54, damageType: "ball", penetration: 0.55,
    suppressionRadius: 4, suppression: 1, reload: 5, roundWeight: 0.025, aimTime: 2.6, opticRange: 700,
  },
  rpg7: {
    id: "rpg7", name: "RPG-7", short: "RPG", cls: "rocket", caliber: "85mm HEAT", faction: "insurgent",
    muzzleVel: 115, effRange: 300, maxRange: 920, dispersionMOA: 22, cyclicRPM: 4, magSize: 1,
    burst: [1, 1], auto: false, damage: 85, damageType: "heat", penetration: 0.85,
    suppressionRadius: 12, suppression: 2.9, blastRadius: 5, backblast: true,
    reload: 8, roundWeight: 2.6, aimTime: 2, opticRange: 500,
  },
  dshk: {
    id: "dshk", name: "DShK 12.7mm", short: "DShK", cls: "hmg", caliber: "12.7×108mm", faction: "insurgent",
    muzzleVel: 850, effRange: 1600, maxRange: 6000, dispersionMOA: 6, cyclicRPM: 600, magSize: 50,
    burst: [5, 9], auto: true, damage: 95, damageType: "ball", penetration: 0.9,
    suppressionRadius: 16, suppression: 3.3, reload: 9, roundWeight: 0.13, aimTime: 0.9, opticRange: 1800,
  },
  spg9: {
    id: "spg9", name: "SPG-9 Recoilless", short: "SPG-9", cls: "rocket", caliber: "73mm", faction: "insurgent",
    muzzleVel: 700, effRange: 800, maxRange: 1300, dispersionMOA: 10, cyclicRPM: 4, magSize: 1,
    burst: [1, 1], auto: false, damage: 88, damageType: "heat", penetration: 0.85,
    suppressionRadius: 14, suppression: 3, blastRadius: 8, backblast: true,
    reload: 12, roundWeight: 6.4, aimTime: 2.5, opticRange: 900,
  },
  mortar82: {
    id: "mortar82", name: "82mm Mortar", short: "82mm", cls: "mortar", caliber: "82mm", faction: "insurgent",
    muzzleVel: 211, effRange: 4000, maxRange: 4000, dispersionMOA: 55, cyclicRPM: 12, magSize: 1,
    burst: [1, 1], auto: false, damage: 90, damageType: "frag", penetration: 0.55,
    suppressionRadius: 26, suppression: 3.6, indirect: true, minRange: 85, blastRadius: 22,
    reload: 6, roundWeight: 3.1, aimTime: 0, opticRange: 0,
  },
};

export function getWeapon(id: string): Weapon {
  const w = WEAPONS[id];
  if (!w) throw new Error(`Unknown weapon: ${id}`);
  return w;
}

export const US_INFANTRY_WEAPONS = ["m4", "m16", "m249", "m240", "m110", "m24", "m320", "m9"];
export const INSURGENT_WEAPONS = ["akm", "rpk", "pkm", "svd", "enfield", "rpg7"];
