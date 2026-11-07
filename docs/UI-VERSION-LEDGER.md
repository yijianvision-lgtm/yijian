# MIND UI 版本台账｜按真实提交和状态分类

**审计日期：2026-11-08**  
**当前用户选择：V3-A 纯宇宙画布作为主视觉方向。**  
**注意：版本编号是历史标签，不代表知识模型版本，也不代表用户验收。**

## 1. 最早原型（2026-11-06）

| 时间（UTC） | 文件 | 主要内容 | 当前状态 |
|---|---|---|---|
| 08:43 | `个人知识网络.html` | 二维 SVG 节点图、四向文本、手动双向关联、节点编辑、JSON 导入导出、localStorage | 原件只读归档 |
| 08:50 | `星图知识宇宙_深色3D原型.html` | 深色 Canvas/WebGL 星点、旋转缩放、节点浮层、时间轴、四向思考、编辑与 JSON | 原件只读归档 |
| 08:55 | `NEBULA_真正三维知识宇宙.html` | 早期完整三维知识宇宙交互原型 | 原件只读归档 |

归档目录：`archive/early-prototypes/`。以上为早期原型，不是生产版本，不得覆盖。

## 2. V1｜从视觉原型演进为综合工作台

初始提交：
- `baaa4d24b570a8fd5320faa441f1e0f2353e256f` — 2026-11-06 18:55 UTC，创建 NEBULA UI preview V1。

关键历史节点（按时间）：
- `e62ee41dbf` — 修复 Three.js 浏览器模块解析。
- `df8749a867` — 节点缩小、专属入口屏。
- `aed5fd17ec` — 主空间视觉、嵌套层级导航。
- `b92933dc65` — 对齐 local-first 架构。
- `25a1af4181` — 扩展为认知 OS 工作区。
- `8f5537a950` — 层级导航与节点详情。
- `79a3bf1be0` — 资料导入与本地备份。
- `6990e9290f` — AI 审核中心、证据差异与可逆操作。
- `1203b78797` — 以坐标轴为中心的连续四向探索。
- `d240d2a218` — 连续知识导航与聚焦核心。
- `b95e620569` — 全屏聚焦，四向内容作为幽灵式漂浮区域。
- `4a5bef548b` — 聚焦序列、象限可读性和方向路径。
- `b68b6b33d1` — 白色微光、知识点缩小。
- `7faa07a49d` — 稳定方向、微弱白光、3D 相机旋转。
- `33561f9421` — 2026-11-07 08:04 起，转为观复 Mind 空间知识工作台。
- `bccf722477` — 本地图谱接入空间预览。
- `d49d1ace54` — 四维定位与持续空间方向。
- `f8b520ea17` — 接入真实框架投影。
- `47b1611d99` — 调整四维导航语义。
- `8bcdcf5c62` — DeepSeek JSON 导入和对话来源。
- `7aae1cd983` — 实时框架图投影并隔离演示宇宙。
- `bde845b18e` — 移除虚构的 Dashboard/Research/Learning/Review 内容。
- `89ebdf6b41` — 禁止演示宇宙合成后续节点。
- `f7df96683d` — 节点详情来源证据接入。
- `8ae9bbbda6` — 3D 焦点同步树状路径。
- `57d253430d` — 总览树读取真实本地图谱。
- `a27a70485f` — 来源分类真实过滤，禁止推断空间关联。
- `bcd4b32ee9` — 中心微光柔化。
- `c0d2aa6685` — 深空层次与安静 UI。
- `3c9289ca3d` — 选择精度、减少动态偏好、响应式渲染。

**判断：** V1 后期混合了视觉原型、真实本地数据接入、资料工作流和多模块交互，不能当作纯 UI 版本比较。V1 的每个历史提交也不是互相独立的完整产品方案。

## 3. V2–V5｜同一交互内核上的布局候选

