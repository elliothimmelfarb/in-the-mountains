# 024 · The buddy's casualty drag can outrun the chasing medic

> **Ledger status (verified 2026-07-16 @ da10926):** OPEN — mechanism confirmed current: `medicTreat` publishes `targetId` and the buddy flips to `securing` (ai/friendly.ts) within 4 m, so the staged race self-resolves; the long-approach residual (a medic who never closes within 4 m of a fast-dragging pair) is still unbounded.
> Refutations recorded here bind only while the refuted mechanism is unchanged — verify before treating as a wall.

**Status:** OPEN (observed + measured 2026-06-10; partially mitigated the same day by the
securing-buddy handoff, residual unverified in long fights)

## Symptom

A casualty's aid buddy drags him toward cover at 0.7 m/s (`sim.dragToCover`,
`lib/sim/ai/friendly.ts` buddy-aid block → `combat.ts` drag) while the medic chases the moving
patient and stops 2.5 m short (`medicTreat`'s treat range, `lib/sim/ai/friendly.ts`). On terrain
where the drag never reaches cover ≥ 0.3, the pair keeps crawling and the medic hovers 2.5–4 m
away indefinitely — the casualty can bleed out with the doc an arm's length away.

## Reproduction (recorded by the transitions probe build, 2026-06-10)

`scripts/transitions-probe.ts` stages a deterministic scene per seed (unconscious chest bleeder
at the muster yard, medic + buddy 3 m off). Before the medic-targetId fix, **4/6 staged seeds**
ended with the victim dead and the medic never closing inside treat range — the buddy kept
dragging away from the approaching medic.

## Partial mitigation already shipped

The medic now publishes his patient (`u.targetId = patient.id` in `medicTreat`), and once he is
within 4 m the aid buddy flips to the `securing` posture (kneels facing the threat) and STOPS
dragging — so in the staged geometry the race self-resolves. Residual risk: a medic who never
gets within 4 m of a fast-dragging pair (long approach, broken ground) can still starve; the
probe's live (non-staged) episodes are too rare to bound that probability yet.

## Suggested fix shape (for a future session)

Stop the drag when a medic is actively closing on this casualty (e.g. buddy checks
`medic.targetId === cas.id && dist(medic, cas) < 12` before dragging), or have `dragToCover`
yield when the destination cover gain is marginal. Verify with the transitions probe's staged
scenes (assert: time-to-treat < 20 s on all stage seeds) plus a live-fight sweep.
