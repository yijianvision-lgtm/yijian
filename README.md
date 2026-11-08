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


### V7-A｜深空主线 · 对话学习与连续四向延伸（当前迭代）

当前只沿 A「深空纯宇宙」继续迭代，不再制作新的 B/C 方案。V7-A 保留 V6-A 的画布优先布局、角落默认小地图与明确的左右面板入口，并集中处理三项体验：

- **学习页 AI 对话：** 学习页加入一对一对话工作区，可切换综合理解、瞻前、顾后、左顾、右盼五种学习视角；仅在用户主动选择后附带当前知识节点；对话可由用户保存到本机资料库，不会自动修改正式知识。
- **四向视野排布：** 四向文字固定在右侧上方的独立区域，中央核心知识不再与左右文字叠压。
- **连续方向延伸：** 方向文字保持稳定，连续流动效果只出现在四向路径上，避免标签散动。

AI 对话使用新增的 Cloudflare Worker `POST /chat`，要求服务端配置 `DEEPSEEK_API_KEY` 与 `NEBULA_SYNC_TOKEN`；网页只在当前页面内存中使用访问令牌，不存储模型 API 密钥。Worker 部署更新后才可进行真实 AI 对话。该版本为独立预览，不替换 `index.html`，不接入正式后台。

- **[打开 V7-A 学习对话预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v7-a-learning.html)**
- [GitHub 源文件](ui-preview-v7-a-learning.html)

### V6 三套完整交互预览（本轮修订）

V6 根据验收意见重新处理地图默认状态与面板可发现性：小地图首次进入默认停靠角落，仍可选择关闭、侧边或展开；导航与知识详情始终有清晰入口。A 采用画布优先与可见边缘入口，B 采用完整可读的轨道工作台，C 采用纵向谱系导航与知识详情并置。三版为独立预览，不替换正式入口或接入正式后台。

- **V6-A｜深空主画布：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v6-a-deep-cosmos.html) · [源文件](ui-preview-v6-a-deep-cosmos.html) — 三维画布优先，左右面板按需展开，但顶部与屏幕边缘均有明确入口。
- **V6-B｜轨道操作台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v6-b-orbit-workbench.html) · [源文件](ui-preview-v6-b-orbit-workbench.html) — 导航恢复完整文字标签，右侧检查器信息更完整，适合高频操作。
- **V6-C｜谱系导航层：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v6-c-lineage-navigation.html) · [源文件](ui-preview-v6-c-lineage-navigation.html) — 左侧纵向谱系成为明确导航骨架，右侧知识详情保持可见。

### V5 三套重新设计方案（默认不显示小地图）

V4 的 A/B/C 已全部否决；V5 不沿用其布局作为选择结论。三版均把小地图移出常驻信息面板，首次进入默认关闭。顶部“地图”选择器可切换关闭、角落、侧边或展开；关闭按钮可随时收起。小地图仅在用户主动选择后出现。

- **V5-A｜深空纯宇宙：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v5-a-deep-cosmos.html) · [源文件](ui-preview-v5-a-deep-cosmos.html) — 隐去常驻左右面板，最大化三维宇宙画布。
- **V5-B｜轨道轻控台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v5-b-orbit-control.html) · [源文件](ui-preview-v5-b-orbit-control.html) — 左侧收敛为窄导航，右侧保留轻量知识检查器。
- **V5-C｜谱系纵深：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v5-c-lineage-depth.html) · [源文件](ui-preview-v5-c-lineage-depth.html) — 保留纵向知识入口与结构导航，让谱系成为辅助层而非主画面。

三版复用现有 Three.js 场景、节点交互与本地数据逻辑，主要重新组织布局和小地图交互，不代表三套独立引擎或后台已完成。仅为独立预览，未替换正式首页、未接入正式后台。

### V4 三套新一轮结构方案（A > B > C）

本轮按用户确定的优先级推进：A 为主视觉与主体验，B 提供按需操作效率，C 提供纵向谱系阅读。三者仍为独立预览，不替换正式入口。

- **V4-A｜深空沉浸：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-a-deep-universe.html) · [源文件](ui-preview-v4-a-deep-universe.html) — 收起常驻侧栏与模块导航，三维空间成为主画面，保留轻量顶部命令与底部时间/定位控制。
- **V4-B｜轨道工作台：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-b-orbit-workbench.html) · [源文件](ui-preview-v4-b-orbit-workbench.html) — 三维视口占据主体，左侧导航折叠为窄轨道，右侧检查器按需查看，操作围绕空间展开。
- **V4-C｜谱系透镜：** [打开预览](https://yijianvision-lgtm.github.io/yijian/ui-preview-v4-c-lineage-lens.html) · [源文件](ui-preview-v4-c-lineage-lens.html) — 纵向知识树作为阅读主面，右上保留小型三维全局定位窗，兼顾局部结构与整体位置。



## MIND V3.1｜最新架构审议与设计任务书

- [V3.1 正式架构审议变更清单](docs/MIND-V3.1-ARCHITECTURE-DECISIONS.md) — 逐项记录 13 项 old / merge / new / later 决定及本轮边界。
- [V3.1 统一产品架构与 UI 设计任务书](docs/MIND-DESIGN-TASKBOOK-V3.1.md) — 先统一架构，再进入 UI 设计。
- [最高设计总纲](docs/GUANFU-MIND-DESIGN-CHARTER.md) — 已增加 V3.1 用户审议决议。

**当前状态：文档已提交；架构统一阶段待审阅。未修改网站代码、UI、数据库或后台，也未启动 UI 改版。**
