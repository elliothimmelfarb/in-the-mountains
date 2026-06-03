import { createWorld } from "../lib/sim/world";
const cs = 5;
for (const seed of ["smoke-test","korengal","survey-7","survey-2","survey-9"]) {
  const w = createWorld(seed, 60);
  const t = w.terrain; const cop = t.cop;
  const copC = t.cellCenter(cop.center.cx, cop.center.cy);
  const wire = cop.radius * cs;
  // nearest village distance
  let nv = Infinity;
  for (const v of t.villages) nv = Math.min(nv, Math.hypot((v.cx-cop.center.cx)*cs,(v.cy-cop.center.cy)*cs));
  // form a patrol to the FARTHEST village to force a real egress + march
  const far = t.villages.slice().sort((a,b)=>Math.hypot(b.cx-cop.center.cx,b.cy-cop.center.cy)-Math.hypot(a.cx-cop.center.cx,a.cy-cop.center.cy))[0];
  const sq = w.platoon.squads.find(s=>s.id==="sq1")!;
  const route=[{cx:Math.round((cop.center.cx+far.cx)/2),cy:Math.round((cop.center.cy+far.cy)/2)},{cx:far.cx,cy:far.cy}];
  w.formPatrol(sq.memberIds, route, "presence", "patrol");
  let leadMaxOut=0, centMaxOut=0;
  const ids=sq.memberIds.slice();
  for(let k=0;k<9000;k++){ // 900s
    w.tick(0.1);
    for(const id of ids){const u=w.sim.unit(id); if(u&&u.alive) leadMaxOut=Math.max(leadMaxOut, Math.hypot(u.pos.x-copC.x,u.pos.y-copC.y));}
    const pc=w.activePatrolCentroid(); if(pc) centMaxOut=Math.max(centMaxOut, Math.hypot(pc.x-copC.x,pc.y-copC.y));
  }
  console.log(seed.padEnd(11), "wire="+Math.round(wire)+"m", "nearVil="+Math.round(nv)+"m", "farVil="+Math.round(Math.hypot((far.cx-cop.center.cx)*cs,(far.cy-cop.center.cy)*cs))+"m",
    "leadMaxOut="+Math.round(leadMaxOut)+"m", leadMaxOut>wire?"EGRESS-OK":"STUCK", "centMaxOut="+Math.round(centMaxOut)+"m");
}
