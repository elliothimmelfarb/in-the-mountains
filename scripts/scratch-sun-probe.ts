// scratch: gates lib/render/sky.ts against the SACRED gameplay light curve before any GL
// work consumes it. Asserts (a) the geometric sun is below the horizon whenever solarLight()
// sits at the starlight floor, (b) nightFactor ≡ 1 − ambientLight() bit-identically across
// 24 h × 6 weather states, (c) sun vectors are unit and hit the verified anchors (noon due
// south, dawn ENE, dusk WNW), (d) spriteShadow output is sane. Delete after C3 lands.
//   npx tsx scripts/scratch-sun-probe.ts
import { createWorld } from "../lib/sim/world";
import { skyState, sunDirWorld, moonDirWorld } from "../lib/render/sky";
import type { Weather } from "../lib/sim/campaign";

const world = createWorld("sun-probe", 90);
let fails = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) {
    fails++;
    console.log(`FAIL ${name} ${detail}`);
  }
};

const WEATHERS: Weather[] = (
  [
    ["Clear", 3900, 3, 6000, true, false],
    ["Hazy", 2600, 4, 4000, true, false],
    ["Overcast", 2200, 5, 1200, true, false],
    ["Rain", 1500, 7, 700, false, true],
    ["Fog", 600, 1, 300, false, false],
    ["Snow", 900, 5, 500, false, true],
  ] as const
).map(([label, visibilityM, wind, ceiling, airAvailable, precip]) => ({
  label,
  visibilityM,
  wind,
  windDir: 5.3,
  ceiling,
  airAvailable,
  precip,
}));

// ---- (a)+(b): sweep 24 h × 6 weathers at 1-minute resolution --------------------------
let maxIdErr = 0;
for (const wx of WEATHERS) {
  world.state.weather = wx;
  for (let m = 0; m < 1440; m++) {
    world.state.clock = m * 60 - 6 * 3600 + 86400; // day 2, minute m of day
    const sod = world.secondsOfDay;
    const solar = world.solarLight();
    const sky = skyState(sod, wx, solar);

    // (b) the identity — the load-bearing contract
    const night = 1 - world.ambientLight();
    maxIdErr = Math.max(maxIdErr, Math.abs(sky.nightFactor - night));

    // (a) starlight floor ⟹ sun at/below horizon (≤1° tolerance: ramp starts 05:00,
    // geometric sunrise 04:58)
    if (solar <= 0.05001) check("sun-below-at-starlight", sky.sunAltDeg < 1.0, `m=${m} alt=${sky.sunAltDeg.toFixed(2)}`);
    // full daylight plateau ⟹ sun well up
    if (solar >= 0.999 && wx.label === "Clear") check("sun-up-at-full", sky.sunAltDeg > 4, `m=${m} alt=${sky.sunAltDeg.toFixed(2)}`);

    // (c) unit vectors
    const len = Math.hypot(...sky.sunDir);
    check("unit-sun", Math.abs(len - 1) < 1e-9, `m=${m} |dir|=${len}`);

    // (d) spriteShadow sanity
    check("shadow-len", sky.spriteShadow.lengthPerM >= 0.3 && sky.spriteShadow.lengthPerM <= 4.0, `m=${m}`);
    check("shadow-alpha", sky.spriteShadow.alpha >= 0 && sky.spriteShadow.alpha <= 0.34, `m=${m} a=${sky.spriteShadow.alpha}`);
    check("tint-cap", sky.grade.spriteTint.a <= 0.5, `m=${m}`);
  }
}
check("nightFactor-identity", maxIdErr < 1e-12, `maxErr=${maxIdErr}`);

// ---- anchors (verified table, DESIGN.md) ----------------------------------------------
const noon = sunDirWorld(12 * 3600);
check("noon-south", Math.abs(noon[0]) < 1e-9 && noon[1] > 0.2 && noon[1] < 0.28 && noon[2] > 0.96, `(${noon.map((v) => v.toFixed(3)).join(",")})`);
const dawn = sunDirWorld(5.5 * 3600);
check("dawn-ENE", dawn[0] > 0.85 && dawn[1] < 0, `(${dawn.map((v) => v.toFixed(3)).join(",")})`);
const dusk = sunDirWorld(18.93 * 3600);
check("dusk-WNW", dusk[0] < -0.85 && dusk[1] < 0, `(${dusk.map((v) => v.toFixed(3)).join(",")})`);
// geometric sunrise/sunset bracket the gameplay ramps
const riseAlt = sunDirWorld(4.968 * 3600)[2];
const setAlt = sunDirWorld(19.032 * 3600)[2];
check("sunrise-04:58", Math.abs(riseAlt) < 0.005, `sinAlt=${riseAlt.toFixed(4)}`);
check("sunset-19:02", Math.abs(setAlt) < 0.005, `sinAlt=${setAlt.toFixed(4)}`);
// moon: up all night, transit due south at midnight at ~37°
const moonMid = moonDirWorld(0);
check("moon-transit-37S", Math.abs(moonMid[0]) < 1e-9 && moonMid[1] > 0 && Math.abs((Math.asin(moonMid[2]) * 180) / Math.PI - 37.2) < 1, `alt=${((Math.asin(moonMid[2]) * 180) / Math.PI).toFixed(1)}`);
for (let h = 20; h <= 28; h++) {
  const md = moonDirWorld((h % 24) * 3600);
  check("moon-up-all-night", md[2] > 0.05, `h=${h % 24} sinAlt=${md[2].toFixed(3)}`);
}

// ---- key swap: exactly one key body, swap happens while both are ~dark ------------------
world.state.weather = WEATHERS[0];
for (let m = 0; m < 1440; m += 5) {
  world.state.clock = m * 60 - 6 * 3600 + 86400;
  const sky = skyState(world.secondsOfDay, WEATHERS[0], world.solarLight());
  if (!sky.keyIsSun) check("swap-in-dark", sky.sunIntensity < 0.08, `m=${m} sunI=${sky.sunIntensity.toFixed(3)}`);
}

console.log(fails === 0 ? "SUN PROBE OK — identity maxErr " + maxIdErr.toExponential(1) : `SUN PROBE FAILED (${fails})`);
process.exit(fails === 0 ? 0 : 1);
