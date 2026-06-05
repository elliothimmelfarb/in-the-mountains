I have everything I need. The canvas re-measures `clientWidth` every RAF frame, so column-width changes auto-refit with zero extra work. `LogKind` is the 7-value union as the proposals state. Here is the synthesis.

---

# In the Mountains — Chrome Redesign: Implementation Spec

## 0. Critique of the three proposals

| | Strength to keep | Weakness to drop |
|---|---|---|
| **A (separation-of-concerns)** | Best **bottom bar**: 3-zone strip with a live Contact Feed in the dead right half. Best **left-column mechanism**: one elastic `flex-1` sink (Intel) absorbs all drag slack, so the column sum is always exact and the shell never scrolls — the single cleanest answer to "draggable dividers in a fixed-height shell." Cleanest `isCombat` partition. | Right column went **tabs** — adds a `rightTab` mode + village-tab juggling. More state and a behavior change to the village flow than needed. |
| **B (TOC three-zone)** | Good framing (left=watch, right=orders, bottom=worktop). | Forces **fixed `h-[112px]`** ribbon + cramming **all 8 supply bars into 112px** — a real overflow risk it admits. Resizing two siblings' `flex-basis` against each other is fiddlier than A's single sink. Over-reaches (resizable left *width*, not asked for). |
| **C (uniform DockPanel)** | Best **abstraction**: one `<DockPanel>` primitive (header chevron + collapsible body + bottom-edge resize handle + persisted state) used everywhere. Cleanest store slice (`collapsed`/`heights` maps keyed by string id). SSR-safe hydration note. | Wants dock behavior on the **right** column too (the brief only requires collapse/drag on the LEFT) — scope creep. The "one grow panel absorbs slack, but breaks if you collapse it" risk is real; A's model (Intel is the elastic sink and stays expanded) is the fix. CombatLog kind set wrongly folds `radio`/`objective` into combat, leaving Command Log = only `info` (too thin). |

**Synthesis decision.** Use **C's `<DockPanel>` primitive** as the single reusable building block, driven by **A's "one elastic sink" geometry** for the draggable LEFT column (Intel = the only `flex-1` panel; every other panel has a stored pixel height; dragging a handle resizes the panel *above* it and Intel yields/absorbs the delta). Use **A's bottom-bar 3-zone strip + Contact Feed** verbatim. For the right column, take the **lightest declutter that kills the cram**: pull **Logistics out into a collapsible dock module** and split ElementPanel's orders vs. roster into two dock modules — *no tabs, no new `rightTab` mode, village swap unchanged*. Use **A's `isCombat` predicate** for the log split. Store slice is **C's two string-keyed maps**, persisted to its own `localStorage` key (never in `world.serialize()`).

This keeps every existing component, function name, and store action; it only relocates JSX into dock wrappers and adds two log filters, one primitive, and ~6 store fields.

---

