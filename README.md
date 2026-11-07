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

## Open the product and UI preview

- **Formal page:** [index.html](index.html) — existing production entry, not changed during the V17 preview work.
- **Latest independent UI preview V17:** [Open 观复 Mind preview](https://yijianvision-lgtm.github.io/yijian/ui-preview-v1.html).
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
- The V17 preview has not yet passed manual browser visual/interaction acceptance. Automated checks do not prove every real PDF/Word/EMMX/XMind file parses perfectly.
- The Worker is optional. If it is not deployed/configured, AI analysis reports an explicit configuration error; local rule-based filtering still works.
- The formal index.html has not been replaced by V17. The preview is the place to inspect and refine the new information architecture and visual language before any production migration.
- No automatic cloud sync, login requirement, or whole-library AI upload is introduced.

## Product direction

观复 Mind is a knowledge filtering and personal framework-building system, not a dashboard or an ordinary mind map. Its governing sequence is **定其位 → 联其缘 → 生其相 → 归其一**. Every interface and operation must help the user know where a piece of knowledge belongs, what it is connected to, what evidence supports it, and how it returns to the whole framework.

## Project specification

See [NEBULA Skill 1.0](docs/NEBULA-SKILL.md) for detailed product and implementation requirements.
