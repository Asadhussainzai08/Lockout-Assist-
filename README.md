# Lockout Assist: operator support workflow prototype

A small, working support workflow for one high-stakes operator problem: **a renter is locked out of a vehicle during an active rental.**

The operator reports the lockout. The system validates the rental and vehicle, works out how urgent it is, and routes it to the right place. It gives the operator next steps immediately, opens a support case, and lets them track that case until it's closed.

## Why this problem

1Now serves small and mid-size car rental operators (Turo hosts and operators moving to direct bookings, 2–50+ cars) who run keyless, telematics-equipped fleets. For them, a lockout is one of the worst support moments:

- **The renter is stranded right now.** Every minute hurts the review, the rebooking and sometimes their safety.
- **The operator is often one person** handling it from their phone, sometimes miles away.
- **The fix depends on facts the operator can't easily see**, such as whether the car is online, where it is, and whether this has happened before. The system already knows these.

The prototype is built around one idea: **pull what the system already knows, ask the operator only what it can't know, and return a decision instead of a form confirmation.**

## Run it

No build step and no dependencies.

```bash
python -m http.server 8765
```

Open http://localhost:8765. Any static server works; `npx serve .` does too.

Run the triage-rule tests (needs Node 18+):

```bash
node tests/triage.test.js
```

## The three screens

| Screen | What it does |
|---|---|
| **1. Report** | Rental ID (plus optional vehicle ID or plate) → validated lookup showing the vehicle, renter, telematics status, location, lockout history and any open case. Then four quick questions: who's locked out, where the keys are, whether the renter is at the car, and any safety concerns. |
| **2. Outcome** | Case number, priority, queue and response target. Numbered **next steps** for this exact situation, the **reasons** behind the routing, an interactive panel (remote unlock, add to an existing case, or emergency status), and a ready-to-send **renter message**. |
| **3. Tracker** | Every case with a live response-time countdown, a progress bar, a full activity timeline, notes, location confirmation, resolution, and reopening. **"Simulate support update"** plays the support team's side, so the loop can be closed end to end. |

## Triage logic

The rules are ordered, and the first match wins. All of them live in [`js/triage.js`](js/triage.js) as pure functions.

```
Safety concern?            → P1 · On-call emergency (5 min)    even if a case is already open
Open case for rental/car?  → Show existing case                 no duplicate; add an update, or override to a linked case
Telematics offline?        → P2 · Tier 2 dispatch (15 min)      spare key first, else locksmith
Otherwise (online)         → P3 · Guided self-serve             remote unlock; a failure auto-escalates to P2
   + repeat lockout        → raised to P2, fleet inspection logged when resolved
```

These modifiers apply on any path:

- **No GPS fix**: the case is flagged and **dispatch is held** until the operator confirms an address.
- **Renter not at the car**: remote unlock stays disabled until they are, so the car isn't left open.
- **Rental not active**: logged, but flagged for billing and insurance review.

## Messy cases covered

Each one has a one-click scenario in the sidebar.

| Scenario | Rental | What happens |
|---|---|---|
| Happy path | `R-1001` | Online Tesla → remote unlock → renter confirms → closed |
| Vehicle offline | `R-1002` | Silent for 3h → P2 Tier 2, lockbox spare key suggested, last known location shown |
| Location unavailable | `R-1003` | No GPS and remote unlock fails → escalated, dispatch held until address confirmed |
| Repeat lockout | `R-1004` | 3rd lockout in 30 days → P2, fleet inspection added to the case |
| Already reported | `R-1005` | Open case CS-24817 shown instead of opening a duplicate |
| Safety emergency | `R-1001` + child/pet inside | 911 banner appears as soon as the box is ticked, P1, unlock sent in parallel |
| Wrong vehicle | `R-1001` + `V-104` | Explains the mismatch and offers either fix in one click |
| Mistyped rental ID | `R-1011` | Not found → closest real ID suggested |
| Messy input | `r 1004` | Read as `R-1004`. Plates like `mqr-8840` also resolve to a vehicle |
| Rental already ended | `R-1006` | Allowed, with a warning, and flagged as outside a rental |

## Decisions and trade-offs

- **Deterministic rules, not an LLM.** Lockout triage has a small, well-defined decision space and safety implications, so rules make every decision explainable (the "Why it was routed this way" panel) and testable. An LLM would fit on top, reading free-text notes to pull out signals like "baby in the car".
- **Safety comes first, before duplicate detection.** A second report on an open case is normally noise. When it includes a safety concern, it's the most important message in the queue.
- **Self-serve before escalation**, but a failure never sends the operator back to the start. A failed unlock escalates the same case and keeps its history.
- **Duplicates are blocked softly.** The operator can always say "this is a separate issue", and the new case is linked to the existing one.
- **The renter message is part of the product.** Operators have to tell the renter something, so the app drafts it.
- **Mock data.** Reservations, vehicles and telematics are seeded in [`js/data.js`](js/data.js) with timestamps relative to page load. Cases persist in `localStorage`, and **Reset demo data** restores the seed.

## With more time

1. Real integrations: the reservations API, telematics providers (live online status, lock state, GPS), and SMS to the renter and operator.
2. A support-agent view of the same case (queue, claim, dispatch) instead of the simulate button.
3. Auto-escalation when a response target is missed, with paging.
4. Reporting: lockouts per vehicle and per telematics provider, time to resolution, self-serve success rate. Repeat lockouts are the early warning for failing hardware.
5. Renter-facing self-serve: a link in the rental text that runs the same unlock flow before the operator is even called.

## Files

```
index.html            app shell + tabs
styles.css            light/dark themes, responsive down to phone width
js/data.js            mock reservations, vehicles, telematics, seed cases
js/triage.js          validation + triage rules + case creation (pure, tested)
js/app.js             screens, state, case actions, persistence
tests/triage.test.js  16 rule tests (node tests/triage.test.js)
```
