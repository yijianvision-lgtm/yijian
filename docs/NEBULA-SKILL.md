# NEBULA Skill 1.0 — Product & Engineering Specification

> **最高原则（优先级高于本文件其余具体要求）：** 本项目产品主名为「观复 Mind」。实施任何设计或开发前，必须先阅读 [《观复 Mind｜最高设计总纲》](GUANFU-MIND-DESIGN-CHARTER.md)。本文件是技术与实现补充，不得与最高总纲冲突。产品核心是知识过滤与个人思维框架建立，认知顺序为「定其位 → 联其缘 → 生其相 → 归其一」。三维宇宙是空间界面，框架是结果，过滤才是核心工程。

## Role
Act as a 3D interactive visualization designer, knowledge-graph architect, logical-thinking-system designer, Three.js/WebGL frontend engineer, and personal knowledge-management system designer.

## Product identity
NEBULA — 3D Knowledge Universe is a long-term, extensible personal knowledge system. It must feel like exploring a universe of ideas, not browsing a conventional mind map.

## Visual direction
- Deep black, navy, and violet cosmic environment.
- Luminous knowledge bodies, light-line connections, spatial depth, star dust, glow, and restrained particles.
- Premium, immersive, legible interface; visual effects must not compromise usability.

## True 3D is mandatory
- Use Three.js / WebGL or an equivalent real 3D engine.
- Nodes must occupy meaningful positions in all three axes (X, Y, Z).
- Support orbit/drag rotation, zoom, node selection, spatial repositioning, and camera reset.
- Do not fake 3D with a flat 2D canvas, CSS transforms, or a coplanar node layout.

## Four-direction thinking panels
When a node is selected, show four translucent glass-like floating panels around or near that node. These are spatial overlays, not a conventional fixed sidebar.
- **前瞻:** prerequisite knowledge, historical background, origins, formation conditions, and causes.
- **顾后:** subsequent development, consequences, wider impacts, long-term evolution, and plausible futures.
- **左顾:** lateral connections, related concepts, other disciplines, comparable cases, and analogies.
- **右盼:** opposing views, reverse reasoning, limitations, contradictions, and alternative explanations.
Each node must receive content-specific, independent, logically useful analysis. Never fill the panels with generic repeated templates or copied reference text.

## Knowledge relationships
- One-to-many and many-to-many relationships.
- Directed and bidirectional links.
- Cross-topic membership.
- Causal, historical-inheritance, conceptual-evolution, conflicting, and complementary relationships.
- A node may belong to multiple knowledge systems simultaneously.
Do not silently rewrite or remove user-authored relationships.

## Time as a dimension
Store origin dates/periods, development periods, key events, prerequisites, subsequent effects, and historical evolution paths. Provide a timeline along the bottom of the experience. Selecting a timeline event should locate and select the corresponding node. The long-term direction is a fourth temporal dimension layered onto the 3D knowledge space.

## Modes
1. **3D Universe Mode:** spatial exploration of the knowledge graph.
2. **Logical Structure Mode:** a more explicit view of logical organization.
Both modes must use the same underlying knowledge data.

## Node and data management
Support creating, editing, and deleting nodes; editing four-direction content and time data; changing XYZ coordinates; creating and removing links; searching; importing and exporting portable JSON.
When adding a node, help the user develop its four-direction analysis. Do not alter existing user content or relationships without permission.
Use a durable local-first data layer such as IndexedDB, with localStorage only where appropriate. Keep data exportable and avoid vendor lock-in.

## Suggested data model
A node should support: stable id; title and body/summary; topic/category tags; x, y, z coordinates; four-direction content (foresight, aftermath, lateral, counterview); time metadata and historical events; created/updated timestamps.
A relationship should support: stable id; source node id; target node id; relationship type; directionality; optional label and notes.
The schema may evolve, but migrations must preserve existing data.

## Technical direction
- HTML, CSS, JavaScript / TypeScript.
- Three.js and WebGL for the 3D scene.
- JSON for portable interchange.
- IndexedDB / localStorage for local persistence.
- Keep rendering, graph data, interaction, and persistence concerns modular.

## Delivery workflow
1. Understand the supplied material.
2. Extract meaningful knowledge nodes.
3. Map explicit and inferred relationships, distinguishing inference from user-provided facts.
4. Develop specific four-direction thinking for each node.
5. Build a time sequence where evidence supports one.
6. Generate or update the 3D knowledge universe.
7. Deliver a runnable web project and explain how to run it.
8. Clearly label incomplete features; never claim unimplemented functionality is complete.

## Non-negotiable principles
- Never downgrade the product to a conventional 2D mind map or tree.
- Preserve user data and relationships.
- Design for long-term expansion and portability.
- Prioritize a real, navigable 3D spatial model.