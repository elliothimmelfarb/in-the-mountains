# COIN gate — day-one status (honest record)

The audit promoted `campaign-loop.ts` to the **win-condition gate** (added a fail-tally + `exit(1)`).
This records what the gate actually did on day one — per the charter's own rule that a gate you
haven't seen pass is not a green gate.

## What ran

- **1-seed fast (`campaign-loop.ts 1 8`, survey-0):** completed in ~3 min. **Result: FAIL 3/8** —
  `score DISCRIMINATES (>25)` spread only **3.0** (careful 52 vs body-count 49); `COIN moves attitude`
  Δ 2.0 (<5); `directives fully live` 0/3 complete. The other 5 checks PASS (loop runs, CERP two-way,
  enemy dynamic, projects complete 2.0, cadence live). → **one seed at the 8-day minimum horizon is too
  noisy / too short to discriminate; it cannot be the gate config.**
- **3-seed default (`campaign-loop.ts`, survey-0/1/2 × 8d):** **did not complete in ~40 min wall**
  (~20 min CPU, 2 of 6 policy-runs done: careful survey-0 score 52, survey-1 score 22). The
  body-count policy's weapons-free combat under the 30 s strategic step generates enormous entity
  counts → each heavy seed is 9–15 min. **Impractical to run routinely.**

## The two honest findings

1. **The gate is not yet a practical green standing check.** The default config is too slow (~40+ min)
   to run pre-merge in practice, and the fast 1-seed/8-day config under-discriminates. The exit-code
   infrastructure + the charter principle (the win condition *deserves* a gate) are the durable wins;
   a **fast, deterministic, properly-calibrated COIN-smoke config is required follow-up** before it is
   a clean green gate.
2. **There is real tension to resolve in that calibration.** Fewer seeds / fewer days = faster but
   noisier (survey-0 @ 8d barely discriminates); the script's own header says discrimination shows
   more at LONGER horizons (`prove longer trajectories with a bigger [days]`) — which is *slower*. So a
   practical gate likely needs a small set of *pre-vetted fast seeds* at a horizon long enough to
   discriminate, not simply "fewer/shorter." That is design work, logged not guessed.

## Not concluded (deliberately)

Whether COIN discrimination has *regressed* since issue 015 (resolved 2026-06-06) is **unconfirmed** —
the 8-day single-seed spread of 3 is suggestive but 8 days is the marginal minimum horizon, so a low
spread there is expected, not proof of regression. Confirming COIN health needs the calibrated config
above (or a patient long-horizon run). Tracked in issue 030.
