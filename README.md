# 观复 Mind（NEBULA）｜Personal Knowledge Universe

> 聚焦一点，知其在全局；生发万象，终归其一。一切为了框架建立。

**产品主名：观复｜英文副名：Mind。** NEBULA 是项目/工程代号。产品不是驾驶舱、仪表盘或普通脑图，而是以知识过滤为核心、以个人思维框架建立为最终目的的认知定位界面。

## 最高设计依据

所有产品、UI、交互、数据与 AI 设计必须优先遵循：
[《观复 Mind｜最高设计总纲》](docs/GUANFU-MIND-DESIGN-CHARTER.md)

实施与后台架构请继续阅读：[《产品结构与后台实施蓝图》](docs/GUANFU-MIND-IMPLEMENTATION-BLUEPRINT.md)

核心顺序：**定其位 → 联其缘 → 生其相 → 归其一**。
框架是结果，过滤才是工程；一切为了框架建立。

A persistent, interactive 3D personal knowledge system.

## Run the first prototype

The first browser prototype is available at [index.html](index.html).

- Open the repository's `index.html` through GitHub Pages after enabling Pages (Settings → Pages → Deploy from a branch → `main` / `/ (root)`).
- For local testing, serve the repository folder with a local static HTTP server. Because the app uses JavaScript modules, opening the file directly with `file://` may be blocked by browser security.
- The page loads Three.js from jsDelivr, so an internet connection is required.

## Prototype v0.1 features

- Genuine Three.js / WebGL 3D scene with XYZ node positions.
- Orbit rotation, zoom, drag navigation, and camera reset.
- Selectable glowing knowledge nodes and spatial connection lines.
- Four-direction floating glass panels: 前瞻、顾后、左顾、右盼.
- Search, logical list view, create/edit node, timeline navigation, JSON export.
- Browser-local persistence through localStorage.

## Current limitations

- The first prototype uses a small built-in example knowledge set; it does not yet load an external JSON file.
- Relationship lines are currently a predefined sample set. A visual relationship editor and node deletion are not implemented yet.
- Node coordinates are assigned automatically for newly created nodes; direct XYZ coordinate editing is not implemented yet.
- JSON import/export is implemented. Import accepts a NEBULA JSON export (or a JSON array of nodes), previews the node count for confirmation, and merges into the current browser data. Matching IDs update existing nodes; new IDs are added. IndexedDB sync and cloud synchronization are not yet implemented.
- The timeline is a lightweight node/date navigator, not yet a full historical event editor.
- The logical view is a selectable list, not yet a full relationship-layout view.

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

- [x] Build the first runnable Three.js universe.
- [x] Add node selection and four-direction floating panels.
- [x] Add basic node creation/editing, search, timeline navigation, and JSON export.
- [ ] Add relationship editing and direct XYZ coordinate editing.
- [ ] Add full logical-structure view using the same data.
- [x] Add JSON import and export.
- [ ] Add IndexedDB persistence and richer timeline events.
- [ ] Publish a hosted version after the local prototype is validated.

## Project specification

See [NEBULA Skill 1.0](docs/NEBULA-SKILL.md) for detailed product and implementation requirements.
