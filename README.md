# NEBULA — 3D Knowledge Universe

A persistent, interactive 3D personal knowledge system.

## Project direction

NEBULA is a navigable knowledge universe, not a conventional 2D mind map. Knowledge nodes occupy a real XYZ space and can be explored through rotation, zoom, selection, and spatial relationships.

## Core experience
- **3D universe:** Three.js / WebGL scene with depth, orbit controls, zoom, and selectable nodes.
- **Four-direction thinking:** 前瞻 (prerequisites and origins), 顾后 (consequences and future development), 左顾 (lateral connections), and 右盼 (counterarguments, limits, and alternatives).
- **Knowledge graph:** Many-to-many links, cross-topic relations, causal links, historical inheritance, conflicts, and complementary ideas.
- **Time dimension:** Origins, periods, events, and historical paths, with a navigable timeline.
- **Two views:** 3D Universe and logical-structure view, backed by the same data.
- **Knowledge management:** Create, edit, delete, connect, search, import, and export nodes.
- **Persistence:** Local-first storage (IndexedDB / localStorage), with portable JSON export.

## Non-negotiable principles
1. Build a genuine 3D XYZ environment; do not imitate 3D with a flat canvas or a 2D layout.
2. Do not reduce the product to a traditional tree diagram or flat mind map.
3. Preserve user-authored content and relationships when extending the system.
4. Generate specific, meaningful four-direction analysis for each node; avoid generic filler.
5. Be explicit about what is implemented, partial, or not yet implemented.

## Roadmap
- [ ] Define the data model and interaction architecture.
- [ ] Build the first runnable Three.js universe.
- [ ] Add node selection and four-direction floating panels.
- [ ] Add relationship editing and timeline navigation.
- [ ] Add logical-structure view using the same data.
- [ ] Add persistence, JSON import/export, and search.
- [ ] Publish a hosted version after the local prototype is validated.

## Project specification
See [NEBULA Skill 1.0](docs/NEBULA-SKILL.md) for detailed product and implementation requirements.