## 1. Final layout

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ COMMAND BAR  ITM·FOB·callsign │ CLOCK LIGHT WX AIR │ 5 metric bars │ ●TIC ⏸ 1..16 ⏩ ☰│ h-12  (UNCHANGED)
├───────────────┬──────────────────────────────────────────────┬─────────────────────┤
│ LEFT 280px    │            CENTER  (flex-1, map hero)         │  RIGHT 344px        │
│ DockColumn:   │  MapControls(top-L)   BannerOverlay(top-C)   │  DockColumn:        │
│ ▾ ACTIVE ELE  │  ┌────────────────────────────────────────┐  │  ▾ SQUAD ORDERS     │ ← ElementPanel top half
│   ════drag════│  │                                        │  │    (missions+SOP+   │
│ ▾ DIRECTIVES  │  │            WorldView canvas            │  │     route/step-off) │
│   ════drag════│  │                                        │  │   ════drag════      │
│ ▾ INTEL FEED  │  │   (canvas auto-refits to clientWidth   │  │  ▾ TASK ORG  (grow) │ ← roster, own module
│   (flex-1 ▒▒) │  │    every RAF frame — no work needed)   │  │   ════drag════      │
│   ════drag════│  │                                        │  │  ▾ LOGISTICS ⚠      │ ← 8 bars + resupply
│ ▾ COMBAT LOG ●│  │                                        │  │                     │
│   ════drag════│  └────────────────────────────────────────┘  │  (VillagePanel swaps │
│ ▾ COMMAND LOG │  ┌────────────────────────────────────────┐  │   in for the ORDERS  │
│               │  │ OPS STRIP  (absolute, full map width)  │  │   module when a      │
│               │  │ SQUAD RDOUT│CFF+FIRE SPT+MEDEVAC│CONTACT│  │   village is picked; │
│               │  │            │                    │ FEED  │  │   Logistics stays)   │
└───────────────┴──────────────────────────────────────────────┴─────────────────────┘
  every ▾ header = click-to-collapse (▸).  ════drag════ = 5px row-resize handle on each panel's bottom edge.
  LEFT: Intel is the lone flex-1 sink → drags never overflow the shell.   RIGHT: Task Org is the lone flex-1 sink.
