# V42.7 isolation work log

Base: V42.6 commit 81875376d3fc1acff5202e8efcd7d271cd7eff24

Branch: isolation/v42-7-core-menu-fixes

Purpose:
- Keep all V42.6 approved geometry and the natural fog exactly unchanged.
- Isolate experimental V42.7 changes from the default branch and formal entry.
- Do not guess the desired core-word font weight; leave it unchanged until user clarifies.

Changes in ui-preview-v42-7.html:
1. Increased the central rear glow only; did not modify the approved fog pseudo-elements.
2. Shortened the A center-out condensation from 1.12s to 0.78s.
3. Removed backdrop-filter from the learning-status menu surface, retained the 100ms opacity entrance, and added paint/layout containment.

Menu bug investigation:
- Exactly one mastery toggle click listener found.
- Exactly one menu choice click listener found.
- Exactly one outside-click close listener found.
- Therefore duplicate JS click handlers are not confirmed as the cause. Do not claim the menu bug is fixed until tested in a real browser.
- Earlier CSS declarations include blur(20px), but later CSS overrides exist; the isolated branch explicitly forces no backdrop blur to test rendering cost.
- Next diagnostic if latency persists: measure click-to-visible with Performance API in browser, inspect overlay hit-testing, and profile style/layout/paint. Preserve menu option saving behavior.

Safety/isolation:
- No change to default branch.
- No change to index.html or formal entry.
- No backend, user knowledge data, or privacy behavior changed.
- V42.6 remains the current baseline.


## User confirmation update
The user selected E for core-word weight: assistant should judge from the overall visual direction. V42.7 now uses a refined medium weight of 450, aiming for a precise, premium balance rather than bold or hairline. Only font weight is changed; size, spacing, center anchor and positioning remain unchanged.

Natural fog remains locked. The title weight choice is an implementation judgment pending user visual acceptance, not yet a user-approved visual result.
