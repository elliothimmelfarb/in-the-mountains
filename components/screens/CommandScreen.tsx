"use client";
import { useState } from "react";
import { useGame } from "@/state/store";
import TopoMap from "@/components/map/TopoMap";
import { currentPhase, ambientLight, Supplies } from "@/lib/sim/campaign";
import { MISSION_LABEL, MissionType } from "@/lib/sim/patrol";

const PHASE_TIME: Record<string, string> = { Dawn: "0600", Day: "1200", Dusk: "1800", Night: "0000" };
const MISSIONS: MissionType[] = ["presence", "recon", "ambush", "kle", "census", "cordon_search", "overwatch"];

function Bar({ label, value, color = "#6b7a3a", max = 100, suffix = "%" }: { label: string; value: number; color?: string; max?: number; suffix?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono">
      <div className="w-[84px] text-inkdim shrink-0">{label}</div>
      <div className="flex-1 h-2.5 bg-bg border border-line relative overflow-hidden">
        <div className="h-full" style={{ width: pct + "%", background: color }} />
      </div>
      <div className="w-[42px] text-right text-ink">{Math.round(value)}{suffix}</div>
    </div>
  );
}

export default function CommandScreen() {
  const campaign = useGame((s) => s.campaign);
  const terrain = useGame((s) => s.terrain);
  const plan = useGame((s) => s.plan);
  const advance = useGame((s) => s.advance);
  const gotoMenu = useGame((s) => s.gotoMenu);
  const addWaypoint = useGame((s) => s.addWaypoint);
  const popWaypoint = useGame((s) => s.popWaypoint);
  const clearRoute = useGame((s) => s.clearRoute);
  useGame((s) => s.tick); // subscribe to refreshes

  const [mode, setMode] = useState<"plan" | "inspect">("plan");
  const [selectedVillage, setSelectedVillage] = useState<string | null>(null);
  const [jacketId, setJacketId] = useState<string | null>(null);

  if (!campaign || !terrain) return null;
  const phase = currentPhase(campaign);
  const m = campaign.metrics;

  return (
    <div className="w-full h-full flex flex-col">
      {/* command bar */}
      <div className="panel border-x-0 border-t-0 flex items-stretch gap-0 h-12 shrink-0">
        <div className="flex items-center px-4 gap-3 border-r border-line">
          <span className="text-amber font-black text-lg tracking-tight">ITM</span>
          <div className="font-mono text-[11px] leading-tight">
            <div className="text-ink">{campaign.fob.name}</div>
            <div className="text-inkdim">{campaign.platoon.callsign} · {campaign.seed}</div>
          </div>
        </div>
        <div className="flex items-center px-4 gap-4 border-r border-line font-mono text-[11px]">
          <div>
            <div className="text-inkdim">DAY</div>
            <div className="text-ink text-base leading-none">{campaign.day}<span className="text-inkdim text-[10px]">/{campaign.totalDays}</span></div>
          </div>
          <div>
            <div className="text-inkdim">{phase.toUpperCase()}</div>
            <div className="text-ink text-base leading-none">{PHASE_TIME[phase]}</div>
          </div>
          <div className={ambientLight(campaign) < 0.2 ? "text-us" : "text-ink"}>
            <div className="text-inkdim">LIGHT</div>
            <div className="leading-none text-base">{ambientLight(campaign) < 0.2 ? "NIGHT" : ambientLight(campaign) < 0.6 ? "LOW" : "DAY"}</div>
          </div>
          <div>
            <div className="text-inkdim">WX</div>
            <div className="text-ink leading-none text-base">{campaign.weather.label}</div>
          </div>
          <div className={campaign.weather.airAvailable ? "text-good" : "text-rust"}>
            <div className="text-inkdim">AIR</div>
            <div className="leading-none text-base">{campaign.weather.airAvailable ? "ON" : "NO-GO"}</div>
          </div>
        </div>
        <div className="flex-1 flex items-center px-4 gap-4">
          <div className="flex-1 grid grid-cols-5 gap-3 max-w-[640px]">
            <Bar label="Stability" value={m.stability} color="#6fae54" />
            <Bar label="Attitudes" value={m.attitude} color="#e0a72b" />
            <Bar label="Enemy" value={m.enemyStrength} color="#c0392b" />
            <Bar label="Comb. Pwr" value={m.combatPower} color="#5b9bd8" />
            <Bar label="Higher" value={m.higherConfidence} color="#c2a878" />
          </div>
        </div>
        <button className="tac-btn rounded-none border-y-0 border-r-0 px-5 active" onClick={() => advance()}>
          Advance ▸<span className="block text-[9px] text-inkdim normal-case">{phase}</span>
        </button>
        <button className="tac-btn rounded-none border-y-0 border-r-0 px-3" onClick={gotoMenu}>
          ☰
        </button>
      </div>

      {/* body */}
      <div className="flex-1 flex min-h-0">
        {/* left: directives + intel + log */}
        <div className="w-[270px] shrink-0 border-r border-line flex flex-col min-h-0">
          <DirectivesPanel />
          <IntelPanel />
          <LogPanel />
        </div>

        {/* center: map */}
        <div className="flex-1 relative min-w-0">
          <TopoMap
            terrain={terrain}
            campaign={campaign}
            plan={plan}
            planning={mode === "plan"}
            selectedVillage={selectedVillage}
            onCellClick={(cx, cy) => {
              if (mode === "plan") addWaypoint(cx, cy);
            }}
            onVillageClick={(id) => {
              setSelectedVillage(id);
              setMode("inspect");
            }}
          />
          {/* map mode toggle */}
          <div className="absolute top-2 left-2 flex gap-1">
            <button className={`tac-btn ${mode === "plan" ? "active" : ""}`} onClick={() => setMode("plan")}>
              ✚ Plan Route
            </button>
            <button className={`tac-btn ${mode === "inspect" ? "active" : ""}`} onClick={() => setMode("inspect")}>
              ⚲ Inspect
            </button>
            {plan.route.length > 0 && (
              <>
                <button className="tac-btn" onClick={popWaypoint}>↶ Undo</button>
                <button className="tac-btn tac-btn-danger" onClick={clearRoute}>Clear</button>
              </>
            )}
          </div>
          <div className="absolute bottom-2 right-2 font-mono text-[10px] text-inkdim bg-bg/70 border border-line px-2 py-1">
            {mode === "plan" ? "click map to add waypoints" : "click a village to engage"}
          </div>
        </div>

        {/* right: plan / village */}
        <div className="w-[320px] shrink-0 border-l border-line flex flex-col min-h-0">
          {mode === "inspect" && selectedVillage ? (
            <VillagePanel villageId={selectedVillage} onClose={() => setMode("plan")} />
          ) : (
            <PlanPanel onInspect={setJacketId} />
          )}
          <SuppliesPanel />
        </div>
      </div>

      <EventModal />
      {jacketId && <SoldierJacket id={jacketId} onClose={() => setJacketId(null)} />}
    </div>
  );
}

