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


## User confirmation update — core-word size (V42.7)

- The user explicitly selected **A**: retain the current reduced core-word size; do not shrink it further.
- Keep the V42.6 size rule inherited by the V42.7 isolated preview: desktop `clamp(20px,1.55vw,23px)`; mobile `clamp(18px,4.2vw,20px)` at the existing max-width breakpoint. No new size override is added in V42.7.
- Keep the V42.7 selected weight `450`; size and weight are separate decisions. The weight choice does not authorize moving the common center, changing letter spacing, or changing the approved fog.
- Natural fog, common-center anchor, four-direction layout, learning-status behavior and all other user-approved items remain locked.
- This confirms the size setting only; it is not full visual acceptance of V42.7.
- Static source inspection confirms the final V42.7 style block does not override font size. No V42.7 Actions workflow runs were returned for the core-weight choice commit or the latest recovery-log commit. Browser visual and click-latency tests remain outstanding.
- Next: test the isolated preview in a real browser at desktop and mobile widths; measure learning-status click-to-visible latency with Performance API; verify the title remains centered and the fog layer is visually preserved. Do not merge or deploy to the formal entry before user acceptance.


## User confirmation update — rear glow direction (V42.7)

- The user explicitly selected **A** for the rear glow: keep the central highlight clear, make the surrounding halo diffuse softly, and avoid a hard-edged ring.
- This authorization applies only to the rear glow. Preserve the selected core-word size (desktop 20–23px; mobile 18–20px), weight 450, common-center anchor, natural fog, four-direction layout, learning-status behavior, and all previously approved items.
- This is a confirmed design direction, not evidence that the visual change has been implemented or visually accepted.
- The repository README documents the existing V3-A Pages preview at https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-a-cosmos.html. The V42.7 isolated file is not documented as a deployed preview. Do not present the V3-A URL as V42.7, and do not claim either URL was browser-verified in this run.
- The V42.7 commit f0e8c9fb09eaa2e0ffa0be5941fa3c9217fa5099 returned no workflow runs and no combined status entries. A live V42.7 deployment remains unverified.
- Next: implement only the rear-glow softness in the isolated V42.7 file; preserve fog and approved geometry; run static regression checks; then establish a separate, actually accessible V42.7 preview before requesting visual acceptance.


## V42.7 rear-glow implementation update

- Implemented the user's confirmed A direction in the isolated UI file only (commit 0f5bb77a3e998636c1c7734958b2705989707a75): tightened the central point to a restrained highlight and replaced the multi-radius bright halo with a broader, lower-contrast diffuse field using a 44px blur. Mobile halo dimensions remain separately constrained.
- Preserved the existing natural-fog/halo pseudo-element layer, V42.7 title weight 450, inherited desktop/mobile size rules, common-center anchor, four-direction layout, and learning-status menu rules.
- This is a source implementation, not browser-verified visual acceptance. Static regression checks are recorded separately; actual desktop/mobile rendering and menu latency still require browser testing.
- Preview delivery: README currently documents the existing V3-A Pages preview (https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-a-cosmos.html), but that is not V42.7. The isolated V42.7 file has no verified live Pages URL. Do not conflate the baseline preview with this V42.7 build.


## V42.7 isolated preview artifact — 2026-11-09

- Added `.github/workflows/v42-7-preview-artifact.yml` on `isolation/v42-7-core-menu-fixes` only. It packages `ui-preview-v42-7.html` as a downloadable GitHub Actions artifact; it does not publish Pages, change deployment settings, merge to `main`, or touch the formal entry/backend/data.
- Workflow run: [42619559436](https://github.com/yijianvision-lgtm/yijian/actions/runs/42619559436) — completed successfully. The packaging job passed HTML integrity checks and Node 22 syntax checks for all 7 inline JavaScript blocks.
- Artifact: `guanfu-mind-v42-7-ui-preview` (artifact ID `13674950371`), expires 2026-11-23. The artifact contains the HTML preview and an `OPEN-ME.txt` guide.
- The downloaded artifact was extracted and the exact HTML file was verified locally (324,024 Unicode characters; 7 inline script blocks; 0 Node syntax failures).
- Attempted headless Chromium desktop/mobile verification in the working environment, but browser navigation was blocked by the environment policy (`ERR_BLOCKED_BY_ADMINISTRATOR`). Therefore no browser-rendering, screenshot, click-to-visible latency, or visual acceptance result is claimed.
- Menu source inspection still shows one direct toggle click listener, one menu-choice listener, one outside-click closer, and one Escape closer. This rules out an obvious duplicate-handler cause in the inspected source, but does not identify the user's observed delay. Next diagnostic remains a real-browser click-to-visible Performance API measurement and hit-testing/style-paint profile.
- V42.7 is now available as a real downloadable preview artifact, not a hosted live URL. Do not call it a Pages deployment or conflate it with the older V3-A hosted preview.
