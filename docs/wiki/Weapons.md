# Weapons

Defined in `lib/sim/weapons.ts` as a `Record<string, Weapon>`. Each entry carries ballistic and
handling stats consumed directly by the model — there are no separate "balance numbers" layered on
top. Key fields:

| Field | Meaning |
|---|---|
| `muzzleVel` | m/s — sets projectile speed and time of flight |
| `effRange` / `maxRange` | accuracy degrades past `effRange`; rounds spend at `maxRange` |
| `dispersionMOA` | mechanical accuracy; combined with shooter state in `dispersionSigmaM` |
| `cyclicRPM` / `burst` | rate of fire and typical burst length |
| `magSize` | rounds before a reload |
| `damage` / `damageType` | base wound severity; `ball`/`frag`/`heat`/`blast` |
| `penetration` | 0..1 fraction of hard cover the round ignores |
| `suppressionRadius` / `suppression` | how far and how hard near-misses pin |
| `indirect` / `minRange` / `blastRadius` | arcing/explosive behavior |
| `opticRange` | how far the operator can acquire targets |
| `backblast` | rockets — dangerous to friendlies behind |

## How stats become behavior

Nothing about "this gun is good at X" is hard-coded as an outcome — it **emerges**:

- **Rifles/carbines** (M4, M16, AKM): deadly inside `effRange`, wasteful beyond it; modest suppression.
- **Squad automatics** (M249, RPK): hit through volume; good suppression radius.
- **GPMGs** (M240, PKM): reach + strong suppression + higher penetration; heavy ammo.
- **HMGs** (M2 .50, DShK): long reach and ~0.9 penetration — they defeat most cover and shred morale.
- **DMR/Sniper** (M110, M24, M107, SVD): tiny MOA, long `aimTime`, slow rate — precision over volume.
- **Grenade launchers / AGL** (M320, Mk19): arcing frag, area effect, blast radius.
- **Rockets/missiles** (AT4, RPG-7, Javelin, SPG-9): high single-shot punch, blast, backblast.
- **Mortars** (60/81/120mm US, 82mm enemy): indirect HE with range bands, delay, and dispersion.

## Catalog

US: `m4 m16 m249 m240 m2 mk19 m320 m110 m24 m107 at4 javelin m9 mortar60 mortar81 mortar120`.
Insurgent: `akm rpk pkm svd enfield rpg7 dshk spg9 mortar82`.

Helpers: `getWeapon(id)`, `US_INFANTRY_WEAPONS`, `INSURGENT_WEAPONS`. See the
[Field Manual §16](../../public/manual/index.html) for the player-facing table.