// --------------------------------------------------------------------------
function DirectivesPanel() {
  const campaign = useGame((s) => s.campaign)!;
  useGame((s) => s.tick);
  const active = campaign.directives.filter((d) => d.status === "active");
  return (
    <div className="border-b border-line p-2">
      <div className="stencil text-[10px] text-amber mb-1.5">Battalion Directives</div>
      {active.length === 0 && <div className="text-inkdim text-[11px] italic">No active directives.</div>}
      <div className="flex flex-col gap-1.5">
        {active.map((d) => (
          <div key={d.id} className="bg-bg border border-line p-1.5">
            <div className="flex justify-between items-baseline">
              <span className="text-ink text-[11px] font-semibold">{d.title}</span>
              <span className="text-inkdim font-mono text-[9px]">D{d.deadlineDay}</span>
            </div>
            <div className="text-inkdim text-[10px] leading-snug mt-0.5">{d.desc}</div>
            <div className="h-1 bg-panel2 mt-1 border border-line">
              <div className="h-full bg-olive" style={{ width: `${d.progress * 100}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function IntelPanel() {
  const campaign = useGame((s) => s.campaign)!;
  useGame((s) => s.tick);
  return (
    <div className="border-b border-line p-2 flex-1 min-h-0 flex flex-col">
      <div className="stencil text-[10px] text-amber mb-1.5">Intel Feed</div>
      <div className="overflow-y-auto flex-1 flex flex-col gap-1 pr-1">
        {campaign.intel.slice(0, 30).map((r) => (
          <div key={r.id} className="text-[10px] leading-snug border-l-2 pl-1.5" style={{ borderColor: r.source === "SIGINT" ? "#e0a72b" : r.source === "HUMINT" ? "#6fae54" : "#c89c5c" }}>
            <span className="font-mono text-inkdim">[{r.source} ·{Math.round(r.reliability * 100)}%] </span>
            <span className="text-ink">{r.text}</span>
          </div>
        ))}
        {campaign.intel.length === 0 && <div className="text-inkdim italic text-[11px]">No reporting yet. Patrol and talk to people.</div>}
      </div>
    </div>
  );
}

function LogPanel() {
  const campaign = useGame((s) => s.campaign)!;
  useGame((s) => s.tick);
  const recent = campaign.log.slice(-40).reverse();
  return (
    <div className="p-2 h-[160px] flex flex-col">
      <div className="stencil text-[10px] text-amber mb-1.5">Command Log</div>
      <div className="overflow-y-auto flex-1 flex flex-col gap-0.5 pr-1">
        {recent.map((l) => (
          <div key={l.id} className={`text-[10px] leading-snug ${l.kind === "kia" ? "text-rust" : l.kind === "objective" ? "text-amber" : l.kind === "casualty" ? "text-tan" : "text-inkdim"}`}>
            <span className="font-mono opacity-60">D{l.day} </span>
            {l.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlanPanel({ onInspect }: { onInspect: (id: string) => void }) {
  const campaign = useGame((s) => s.campaign)!;
  const plan = useGame((s) => s.plan);
  const setMission = useGame((s) => s.setMission);
  const toggleMember = useGame((s) => s.toggleMember);
  const selectSquad = useGame((s) => s.selectSquad);
  const launchPatrol = useGame((s) => s.launchPatrol);
  useGame((s) => s.tick);

  const ready = (id: string) => {
    const mm = campaign.platoon.members.find((x) => x.id === id);
    return mm && mm.alive && mm.status === "ready";
  };
  const selected = plan.memberIds;
  const hasMedic = selected.some((id) => campaign.platoon.members.find((x) => x.id === id)?.role === "medic");
  const canLaunch = selected.length > 0 && plan.route.length >= 1;

  return (
    <div className="border-b border-line flex flex-col min-h-0 flex-1">
      <div className="p-2 border-b border-line">
        <div className="stencil text-[10px] text-amber mb-1.5">Mission</div>
        <div className="flex flex-wrap gap-1">
          {MISSIONS.map((mt) => (
            <button key={mt} className={`tac-btn text-[10px] px-2 py-1 ${plan.missionType === mt ? "active" : ""}`} onClick={() => setMission(mt)}>
              {MISSION_LABEL[mt]}
            </button>
          ))}
        </div>
      </div>
      <div className="p-2 overflow-y-auto flex-1 min-h-0">
        <div className="flex items-center justify-between mb-1.5">
          <div className="stencil text-[10px] text-amber">Task Organization</div>
          <span className="font-mono text-[10px] text-inkdim">{selected.length} selected</span>
        </div>
        {campaign.platoon.squads.map((sq) => {
          const members = sq.memberIds.map((id) => campaign.platoon.members.find((x) => x.id === id)).filter(Boolean);
          const readyCount = members.filter((mm) => mm && ready(mm.id)).length;
          return (
            <div key={sq.id} className="mb-2">
              <button className="w-full flex justify-between items-center text-[11px] text-ink hover:text-amber py-0.5" onClick={() => selectSquad(sq.id)}>
                <span className="font-semibold">{sq.name}</span>
                <span className="font-mono text-[9px] text-inkdim">{readyCount}/{members.length} ready ▾</span>
              </button>
              <div className="grid grid-cols-1 gap-0.5 mt-0.5">
                {members.map((mm) => {
                  if (!mm) return null;
                  const isReady = ready(mm.id);
                  const sel = selected.includes(mm.id);
                  return (
                    <div
                      key={mm.id}
                      className={`flex items-center gap-1.5 px-1.5 py-1 border text-left text-[10px] ${sel ? "border-amber bg-[#3a4126]" : "border-line bg-bg"} ${!isReady ? "opacity-50" : "hover:border-olive"}`}
                    >
                      <button
                        disabled={!isReady}
                        onClick={() => toggleMember(mm.id)}
                        className={`flex items-center gap-1.5 flex-1 min-w-0 text-left ${!isReady ? "cursor-not-allowed" : "cursor-pointer"}`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${mm.status === "ready" ? "bg-good" : mm.status === "wounded" ? "bg-rust" : mm.status === "kia" ? "bg-[#444]" : "bg-amber"}`} />
                        <span className="font-mono text-inkdim w-9 shrink-0">{mm.rank}</span>
                        <span className="text-ink flex-1 truncate">{mm.name.split(" ").pop()}</span>
                        <span className="text-inkdim font-mono">{roleAbbr(mm.role)}</span>
                      </button>
                      <button title="Service record" onClick={() => onInspect(mm.id)} className="text-inkdim hover:text-amber px-1 shrink-0">ⓘ</button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="p-2 border-t border-line">
        {!hasMedic && selected.length > 0 && (
          <div className="text-rust text-[10px] mb-1 font-mono">⚠ NO MEDIC IN ELEMENT — casualties will bleed.</div>
        )}
        <div className="text-inkdim text-[10px] mb-1 font-mono">
          Waypoints: {plan.route.length} · Mission: {MISSION_LABEL[plan.missionType]}
        </div>
        <button className={`tac-btn w-full ${canLaunch ? "active" : ""}`} disabled={!canLaunch} onClick={launchPatrol}>
          ▸ Step Off
        </button>
      </div>
    </div>
  );
}

function roleAbbr(role: string): string {
  const map: Record<string, string> = {
    platoon_leader: "PL", platoon_sergeant: "PSG", squad_leader: "SL", team_leader: "TL",
    rifleman: "RFL", grenadier: "GRN", saw_gunner: "SAW", machinegunner: "MG", marksman: "DM",
    sniper: "SNP", medic: "DOC", rto: "RTO", jtac: "FO",
  };
  return map[role] ?? role.slice(0, 3).toUpperCase();
}

function VillagePanel({ villageId, onClose }: { villageId: string; onClose: () => void }) {
  const campaign = useGame((s) => s.campaign)!;
  const conductShura = useGame((s) => s.conductShura);
  const fundProject = useGame((s) => s.fundProject);
  useGame((s) => s.tick);
  const v = campaign.villages.find((x) => x.id === villageId);
  if (!v) return null;
  const attColor = v.attitude > 20 ? "#6fae54" : v.attitude < -20 ? "#c0392b" : "#e0a72b";
  const PROJECTS = ["well", "school", "clinic", "road repair", "retaining wall"];
  return (
    <div className="border-b border-line p-2 flex-1 min-h-0 overflow-y-auto">
      <div className="flex justify-between items-center mb-2">
        <div className="stencil text-[11px] text-amber">{v.name}</div>
        <button className="tac-btn text-[10px] px-2 py-0.5" onClick={onClose}>✕</button>
      </div>
      <div className="text-[11px] text-inkdim mb-1 font-mono">Elder: <span className="text-ink">{v.elder}</span></div>
      <div className="text-[11px] text-inkdim mb-2 font-mono">Pop. ~{v.population} · {v.censusDone ? "censused" : "no census"} · last visit {v.lastVisitedDay >= 0 ? "D" + v.lastVisitedDay : "never"}</div>
      <div className="space-y-1.5 mb-3">
        <Bar label="Attitude" value={(v.attitude + 100) / 2} color={attColor} />
        <Bar label="Coop." value={v.cooperation} color="#5b9bd8" />
        <Bar label="ACM Symp." value={v.sympathy} color="#c0392b" />
      </div>
      {v.projects.length > 0 && (
        <div className="text-[10px] text-inkdim mb-2 font-mono">Projects: <span className="text-us">{v.projects.join(", ")}</span></div>
      )}
      <button className="tac-btn w-full mb-2" onClick={() => conductShura(v.id)}>
        ☕ Conduct Shura (KLE) <span className="text-inkdim normal-case">— costs a phase</span>
      </button>
      <div className="stencil text-[10px] text-amber mb-1">CERP Projects <span className="text-inkdim normal-case">(${campaign.cerp.toLocaleString()} available · $5,000 ea)</span></div>
      <div className="flex flex-wrap gap-1">
        {PROJECTS.map((p) => (
          <button key={p} disabled={campaign.cerp < 5000 || v.projects.includes(p)} className="tac-btn text-[10px] px-2 py-1" onClick={() => fundProject(v.id, p)}>
            {v.projects.includes(p) ? "✓ " : "+ "}{p}
          </button>
        ))}
      </div>
    </div>
  );
}

const SUPPLY_ROWS: { key: keyof Supplies; label: string; max: number; warn: number }[] = [
  { key: "ammo_556", label: "5.56mm", max: 20000, warn: 5000 },
  { key: "ammo_762", label: "7.62mm", max: 8000, warn: 2000 },
  { key: "ammo_50", label: ".50 cal", max: 2000, warn: 400 },
  { key: "mortar_60", label: "60mm mtr", max: 120, warn: 20 },
  { key: "mortar_81", label: "81mm mtr", max: 90, warn: 15 },
  { key: "grenades", label: "grenades", max: 120, warn: 20 },
  { key: "medical", label: "med kits", max: 40, warn: 8 },
  { key: "water", label: "water", max: 360, warn: 60 },
  { key: "food", label: "food", max: 360, warn: 60 },
];

function SuppliesPanel() {
  const campaign = useGame((s) => s.campaign)!;
  useGame((s) => s.tick);
  const s = campaign.supplies;
  return (
    <div className="p-2 h-[230px] overflow-y-auto">
      <div className="stencil text-[10px] text-amber mb-1.5">Logistics</div>
      <div className="space-y-1">
        {SUPPLY_ROWS.map((row) => {
          const val = s[row.key];
          const low = val < row.warn;
          return (
            <Bar key={row.key} label={row.label} value={val} max={row.max} suffix="" color={low ? "#c0392b" : "#6b7a3a"} />
          );
        })}
      </div>
      <div className="text-[10px] text-inkdim mt-2 font-mono">CERP funds: <span className="text-amber">${campaign.cerp.toLocaleString()}</span></div>
    </div>
  );
}

function AttrBar({ label, v }: { label: string; v: number }) {
  return (
    <div className="flex items-center gap-2 text-[10px] font-mono">
      <span className="w-[78px] text-inkdim">{label}</span>
      <div className="flex-1 h-1.5 bg-bg border border-line overflow-hidden">
        <div className="h-full bg-olive" style={{ width: Math.round(v * 100) + "%" }} />
      </div>
    </div>
  );
}

function SoldierJacket({ id, onClose }: { id: string; onClose: () => void }) {
  const campaign = useGame((s) => s.campaign)!;
  useGame((s) => s.tick);
  const m = campaign.platoon.members.find((x) => x.id === id);
  if (!m) return null;
  const sq = campaign.platoon.squads.find((s) => s.memberIds.includes(id));
  const statusColor = m.status === "ready" ? "#6fae54" : m.status === "wounded" ? "#c0392b" : m.status === "kia" ? "#777" : "#e0a72b";
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 fade-in" onClick={onClose}>
      <div className="panel w-[460px] max-w-[92vw] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-start mb-1">
          <div>
            <div className="stencil text-[10px] text-amber">Service Record</div>
            <h2 className="text-ink text-xl font-bold leading-tight">
              {m.rank} {m.name}
            </h2>
            {m.nickname && <div className="text-tan text-sm italic">&ldquo;{m.nickname}&rdquo;</div>}
          </div>
          <button className="tac-btn text-[10px] px-2 py-0.5" onClick={onClose}>✕</button>
        </div>
        <div className="flex gap-3 text-[11px] font-mono text-inkdim mb-3 flex-wrap">
          <span>{roleAbbr(m.role)} · <span className="text-ink">{m.role.replace(/_/g, " ")}</span></span>
          <span>{sq?.name ?? "—"}</span>
          <span>{m.homeState}</span>
          <span style={{ color: statusColor }}>● {m.status.toUpperCase()}</span>
        </div>
        <p className="text-inkdim text-[12px] italic border-l-2 border-line pl-3 mb-3">{m.bio}</p>
        <div className="grid grid-cols-2 gap-x-5 gap-y-1 mb-3">
          <AttrBar label="Marksmanship" v={m.marksmanship} />
          <AttrBar label="Composure" v={m.composureMax} />
          <AttrBar label="Leadership" v={m.leadership} />
          <AttrBar label="Medical" v={m.medical} />
          <AttrBar label="Fitness" v={m.fitnessMax} />
          <AttrBar label="Stealth" v={m.stealth} />
          <AttrBar label="Experience" v={m.experience} />
          <AttrBar label="Aggression" v={m.aggression} />
        </div>
        <div className="grid grid-cols-3 gap-2 mb-2 font-mono text-[11px]">
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">REST</div><div className="text-ink">{Math.round(m.rest * 100)}%</div></div>
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">MORALE</div><div className="text-ink">{Math.round(m.morale * 100)}%</div></div>
          <div className="bg-bg border border-line p-2"><div className="text-inkdim text-[9px]">ENEMY KIA</div><div className="text-ink">{m.kills}</div></div>
        </div>
        {m.status === "wounded" && (
          <div className="text-rust text-[11px] font-mono">WIA — est. {Math.ceil(m.daysToRecover)} day(s) to return to duty.{m.wounds.length ? ` Wounds: ${m.wounds.map((w) => w.region).join(", ")}.` : ""}</div>
        )}
        {m.status === "kia" && <div className="text-rust text-[12px]">Killed in action. Rest easy, {m.name.split(" ").pop()}.</div>}
      </div>
    </div>
  );
}

function EventModal() {
  const ev = useGame((s) => s.currentEvent);
  const resolveEvent = useGame((s) => s.resolveEvent);
  if (!ev) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 fade-in">
      <div className="panel w-[520px] max-w-[92vw] p-5">
        <div className="stencil text-amber text-xs mb-1">Situation · {ev.kind}</div>
        <h2 className="text-ink text-xl font-bold mb-2">{ev.title}</h2>
        <p className="text-inkdim text-sm leading-relaxed mb-4">{ev.body}</p>
        <div className="flex flex-col gap-2">
          {ev.choices.map((c) => (
            <button key={c.id} className="tac-btn text-left normal-case w-full py-2" onClick={() => resolveEvent(c.id)}>
              <span className="text-ink">{c.label}</span>
              {c.hint && <span className="block text-[10px] text-inkdim normal-case mt-0.5">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
