/** Cover-discipline tuning harness: isolates "exposed under fire" (a man being shot at
 *  while standing in the open) and the WIA it causes, per SOP. Baseline -> tune -> re-measure. */
import { createWorld } from "../lib/sim/world";
import { SquadSOP, ContactSOP } from "../lib/sim/world/types";

const SEEDS = Number(process.argv[2] ?? 10);
const MIN = Number(process.argv[3] ?? 20);

function run(contact: ContactSOP) {
  let wia=0, kia=0, enemy=0, protSamp=0, protHit=0, exposedHit=0, samp=0;
  for (let s=0;s<SEEDS;s++){
    const w = createWorld(`cov-${contact}-${s}`, 90);
    const cop=w.state.copCell, v=w.terrain.villages[s%w.terrain.villages.length];
    const sq=w.platoon.squads.find(x=>x.id==="sq1")!;
    const ids=[...sq.memberIds];
    const sop: SquadSOP = { movement:"patrol", contact, roe:"tight" };
    const t=w.formPatrol(ids,[{cx:Math.round((cop.cx+v.cx)/2),cy:Math.round((cop.cy+v.cy)/2)},{cx:v.cx,cy:v.cy}],"presence","patrol",sop)!;
    w.state.enemyHeat=0.8; w.state.nextActivityAt=0;
    for (let i=0;i<MIN*600;i++){
      w.tick(0.1);
      const tk=w.state.tasks.find(x=>x.id===t.id); if(!tk) break;
      if (tk.squadState && i%10===0){
        for (const id of ids){ const u=w.sim.unit(id); if(!u||!u.alive||!u.conscious) continue;
          samp++;
          const inCov = w.terrain.coverAt(u.pos.x,u.pos.y)>0.3 || u.stance==="prone";
          protSamp++; if(inCov) protHit++;
          // exposed under fire: open ground, upright, taking effective fire
          if (!inCov && u.suppression>0.2) exposedHit++;
        }
      }
    }
    wia += w.platoon.members.filter(m=>ids.includes(m.id)&&m.alive&&m.wounds.length>0).length;
    kia += w.platoon.members.filter(m=>ids.includes(m.id)&&!m.alive).length;
    enemy += w.platoon.members.filter(m=>ids.includes(m.id)).reduce((a,m)=>a+m.kills,0);
  }
  return { contact, wia:(wia/SEEDS).toFixed(2), kia:(kia/SEEDS).toFixed(2), enemy:(enemy/SEEDS).toFixed(2),
    prot:(100*protHit/Math.max(1,protSamp)).toFixed(0)+"%", exposedUnderFire:(100*exposedHit/Math.max(1,samp)).toFixed(1)+"%" };
}
console.log(`=== COVER DISCIPLINE (${SEEDS} seeds x ${MIN}min, sq1, tight, heat 0.8) ===`);
for (const c of ["hold","assault"] as ContactSOP[]) console.log(JSON.stringify(run(c)));