```

**Prose.** The outer shell is unchanged (`w-full h-full flex flex-col`; CommandBar `h-12`; `flex-1 flex min-h-0` row; never scrolls). Both side columns become a vertical stack of identical **dock modules** built from one `<DockPanel>` primitive: a stencil header (chevron + amber title + optional right-slot badge), an internally-scrolling body, and — when the panel is *resizable* and *not* the elastic sink — a 5px drag handle pinned to its bottom edge. **Left** widens `272→280`, **right** widens `336→344` (so SOP segmented buttons never wrap once Logistics no longer fights the roster for scroll height). Logistics moves OUT of the cramped right stack into its own collapsible module; ElementPanel splits into **Squad Orders** (hot path, pinned top) and **Task Org** (the elastic roster). The bottom OrderBar becomes a full-width **Ops Strip** of three zones — Squad Readout │ CFF + Fire Support + Medevac │ live Contact Feed — reclaiming the empty right half. A new **Combat Log** module sits directly above the **Command Log**, split by log `kind`.

---

## 2. Ordered, concrete edits

All edits are in **`components/screens/DeployScreen.tsx`**, **`state/store.ts`**, **`app/globals.css`** only. No new files required (the primitive lives in DeployScreen to honor "small components" without adding deps/files; if you prefer a file, `components/dock/DockPanel.tsx` is a drop-in).

### Edit 1 — `globals.css`: two utility classes (append at end)

```css
/* dock resize handle — sits on a panel's bottom edge, amber on hover/active */
.dock-handle {
  position: absolute; left: 0; right: 0; bottom: -2px;
  height: 5px; cursor: row-resize; z-index: 10;
}
.dock-handle > i { display: block; height: 1px; margin-top: 2px; background: var(--line); }
.dock-handle:hover > i, .dock-handle[data-active="true"] > i { background: var(--amber); }
.dock-dragging, .dock-dragging * { user-select: none !important; }
```
No new colors — reuses `--line` / `--amber`. The `.dock-dragging` class is toggled on `<body>` during a drag to kill text selection.

### Edit 2 — `store.ts`: panel-layout slice (own localStorage key, NOT in save)

Add near the other module-scope helpers (after `clearSaveOnDisk`, line ~127):

```ts
// ---- UI chrome layout (per-device preference, NOT part of the campaign save) ----
const LAYOUT_KEY = "itm-ui-v1";
export interface PanelLayout { collapsed: Record<string, boolean>; heights: Record<string, number>; seenCombatId: number; }
function loadLayout(): PanelLayout {
  const base: PanelLayout = { collapsed: {}, heights: {}, seenCombatId: 0 };
  try {
    if (typeof window === "undefined") return base;
    const r = window.localStorage.getItem(LAYOUT_KEY);
    if (!r) return base;
    const p = JSON.parse(r) as Partial<PanelLayout>;
    return { collapsed: p.collapsed ?? {}, heights: p.heights ?? {}, seenCombatId: p.seenCombatId ?? 0 };
  } catch { return base; }
}
function persistLayout(l: PanelLayout) {
  try { window.localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch { /* full/unavailable */ }
}
```

Add to the `GameStore` interface (near the `// ui` group, line ~38):

```ts
  // ---- panel layout (left + right dock columns; localStorage-backed) ----
  layout: PanelLayout;
  togglePanel: (id: string) => void;
  setPanelHeight: (id: string, px: number) => void;   // transient; persists on pointer-up
  persistPanelLayout: () => void;                      // call on pointer-up / after toggle
  markCombatSeen: (maxId: number) => void;
```

Add to the `create(...)` initial state (with the other `ui` defaults, line ~146):

```ts
  layout: loadLayout(),
```

Add the actions (anywhere in the action block, e.g. after `setJacket`):

```ts
  togglePanel: (id) => { set((st) => ({ layout: { ...st.layout, collapsed: { ...st.layout.collapsed, [id]: !st.layout.collapsed[id] } } })); persistLayout(get().layout); },
  setPanelHeight: (id, px) => set((st) => ({ layout: { ...st.layout, heights: { ...st.layout.heights, [id]: px } } })),
  persistPanelLayout: () => persistLayout(get().layout),
  markCombatSeen: (maxId) => { if (maxId <= get().layout.seenCombatId) return; set((st) => ({ layout: { ...st.layout, seenCombatId: maxId } })); persistLayout(get().layout); },
```

**Crucial:** do **not** add `layout` to the `set({...})` payloads in `newCampaign` / `loadCampaign`, and do **not** touch `world.serialize()`. Layout survives new/loaded campaigns untouched.

### Edit 3 — `DeployScreen.tsx`: the `<DockPanel>` + `<ResizeHandle>` primitive

Add near the top (after the `Bar` helper). This is **the one reusable component** that delivers requirement #4:

```tsx
// A dock module: stencil header (collapsible) + internally-scrolling body + bottom drag handle.
// `grow` panels are the elastic sink (no fixed height, no handle); exactly one per column.
function DockPanel({
  id, title, accent = "amber", right, grow = false, defaultHeight = 130, last = false, children,
}: {
  id: string; title: string; accent?: string; right?: ReactNode;
  grow?: boolean; defaultHeight?: number; last?: boolean; children: ReactNode;
}) {
  const collapsed = useGame((s) => !!s.layout.collapsed[id]);
  const height = useGame((s) => s.layout.heights[id]);
  const togglePanel = useGame((s) => s.togglePanel);
  const h = height ?? defaultHeight;
  // collapsed → header only (28px); grow → flex:1; else → fixed pixel height.
  const style: React.CSSProperties = collapsed
    ? { height: 28, flex: "0 0 auto" }
    : grow
      ? { flex: "1 1 0%", minHeight: 64 }
      : { height: h, flex: "0 0 auto", minHeight: 28 };
  return (
    <div className="relative flex flex-col min-h-0 border-b border-line" style={style}>
      <button
        onClick={() => togglePanel(id)}
        className="dock-header w-full flex items-center justify-between px-2 h-7 shrink-0 border-b border-line bg-panel hover:bg-panel2 select-none"
      >
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-inkdim text-[9px] transition-transform" style={{ transform: collapsed ? "rotate(-90deg)" : "none" }}>▾</span>
          <span className={`stencil text-[10px] text-${accent}`}>{title}</span>
        </span>
        {right && <span className="text-[9px] font-mono shrink-0">{right}</span>}
      </button>
      {!collapsed && <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>}
      {!collapsed && !grow && !last && <ResizeHandle id={id} defaultHeight={defaultHeight} />}
    </div>
  );
}

// 5px bottom-edge grab target. Drag resizes THIS panel; the column's lone `grow` panel
// (Intel left / Task Org right) absorbs/yields the slack, so the column sum stays exact
// and the fixed-height shell never scrolls.
function ResizeHandle({ id, defaultHeight }: { id: string; defaultHeight: number }) {
  const setPanelHeight = useGame((s) => s.setPanelHeight);
  const persist = useGame((s) => s.persistPanelLayout);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.dataset.active = "true";
    document.body.classList.add("dock-dragging");
    const startY = e.clientY;
    const startH = useGame.getState().layout.heights[id] ?? defaultHeight;
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(28, Math.min(560, startH + (ev.clientY - startY)));
      setPanelHeight(id, next);
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.dataset.active = "false";
      document.body.classList.remove("dock-dragging");
      persist();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  };
  return (
    <div className="dock-handle" data-active="false" role="separator" aria-orientation="horizontal"
      onPointerDown={onDown} onDoubleClick={() => { setPanelHeight(id, defaultHeight); persist(); }}>
      <i />
    </div>
  );
}
```
Notes: pointer **capture on the handle element** means a drag that overshoots into the map never leaks a waypoint to WorldView. Double-click resets to default height (cheap insurance). MIN 28 / MAX 560 clamp; the elastic sink (`min-h-64`) can't be crushed below its floor because flex won't shrink it past `minHeight`.

### Edit 4 — `DeployScreen.tsx`: convert panels to body-only renders

For each existing left/right panel, **strip its own outer `border-b border-line p-2` wrapper and inline stencil title** (the DockPanel header now owns both). Rename to `…Body` and return just inner content with `className="p-2"`. Concretely:

- **`TasksPanel` → `TasksBody`**: drop outer `<div className="border-b border-line p-2">` and the `<div className="stencil…">Active Elements</div>`; wrap remaining content in `<div className="p-2">`.
- **`DirectivesPanel` → `DirectivesBody`**: keep `if (active.length === 0) return null;` — but render the dock module conditionally in the column (see Edit 5) so no empty header shows. Strip wrapper + title; `<div className="p-2">`.
- **`IntelPanel` → `IntelBody`**: drop the outer flex/title; return `<div className="overflow-y-auto flex flex-col gap-1 p-2 pr-1">…</div>` (DockPanel already provides the scroll container, but keeping the inner scroll is harmless; simpler: just `<div className="p-2 flex flex-col gap-1">`).
- **`ElementPanel` → split into `SquadOrdersBody` + `TaskOrgBody`** (Edit 6).
- **`LogisticsPanel` → `LogisticsBody`**: drop the `h-[230px] overflow-y-auto` wrapper and the title row's stencil span; keep the convoy/air buttons but move them into the dock header `right` slot (Edit 7). Body = `<div className="p-2">` with the inbound line + the 8 `SUPPLY_ROWS` bars + CERP line.
- **`VillagePanel`**: leave mostly as-is, but it will be rendered *inside* a DockPanel-less swap (Edit 8) — keep its own `flex-1 overflow-y-auto p-2` so it fills the orders slot.

### Edit 5 — `DeployScreen.tsx`: rebuild the LEFT column

Replace lines 107–112 (`<div className="w-[272px]…">…</div>`) with:

```tsx
<div className="w-[280px] shrink-0 border-r border-line flex flex-col min-h-0">
  <DockPanel id="tasks" title="Active Elements" defaultHeight={132}><TasksBody /></DockPanel>
  {hasDirectives && <DockPanel id="directives" title="Battalion Directives" defaultHeight={120}><DirectivesBody /></DockPanel>}
  <DockPanel id="intel" title="Intel Feed" grow><IntelBody /></DockPanel>
  <DockPanel id="combatlog" title="Combat Log" defaultHeight={150} right={<CombatBadge />}><CombatLogBody /></DockPanel>
  <DockPanel id="commandlog" title="Command Log" defaultHeight={130} last><CommandLogBody /></DockPanel>
</div>
```
`hasDirectives` comes from a one-line selector in `DeployScreen`: `const hasDirectives = useGame((s) => s.world!.state.directives.some((d) => d.status === "active"));` (rendering the dock conditionally preserves today's "disappears when empty" behavior — no empty header). **Intel is the only `grow` panel** = the elastic sink. The last panel passes `last` so it grows no handle (nothing below to resize into). Order top→bottom: Tasks, Directives, Intel(grow), **Combat Log, Command Log** — satisfying requirement #3's "combat above command."

### Edit 6 — `DeployScreen.tsx`: split ElementPanel → Squad Orders + Task Org (right declutter, req #1)

Move the **first half** of `ElementPanel` (lines ~499–533: the `orders for the active squad` block — mission buttons, `<SopCard>`, no-medic warning, attach-officers checkbox, pax/waypoint line, Draw/Step-Off/Re-route) into `function SquadOrdersBody()`, keeping **all** store wiring (`planMission/setMission`, `planSOP/setPlanSOP/setSquadSOP`, `planning/setPlanning`, `stepOff/reroute`, `patrolIds`, the `inContact` lock). Return just `<div className="p-2">…</div>`.

Move the **second half** (lines ~534–565: `Task Organization` squad list + expandable roster + jacket buttons) into `function TaskOrgBody()`. Keep `selectSquad`, `setJacket`, the ready/deployed badges. Return `<div className="p-2">…</div>`. Bump roster row spacing `py-0.5 → py-1` and squad button `mb-2 → mb-2.5` now that it has room.

### Edit 7 — `DeployScreen.tsx`: `LogisticsBody` + resupply buttons in header slot

`LogisticsBody` renders the inbound-ETA line, the 8 `SUPPLY_ROWS` bars (`space-y-1`), and the CERP funds line — all in `<div className="p-2">`. The Convoy/Air buttons move into the dock **header right slot**, and a low-supply badge shows when collapsed:

```tsx
function ResupplyButtons() { /* the two <button> Convoy/Air, text-[9px] px-1.5 py-0.5; stopPropagation on the wrapper so clicking them doesn't toggle the panel */ }
function LogiBadge() { /* world.state.supplies has any row < warn → <span className="text-rust">⚠</span>, else null */ }
```

### Edit 8 — `DeployScreen.tsx`: rebuild the RIGHT column (no tabs)

Replace `RightColumn` (lines 417–426):

```tsx
function RightColumn() {
  const planning = useGame((s) => s.planning);
  const selectedVillage = useGame((s) => s.selectedVillage);
  const showVillage = !!selectedVillage && !planning;
  return (
    <div className="w-[344px] shrink-0 border-l border-line flex flex-col min-h-0">
      {showVillage ? (
        // village takes the ORDERS slot exactly as today; it's the elastic sink while open
        <div className="flex-1 min-h-0 overflow-y-auto border-b border-line"><VillagePanel villageId={selectedVillage!} /></div>
      ) : (
        <>
          <DockPanel id="orders" title="Squad Orders" defaultHeight={300}
            right={<DeployBadge />}><SquadOrdersBody /></DockPanel>
          <DockPanel id="taskorg" title="Task Organization" grow><TaskOrgBody /></DockPanel>
        </>
      )}
      <DockPanel id="logistics" title="Logistics" defaultHeight={196} last
        right={<><LogiBadge /><span onClick={(e) => e.stopPropagation()}><ResupplyButtons /></span></>}>
        <LogisticsBody />
      </DockPanel>
    </div>
  );
}
```
`DeployBadge` = the existing `● DEPLOYED` indicator (read `activeTask`). **Right-column declutter (req #1) is solved**: Logistics is now its own collapsible module (collapse it to give the roster the whole column), Squad Orders is the pinned hot path, Task Org is the elastic roster with real scroll room. Village swap behavior is **unchanged** (no new tab state, no `rightTab`). Note: the right column gets collapse + resize "for free" from `<DockPanel>`, but the brief only *requires* it on the left — this is a bonus, not extra code.

### Edit 9 — `DeployScreen.tsx`: Combat Log + Command Log bodies (req #3)

```tsx
const FIGHT_KINDS = new Set(["contact", "kia", "casualty", "support"]);
const isCombat = (l: { kind: string }) => FIGHT_KINDS.has(l.kind);

function kindStyle(kind: string): string {
  switch (kind) {
    case "kia":      return "text-rust border-rust font-semibold";
    case "casualty": return "text-tan border-tan";
    case "contact":  return "text-amber border-amber";
    case "support":  return "text-us border-us";
    default:         return "text-inkdim border-line";
  }
}

function CombatLogBody() {
  const world = useGame((s) => s.world)!;
  const markCombatSeen = useGame((s) => s.markCombatSeen);
  useGame((s) => s.tick);
  const lines = world.state.log.filter(isCombat).slice(-60).reverse();
  useEffect(() => { if (lines.length) markCombatSeen(lines[0].id); }, [lines.length, markCombatSeen]); // mark seen while visible
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {lines.length === 0 && <div className="text-inkdim italic text-[11px]">No contact. The valley is quiet.</div>}
      {lines.map((l) => (
        <div key={l.id} className={`text-[10px] leading-snug font-mono pl-1.5 border-l-2 ${kindStyle(l.kind)}`}>
          <span className="opacity-50">D{l.day} </span>{l.msg}
        </div>
      ))}
    </div>
  );
}

function CommandLogBody() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const lines = world.state.log.filter((l) => !isCombat(l)).slice(-40).reverse();
  return (
    <div className="p-2 flex flex-col gap-0.5">
      {lines.map((l) => (
        <div key={l.id} className={`text-[10px] leading-snug ${l.kind === "objective" ? "text-amber" : "text-inkdim"}`}>
          <span className="font-mono opacity-60">D{l.day} </span>{l.msg}
        </div>
      ))}
    </div>
  );
}

// header badge: live ● TIC, or unread-since-seen count when collapsed.
function CombatBadge() {
  const world = useGame((s) => s.world)!;
  const seen = useGame((s) => s.layout.seenCombatId);
  useGame((s) => s.tick);
  if (world.inContact()) return <span className="stencil text-[9px] text-rust blink">● TIC</span>;
  const n = world.state.log.filter((l) => isCombat(l) && l.id > seen).length;
  return n > 0 ? <span className="stencil text-[9px] text-rust">{n} NEW</span> : <span className="text-inkdim">—</span>;
}
```

### Edit 10 — `DeployScreen.tsx`: rebuild the bottom OrderBar → 3-zone Ops Strip (req #2)

Keep the outer container; change the inner from `flex items-start gap-3 flex-wrap` to a 3-zone non-wrapping flex row. The CFF card + Fire Support block + Medevac become **Zone 2** (with Fire Support buttons in a `grid grid-cols-2` so mortars and CAS sit side-by-side instead of stacking tall); a new **`<ContactFeed/>`** fills **Zone 3** (`flex-1`):

```tsx
return (
  <div className="absolute bottom-0 left-0 right-0 bg-panel/95 border-t border-line p-2 z-10">
    <div className="flex items-stretch gap-3">
      {/* ZONE 1 */}
      <SquadReadout />
      {/* ZONE 2 */}
      <div className="flex items-stretch gap-3 border-l border-line pl-3">
        {fr && (/* existing CFF card — CLEARED HOT / DENY, unchanged */)}
        <div>
          <div className="stencil text-[9px] text-amber mb-1">Fire Support <span className="text-inkdim normal-case">— click the map</span></div>
          <div className="grid grid-cols-2 gap-1 max-w-[320px]">
            {sim.mortars.map((mt) => (/* existing mortar button, unchanged */))}
            <button /* CAS Gun, unchanged */ />
            <button /* CAS Hellfire, unchanged */ />
            <button className={`col-span-2 tac-btn … ${casualtyInField ? "tac-btn-danger active" : ""}`} onClick={medevacSelected}>
              <Icon name="ico-medevac" size={13} /> 9-LINE MEDEVAC {casualtyInField && <span className="text-[9px]">· casualty down</span>}
            </button>
          </div>
        </div>
      </div>
      {/* ZONE 3 — fills the reclaimed right half */}
      <ContactFeed />
    </div>
  </div>
);
```
```tsx
function ContactFeed() {
  const world = useGame((s) => s.world)!;
  useGame((s) => s.tick);
  const lines = world.state.log.filter(isCombat).slice(-6).reverse();
  return (
    <div className="flex-1 min-w-0 border-l border-line pl-3">
      <div className="stencil text-[9px] text-amber mb-1">Contact Feed</div>
      {lines.length === 0
        ? <div className="text-inkdim text-[10px] font-mono">— net quiet —</div>
        : <div className="columns-2 gap-x-4">{lines.map((l) => (
            <div key={l.id} className={`text-[10px] leading-snug font-mono pl-1.5 border-l-2 mb-0.5 break-inside-avoid ${kindStyle(l.kind)}`}>
              <span className="opacity-50">D{l.day} </span>{l.msg}
            </div>))}</div>}
    </div>
  );
}
```
All `setFireSupport`, `approveFires/denyFires`, `medevacSelected`, disabled logic, and Icons are **unchanged** — only the wrapper layout changes. `ContactFeed` reuses the exact `isCombat`/`kindStyle` shared with the Combat Log (single source of truth).

---

## 3. Combat / Command log split predicate

One shared `Set`, used by **Combat Log, Command Log, and Contact Feed** — a true partition (every entry shows in exactly one channel):

```ts
const FIGHT_KINDS = new Set(["contact", "kia", "casualty", "support"]);
const isCombat = (l: { kind: string }) => FIGHT_KINDS.has(l.kind);

// COMBAT  LOG = world.state.log.filter(isCombat)            // contact · kia · casualty · support
// COMMAND LOG = world.state.log.filter(l => !isCombat(l))   // info · radio · objective (+ any future kind, safe default)
// CONTACT FEED = same as Combat Log, .slice(-6)
```
`LogKind = "info" | "contact" | "casualty" | "kia" | "radio" | "support" | "objective"` (confirmed `lib/sim/combat.ts:49`). Firefight traffic — MAN DOWN / is KIA / enemy down / IED-CONTACT / incoming, plus fire-mission acks (`support`) — lands in Combat. Command-net chatter — step-off/RTB (`radio`), weather/policy (`info`), contact-broken wrap-ups (`objective`) — stays in Command. `support`-tagged resupply-complete is an accepted minority that still reads fine in blue. Color coding (strong, per req #3): `kia`→rust+bold, `casualty`→tan, `contact`→amber, `support`→us-blue, each with a matching `border-l-2` stripe. Retune later by editing one `Set`.

---

## 4. Collapsible + draggable mechanism

**One reusable `<DockPanel>` (Edit 3)** delivers both, no library:

**Collapse.** Header is a real `<button>`; click → `togglePanel(id)` flips `layout.collapsed[id]`. Collapsed → body unmounts, panel locks to header-only `height:28, flex:'0 0 auto'`, chevron rotates `-90°` (CSS `transition-transform`). Persisted to `localStorage('itm-ui-v1')` on every toggle.

**Drag.** Each *resizable, non-sink, non-last* panel renders a 5px `.dock-handle` on its bottom edge. `onPointerDown`: `setPointerCapture` (events can't leak to the map canvas) + record `startY`/`startH`, add `.dock-dragging` to `<body>` (kills text-selection). `onPointerMove`: `setPanelHeight(id, clamp(startH + dy, 28, 560))` — transient, no storage write per frame. `onPointerUp`: release capture, remove body class, `persistPanelLayout()` (single write). Double-click resets to `defaultHeight`.

**Geometry (the key insight, from proposal A).** Each column has **exactly one `grow` panel** — Intel (left) / Task Org (right) — with `flex:1 1 0%`, no stored height, no handle. Every other expanded panel has a fixed pixel height (`flex:0 0 auto`). Growing/shrinking any panel changes the grow-panel's leftover flex space, so **the column always sums to its container height and the fixed-height shell never scrolls.** Collapsed panels shrink to 28px and donate space to the grow panel automatically. The grow panel's `minHeight:64` floor means a drag can never crush it to nothing.

**Persistence.** Store slice `layout: { collapsed: Record<string,bool>, heights: Record<string,number>, seenCombatId: number }`, hydrated once via `loadLayout()` in the `create()` initializer (guarded by `typeof window`), written via `persistLayout()` to its own key `itm-ui-v1` — **never** in `world.serialize()` / `saveCampaign`, and **omitted** from `newCampaign`/`loadCampaign` `set()` payloads, so it survives reloads and new campaigns. Heights are clamped on read (`px ?? defaultHeight`, then the move clamp), so a stale oversized value self-corrects.

---

## 5. Verification checklist

Per CLAUDE.md: capture a fresh baseline, implement, re-screenshot, diff. Standing checks first: `npx tsc --noEmit` clean, `npm run build` green, `scripts/smoke.ts` passes.

Drive the live game with Playwright + `window.__ITM` and capture at **1280×800 and 1440×900**:

1. **Overview / no-overflow** (`ui-overview-after.png`): the shell shows no outer scrollbar at either size; left column = 5 dock headers (Active Elements, Battalion Directives, Intel Feed, **Combat Log**, Command Log) in that order with Combat directly above Command; right column = Squad Orders, Task Organization, Logistics. Map canvas re-fit to the new `280/344` widths (no stretch/letterbox).
2. **Right declutter** (`right-column.png`): Logistics is its own collapsible module; collapse it and confirm Task Org roster grows to absorb the freed height and scrolls in its own viewport; SOP segmented buttons do **not** wrap at 344px.
3. **Bottom strip** (`ops-strip.png`): full map width used — Squad Readout left, CFF+Fire Support (2-col grid)+9-LINE MEDEVAC center, **Contact Feed filling the previously-empty right half**; no dead band.
4. **Combat vs Command split during a TIC** (`tic-logs.png`): trigger contact (advance via warp). Combat Log shows colored lines — KIA rust+bold, casualty tan, contact amber, support blue, each stripped; Command Log shows only info/radio/objective (muted); no line appears in both. Contact Feed mirrors the last 6.
5. **Collapse** (`collapse.png`): click each left header chevron → body hides, chevron rotates, panel = 28px, Intel absorbs the space; collapsed Combat Log header shows `● TIC` (live) or `N NEW` badge.
6. **Drag + persist** (`drag-before.png`/`drag-after.png`): `browser_drag` a divider ~80px; the panel above grows, Intel shrinks, shell still doesn't scroll; **reload** and confirm the new height + any collapsed state persist (read `__ITM.getState().layout` and `localStorage['itm-ui-v1']`); confirm `localStorage['itm-save-v2']` does **not** contain `layout`.
7. **Functionality regression**: recall, plan/Draw Route/Step Off, Re-route, SOP edit (and locked-in-contact), KLE, CERP fund, Convoy/Air resupply (clicking them does **not** toggle the Logistics panel — `stopPropagation` works), fire support placement, 9-LINE medevac, soldier jacket — all still fire. Village swap still replaces the Orders slot on map-click and restores on close.
8. **Aesthetic**: side-by-side baseline vs after — headers/chevrons/handles use only `.stencil`/`.tac-btn`/amber/line; square corners, mono numerals; reads as the same instrument.

**Files touched:** `/Users/elliothimmelfarb/code/in-the-mountains/components/screens/DeployScreen.tsx`, `/Users/elliothimmelfarb/code/in-the-mountains/state/store.ts`, `/Users/elliothimmelfarb/code/in-the-mountains/app/globals.css`. No new dependencies; canvas auto-refits because `WorldView.tsx:113` re-reads `wrap.clientWidth` every RAF frame.