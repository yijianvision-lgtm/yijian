# GUANFU MIND｜核心架构实施记录

**日期：2026-11-08｜基准：GUANFU MIND 设计纲领 V1.1**

本文记录已经进入仓库并通过自动化测试的架构改动。状态仅代表代码与测试证据，不代表正式产品整体完成。

## 本轮已实施

### 1. IndexedDB schema v6：新增独立上下文与路径记录

在不删除、不覆盖既有记录的前提下，将本地数据库从 v5 升级到 v6，新增：

- `frameworkPlacements`：知识对象在特定框架中的上下文位置。同一个 nodeId 可以拥有多个 placement；placement 的父子关系使用 parentPlacementId，不写回知识对象 parentId。
- `explorationPaths`：一次独立探索路径，记录根对象、框架上下文、分叉来源和当前步骤。
- `explorationSteps`：路径中的每次抵达，分别记录 fromNodeId、toNodeId、四向 direction、可选 relationId、证据引用和局部上下文。不同路径可以抵达同一稳定 nodeId。

旧 v5 备份仍可预览和恢复；新备份 schemaVersion 为 6，包含新增 stores。升级只新增 object stores，不自动重写用户现有知识数据。

### 2. 框架树不再必须依赖全局 parentId

- 新增框架位置创建、查询、更新、删除 API。
- 新增显式 `migrateLegacyFrameworkPlacements(frameworkId)`：将旧 parentId 树投影为待审核的框架位置；不会静默迁移，也不会更改节点 parentId。
- 当框架存在独立 placement 时，`getFrameworkTree()` 使用 placement 组织展示；没有 placement 时，明确返回 legacy fallback 标记。
- 一个知识对象可以在同一框架拥有多个上下文位置，稳定对象身份仍只有一个。

### 3. 探索路径真正独立持久化

- 新增路径创建、步骤追加、路径列表、步骤列表、分叉和路径快照 API。
- 每个步骤校验四向值、起点/终点对象、路径内父步骤和可选关系端点。
- `getMindContext({pathId})` 可从当前路径步骤解析当前焦点和完整抵达上下文，不再只能依赖旧 parentId 祖先链。
- 路径分叉创建新路径，根对象复用原稳定知识 ID，不复制知识对象。

### 4. 关系语义与证据状态

- 关系记录新增规范 `relationType` 与 `status`。
- 支持时间顺序、影响/因果、组成、材料、创作者、同时代、语境、对照、互补、类比和一般关联等类型。
- 新的显式 relationType 必须属于类型表；旧系统的自由文本 type 保留在 `legacyRelationType`，并降级为 `unclassified`，不会被假装成已确认语义。
- 状态为 confirmed 的关系必须记录 confirmedBy。
- 用户接受关系提案时，统一经过 `saveKnowledgeRelation()` 的校验路径。

### 5. 全局定位与空间投影

- `getSpatialProjection()` 明确是投影视图，不会创建知识关系。
- 谱系优先读取独立 placement；旧 parentId 仅作为带 `legacyProjection` 和 `needsReview` 的兼容投影。
- 时间只读取显式 knowledgeTime/date。
- 空间／世界只读取显式 spatialContext/location/geography，不再把 domain/domainPath 当作物理空间。
- 横向关系通过已记录的 relation IDs 表达。
- XYZ layoutCoordinates 与语义定位字段分开。

### 6. 版本快照完整性

`saveNodeVersion()` 不再只比较有限字段白名单，而是比较完整节点快照，避免新增语义字段变更没有版本记录。

### 7. 合并与拆分的路径完整性

- 合并时同步重映射框架位置、探索路径根、路径步骤起终点、学习记录和节点位置。
- 被合并的原始 nodeId 以 originalNodeId / originalFromNodeId / originalToNodeId 等字段保留审计来源。
- 同一对象在多个框架中的不同 placement 不被折叠成一个。
- 拆分节点带有 splitGroupId、splitOriginNodeId 和 splitIndex；原有路径和框架位置继续指向保留原 ID 的首个对象，不擅自复制到所有拆分对象。

## 测试证据

已扩展 IndexedDB runtime tests，覆盖：

- 从旧 v4 数据库升级到 v6 后，既有图谱和来源数据仍保留；
- 同一知识对象可有多个框架 placement，且不改写其 parentId；
- 两条不同探索路径可抵达同一个知识对象而不复制对象；
- 路径分叉和 path-aware mind context；
- 谱系/时间/空间/横向定位分离，domain 不会冒充空间；
- 未知旧关系类型被降级为 unclassified 并保留原标签；
- 合并后路径、placement 和原始身份可追溯；
- 拆分后路径仍指向保留身份并保留 split group；
- 非旧字段白名单中的节点属性变更会产生新版本；
- schema v6 完整备份可预览。

本轮 GitHub Actions 的 NEBULA backend checks 已通过；NEBULA local backend validation 已通过。Pages/Jekyll 部署须以各自最新运行状态为准。

## 仍未完成（不得宣称完成）

1. 正式 UI 尚未全面改为使用 placement/path API；现有旧页面部分仍使用 parentId。
2. 旧数据 placement 迁移目前是显式待审核工具，尚未完成用户数据迁移演练。
3. 关系类型表还需要细化端点角色、方向约束、因果证据标准和证据充分性校验。
4. 关系证据与来源定位还需统一到完整 EvidenceSpan 模型；当前复用既有 source / locator / relationEvidence 结构。
5. merge/split 仍跨多个 IndexedDB 操作，尚未重构为单一原子事务或可恢复操作日志；生产数据上仍需谨慎。
6. EMMX/XMind 图片、层级、关系保真和 PDF OCR/DOC 解析仍未完成。
7. 尚无真实浏览器 E2E、多设备数据完整性和长期压力测试。
8. 尚未接入账号、跨设备私有同步；这不在 Local-first V1 本轮范围内。

## 相关实现提交

- `987cb581`：schema v6、新增 placement/path stores 和 API
- `62836765`：旧关系标签的安全降级
- `e6486455`：语义投影分离、关系写入校验
- `b95e9b37`：placement-aware framework tree
- `8195fccd`：稳定知识 ID 的空间投影
- `88226bf8`：path-aware mind context 和分支连续性校验
- `855d4c3d`：合并/拆分时的路径与上下文引用保留
- `c1fa6b05`：新增合并/拆分的 runtime 测试
- `6df42cc4`：修正测试断言

**结论：** 本轮完成了多路径、框架上下文、语义关系和投影分离的第一层数据架构基础；尚未完成 UI 全面接线、迁移演练和正式数据安全验收。
