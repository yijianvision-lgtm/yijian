# GUANFU MIND — V25 Interaction Baseline

- Status: user accepted as the current working baseline on 2026-11-08 ("现在这版还可以，标记一下").
- Visual foundation: V3-A pure cosmic canvas; preserve composition, palette, centered core, and interaction hierarchy.
- Included interaction work: spatial view-entry transitions, smoother camera follow and node rotation response, reduced per-frame minimap rendering, capped high-DPI render ratio, archive layering above the exploration view.
- UI implementation commit: 9bdaa3ec8fb87a15f7bd2f19e6116b6517b96281.
- Baseline is a working checkpoint, not a claim of complete browser E2E acceptance.
- Follow-up fix: include nodeDetail in the shared close list so the archive Return button and Escape key actually close it. After closing, keep the four-direction guide stowed; the minimap remains the explicit restore entry.
- Guardrails: do not replace the approved V3-A design, connect the production backend, or overwrite index.html without explicit approval.
