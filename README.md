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

## MIND V2.0 architecture and design deliverables\n\n- **MIND V2.0 architecture:** [Overall architecture and core interaction design](docs/MIND-V2-ARCHITECTURE.md) — information architecture, tree/network/map boundaries, spatial levels and acceptance gates.\n- **Highest design charter:** [观复 Mind｜最高设计总纲](docs/GUANFU-MIND-DESIGN-CHARTER.md).\n\n## Open the product and UI preview

- **Formal page:** [index.html](index.html) — legacy production entry; it has not yet been migrated to the newer Mind workspace.
- **Independent UI preview:** [Open 观复 Mind preview](https://yijianvision-lgtm.github.io/yijian/ui-preview-v1.html) — latest committed preview source; confirm Pages deployment before treating it as the live release.

- **V2-A｜静域沉浸版：** [打开独立预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v2-a-immersive.html) · [GitHub 源文件](ui-preview-v2-a-immersive.html)
- **V2-B｜认知舰桥版：** [打开独立预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v2-b-bridge.html) · [GitHub 源文件](ui-preview-v2-b-bridge.html)
- **V2-C｜谱系导航版：** [打开独立预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v2-c-lineage.html) · [GitHub 源文件](ui-preview-v2-c-lineage.html)

### V3 三套明显不同的完整布局（本轮供选择）

- **V3-A｜纯宇宙画布：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-a-cosmos.html) · [源文件](ui-preview-v3-a-cosmos.html) — 隐藏常驻侧栏，以全屏三维空间为主，信息收进底部浮动控制区。
- **V3-B｜认知控制台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-b-command.html) · [源文件](ui-preview-v3-b-command.html) — 左侧工作导航、中间三维工作区、右侧知识详情，固定三栏。
- **V3-C｜纵向谱系工作台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-c-lineage.html) · [源文件](ui-preview-v3-c-lineage.html) — 默认呈现纵向逻辑树，三维宇宙作为背景和定位上下文。

These three V2 concepts preserve the existing preview interactions and local data layer while testing distinct information layouts. They are review candidates, not a production replacement; choose one before migrating the formal entry page.
- **Design charter:** [观复 Mind｜最高设计总纲](docs/GUANFU-MIND-DESIGN-CHARTER.md).
- **Implementation blueprint:** [产品结构与后台实施蓝图](docs/GUANFU-MIND-IMPLEMENTATION-BLUEPRINT.md).

The preview uses Three.js / WebGL for the spatial scene. When a local IndexedDB graph exists, it loads that graph into the 3D space; otherwise it clearly labels the built-in sample as a preview. The filter workspace and local source import call the current NEBULA_LOCAL APIs. The preview is independent from index.html, so visual iteration does not silently replace the formal page.

## Current backend capabilities

- **Local-first storage:** IndexedDB schema v5 with non-destructive migration and portable backup/restore.
- **Source ingestion:** original PDF, DOCX, DOC, EMMX and XMind materials remain separate from extracted candidates. Legacy DOC is retained with a conversion warning; scanned-PDF OCR is not yet included.
- **Extraction and filtering:** extraction batches, candidate items, filter cases, duplicate/near-duplicate suggestions, and append-only user decisions.
- **Four-dimensional placement:** lineage, time, domain/space, and horizontal relation suggestions, each carrying rationale, source and uncertainty.
- **Review protection:** AI and rule-based suggestions become review proposals. They do not directly overwrite formal knowledge. Accepted nodes keep source links; relations keep independent evidence records.
- **Framework and space:** framework tree, spatial projection, semantic coordinates separated from visual XYZ layout, MindContext, and version snapshots.
- **Evidence resolver:** resolve candidates and formal nodes back to original sources, page/topic/block locators, excerpts, and review decisions.
- **AI gateway:** opt-in Worker analysis for one selected filter case, sending only its candidate content and a bounded set of relevant context nodes. Requires a configured Worker URL, access token and server secrets.
- **Knowledge output:** filter workbench snapshot, framework Markdown export, knowledge brief, learning records and review scheduling.

## Current validation and limitations

- GitHub Actions validates JavaScript syntax, backend API contracts, IndexedDB runtime workflows, migration, source locators, four-dimensional suggestions, proposal-only AI handling, review finalization, and UI preview inline scripts.
- The current preview has not yet passed manual browser visual/interaction acceptance. The latest recorded CI run (#200) passed backend syntax, contract, IndexedDB runtime and preview-script checks; this does not replace real-browser acceptance. Automated checks do not prove every real PDF/Word/EMMX/XMind file parses perfectly.
- The Worker is optional. If it is not deployed/configured, AI analysis reports an explicit configuration error; local rule-based filtering still works.
- The formal index.html has not been replaced by the independent preview. The preview is the place to inspect and refine the new information architecture and visual language before any production migration. The latest Jekyll site CI run (#288) passed, but that result alone does not confirm that the newest preview has been deployed to GitHub Pages.
- No automatic cloud sync, login requirement, or whole-library AI upload is introduced.

## Product direction

观复 Mind is a knowledge filtering and personal framework-building system, not a dashboard or an ordinary mind map. Its governing sequence is **定其位 → 联其缘 → 生其相 → 归其一**. Every interface and operation must help the user know where a piece of knowledge belongs, what it is connected to, what evidence supports it, and how it returns to the whole framework.

## Project specification

See [NEBULA Skill 1.0](docs/NEBULA-SKILL.md) for detailed product and implementation requirements.


### V4 三套新一轮结构方案（A > B > C）

本轮按用户确定的优先级推进：A 为主视觉与主体验，B 提供按需操作效率，C 提供纵向谱系阅读。三者仍为独立预览，不替换正式入口。

- **V4-A｜深空沉浸：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-a-deep-universe.html) · [源文件](ui-preview-v4-a-deep-universe.html) — 收起常驻侧栏与模块导航，三维空间成为主画面，保留轻量顶部命令与底部时间/定位控制。
- **V4-B｜轨道工作台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-b-orbit-workbench.html) · [源文件](ui-preview-v4-b-orbit-workbench.html) — 三维视口占据主体，左侧导航折叠为窄轨道，右侧检查器按需查看，操作围绕空间展开。
- **V4-C｜谱系透镜：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-c-lineage-lens.html) · [源文件](ui-preview-v4-c-lineage-lens.html) — 纵向知识树作为阅读主面，右上保留小型三维全局定位窗，兼顾局部结构与整体位置。