| 版本 | 页面 | 首次创建（UTC） | 状态/说明 |
|---|---|---|---|
| V2-A | `ui-preview-v2-a-immersive.html` | 11-07 13:16 | 静域沉浸版；当前 main 有文件 |
| V2-B | `ui-preview-v2-b-bridge.html` | 11-07 13:16 | 认知舰桥版；当前 main 有文件 |
| V2-C | `ui-preview-v2-c-lineage.html` | 11-07 13:16 | 谱系导航版；当前 main 有文件 |
| V3-A | `ui-preview-v3-a-cosmos.html` | 11-07 13:38 | 纯宇宙画布；用户当前选择；当前 main 有文件 |
| V3-B | `ui-preview-v3-b-command.html` | 11-07 13:38 | 认知控制台；当前 main 有文件 |
| V3-C | `ui-preview-v3-c-lineage.html` | 11-07 13:38 | 纵向谱系工作台；当前 main 有文件 |
| V4-A | `ui-preview-v4-a-deep-universe.html` | 11-07 13:55 | 深空沉浸；当前 main 有文件 |
| V4-B | `ui-preview-v4-b-orbit-workbench.html` | 11-07 13:55 | 轨道工作台；当前 main 有文件 |
| V4-C | `ui-preview-v4-c-lineage-lens.html` | 11-07 13:55 | 谱系透镜；当前 main 有文件 |
| V5-A | `ui-preview-v5-a-deep-cosmos.html` | 11-07 14:18 | 深空宇宙；当前 main 有文件 |
| V5-B | `ui-preview-v5-b-orbit-control.html` | 11-07 14:18 | 轨道控制；当前 main 无文件，已归档 |
| V5-C | `ui-preview-v5-c-lineage-depth.html` | 11-07 14:18 | 谱系纵深；当前 main 有文件 |

### V3-A 的真实身份

- 创建 commit：`8220c6c8a43791fec1756f17fc8cd3cc87b31a2f`。
- 它是从后期 V1 页面衍生的画布优先布局候选。
- 与当时 V1 的六段主要 JavaScript 一致，主要差异集中在样式/布局层。
- 因此 V3-A 是视觉方向选择，不是新的知识模型，也不是 2026-11-06 早期 WebGL 原件。
- 用户当前选择 V3-A，不代表已经验收其所有控件、知识结构或后台行为。

### V4-A 后续实验

`ui-preview-v4-a-plus-corner-map.html` 是额外实验文件，不能混成 V4-A 原稿；用户已经否决把 V4-A+角落地图作为默认恢复目标。保留历史记录，不再作为当前方向。

## 4. V6–V9｜撤回或未确认的实验

| 版本 | 历史文件 | 状态 | 处理 |
|---|---|---|---|
| V6-A | `ui-preview-v6-a-deep-cosmos.html` | 已不在 main | 原样归档到 `archive/withdrawn-ui/` |
| V6-B | `ui-preview-v6-b-orbit-workbench.html` | 已不在 main | 原样归档 |
| V6-C | `ui-preview-v6-c-lineage-navigation.html` | 已不在 main | 原样归档 |
| V7-A | `ui-preview-v7-a-learning.html` | 11-07 16:08 撤回 | 原样归档；不得重新作为当前正式预览 |
| V8 | 未发现可核实的 UI 文件或创建提交 | 未知/缺失 | 不补造版本，不按编号推断 |
| V9-A | `ui-preview-v9-a-four-quadrant-tree.html` | 11-07 撤回 | 原样归档 |
| V9-B | `ui-preview-v9-b-framework.html` | 11-07 撤回 | 原样归档 |
| V9-C | `ui-preview-v9-c-network.html` | 11-07 撤回 | 原样归档 |

V7-A 的撤回提交：`bf026fad9038588862682b94c8fd8d9b1a316fd4`。  
V9-A/B/C 的撤回提交：`7432eda22b7c94f5981cb42fedb3372ea1adacbc`、`b8c74e81c010896d88b4e7713e2b5ac6faad8b07`、`cb4eab92e41de335b6e4d0607edadef127bf1afc`。

归档不等于重新启用；撤回原因和用户否决必须保留。

## 5. 当前可浏览的 main Pages 候选

以下页面随 main commit `295ef34a913601ea31779c292064c372d0c03bf3` 的 Pages 部署成功发布：
- V3-A：`https://yijianvision-lgtm.github.io/yijian/ui-preview-v3-a-cosmos.html`
- V2/V3/V4/V5-A/C 目录：`https://yijianvision-lgtm.github.io/yijian/ui-preview-gallery.html`

这只证明静态 Pages 部署完成；不证明浏览器端交互和用户验收。恢复分支的 archive 文件未部署。

## 6. 当前版本管理规则

- 早期原型：只读 archive，不覆盖。
- 当前 main 的 UI preview：仅供候选对比，不是正式入口。
- 用户当前方向：V3-A。
- 撤回实验：只读 archive，不重新放回根目录。
- 未发现的版本：明确标为未知，不补造。
- 每次新迭代：新增唯一文件名、单独 commit、变更说明、测试结果、部署结果和回滚点。
- 视觉版号、知识模型版号、数据库 schema 版号、CI 版本各自独立，不能共用一个 Vx 标签。
- 未经用户明确验收，任何候选不得标为最终设计。
