# 观复 Mind｜产品结构与后台实施蓝图
**版本：1.0｜日期：2026-11-07｜依据：GUANFU-MIND-DESIGN-CHARTER.md**

> 本文件把最高设计总纲转化为可实施的系统结构、数据职责、模块边界、阶段顺序和验收条件。它是实施蓝图，不代表文中所有目标能力已经完成。

## 1. 当前仓库审计结论

审计范围：README、index.html、nebula-local.js、deepseek-worker.js、现有 docs 与 backend tests。

### 已存在的技术基础（按仓库代码/文档）
- nebula-local.js 使用 IndexedDB，当前 DB_VERSION = 4，包含 graph、references、lectureSources、aiConversations、assets、meta、history、sources、nodeSourceLinks、knowledgeVersions、reviewProposals、learningRecords、researchSessions、knowledgeRelations 等对象库。
- 已有来源保存、节点-来源多对多链接、独立知识关系、版本快照、审核提案、学习记录、研究草稿等 API。
- 已有完整备份预览、完整性校验、恢复与合并能力；测试文件覆盖备份校验、合并/替换、来源关系和审核提案合并/拆分等场景。
- 已有 PDF、DOCX、DOC 原件保留、EMMX、XMind 解析入口；不同格式的结构保真度仍需真实样本逐一验收。
- deepseek-worker.js 已有 /health、/share、/analyze、/coach、/mnemonic、/research 路由。实际可用性仍取决于 Worker 部署、Secrets 和接口状态。
- index.html 已有真实 Three.js 主界面、四向面板、时间轴、逻辑视图和本地数据接入基础。

### 当前主要差距
1. 概念层：README 与旧文档仍有 NEBULA、认知驾驶舱等旧表述；观复 Mind 总纲应成为唯一最高原则。
2. 过滤流程：现有 API 分散存在，尚需统一的过滤任务/状态流，把提取、去重候选、归位、关联、证据验证、审核、框架更新串起来。
3. 节点定位：现有 graph 节点与关系基础不等于完整四维定位。谱系层级、时间坐标、空间/领域坐标、横向关系的语义与证据状态需要明确区分。
4. 树状框架：已有逻辑视图基础，但目标是可逐层进入的主干—分支—根系框架，并与三维空间双向联动，不是卡片列表或缩进清单。
5. 空间定位：需要统一当前路径、父级、同级、相邻关系和小地图状态；聚焦节点时不得丢失全局锚点。
6. 证据回溯：已有来源关联 API，但逐条证据查看、精确定位跳转、解析质量提示和缺失来源提示仍需前端整合。
7. AI 一致性：现有 Worker 教练提示词仍使用旧四向语义（前瞻/顾后/左顾/右盼）。需统一为四维定位：谱系纵向、时间、空间世界、横向关联；四向思考可作为交互表达，不替代四维定位。
8. 真实状态：必须区分代码存在、UI 已接入、服务已部署、端到端已验证四种状态。不能仅凭函数存在就标记功能已完成。

## 2. 总体系统分层

系统按依赖关系分为七层，而不是七个平行入口：

1. 原始输入与保全层：文件、对话、讲义、论文、笔记、图片；原件与提取文本分开。
2. 知识提取层：解析、切分、提取候选概念、命题、证据、事件和结构。
3. 知识过滤层（核心引擎）：去重候选、辨异、定其位、联其缘、证据核验、冲突识别、审核。
4. 个人框架层：用户确认的主干、分支、父子层级、横向关系与框架版本。
5. 认知空间层：真实 XYZ 宇宙、四维定位、小地图、聚焦镜头、时间与空间组织。
6. 调用与成长层：检索、研究、复述、测验、应用、迁移、输出。
7. 治理与保护层：本地优先、隐私授权、版本、撤销、备份恢复、解析与服务状态。

核心依赖链：

原始资料 → 提取候选 → 过滤任务 → 用户审核 → 正式知识/关系 → 个人框架 → 空间呈现与调用

任何 AI 结果都只能进入“提案/候选”状态，用户确认后才进入正式框架。

## 3. 统一工作流：一条知识如何进入框架

### A｜接收
- 创建 SourceRecord，保存原始 Blob、格式、文件名、指纹、导入时间、解析器版本。
- 原始资料独立于知识节点，禁止把提取结果写回覆盖原件。
- 显示导入状态：待解析、解析中、成功、部分成功、失败、需人工检查。

### B｜提取
- 提取文本、标题层级、思维导图主题树、图片/附件引用、页码/段落/主题路径。
- 产生 ExtractionBatch 与 ExtractionItem 候选；记录提取范围和解析警告。
- 候选项保留 sourceId、locator、excerpt、内容类型和质量信息。

### C｜辨异与去重
- 生成重复候选，不自动合并。
- 比较定义、语境、适用范围、来源、独有信息和冲突点。
- 用户可选择：合并候选、保持独立并建立关系、暂缓、标记非重复。
- 合并/拆分保留来源链接、历史版本、旧 ID 映射和可撤销记录。

### D｜定其位
- 提出所属框架、父级、同级、子级、谱系深度和候选位置。
- 若无法确定，进入“待定位”，不可随意塞入根节点或自动生成新主干。
- 位置建议需说明依据与来源。

### E｜联其缘
- 分别提出谱系纵向、时间、空间/领域、横向关联。
- 每条关系需有类型、方向、理由、证据来源、状态（confirmed / proposed / disputed / unknown）。
- 父子层级与多对多关系严格分开存储。

### F｜验证与审核
- 标注原文事实、多来源支持、AI 推论、争议和证据缺口。
- 创建 ReviewProposal，展示变更前后、理由、来源定位、不确定性。
- 用户可接受、编辑后接受、拒绝、暂缓、查看原文或恢复历史版本。

### G｜生其相与归其一
- 仅使用已确认节点/关系更新正式框架。
- 框架更新产生版本，保留上次框架快照。
- 检查新增知识对主干、分支和已有节点的影响。
- 任意节点都能回到父级路径、全局框架和原始来源。

### H｜调用输出
- 支持从框架中检索、组合、解释、研究、复述、写作和应用。
- 输出可回链到所用节点与证据来源，便于核对。

## 4. 核心数据模型增量

保留当前 schema v4 与旧 graph 兼容，采用渐进迁移，不做破坏性重建。

### 已有实体继续承担的职责
- KnowledgeNode：正式知识节点与主要父子层级。
- KnowledgeRelation：多对多横向/语义关系，不替代 parentId。
- SourceRecord：原始资料目录与文件元数据。
- NodeSourceLink：节点到来源片段的多对多证据链接。
- KnowledgeVersion：节点内容历史快照。
- ReviewProposal：AI 或导入产生的待审核变更。
- LearningRecord：学习/掌握表现。
- ResearchSession：研究草稿与研究过程。
- TimelineEvent：知识时间事件。

### 建议新增的实体
1. ExtractionBatch：id、sourceId、parserVersion、status、startedAt、completedAt、warnings、stats。
2. ExtractionItem：id、batchId、sourceId、locator、excerpt、candidateType、normalizedContent、quality、status。
3. FilterCase：id、inputItemIds、status、currentStage、createdAt、updatedAt。
4. FilterDecision：id、filterCaseId、decisionType（dedupe / classify / locate / relate / verify / accept / reject）、before、after、rationale、evidenceIds、actor、createdAt。
5. Framework：id、title、description、rootNodeIds、versionId、status、createdAt、updatedAt。
6. FrameworkVersion：id、frameworkId、snapshot、changeSummary、createdAt、createdBy。
7. NodePosition：nodeId、frameworkId、level、clusterId、semanticCoordinates、layoutCoordinates、layoutVersion。
8. RelationEvidence：relationId、sourceId、locator、excerpt、evidenceType、reviewStatus。

### KnowledgeNode 推荐增量字段
- frameworkIds：节点可参与多个框架。
- parentId：主要谱系父级，保持单一主路径（若未来要多父级，需另行建模，不能混用横向关系）。
- levelKey / levelDepth：层级标识与深度，避免只靠 UI 计算。
- domainIds / spatialContext：所属领域/空间世界。
- knowledgeTime：知识自身时间范围，未知可空。
- learningTime：用户学习/修订时间，独立记录。
- status：draft / active / needs_review / archived。
- originType：user / source_extraction / ai_proposal / import。
- confidence：仅表示用户确认或证据评估的明确定义，不得混同 AI 模型置信度。

### KnowledgeRelation 推荐增量字段
- type、directionality、rationale、status、evidenceIds、createdBy、createdAt。
- relation type 至少覆盖 causal、prerequisite、historical、contrast、analogy、application、supports、challenges、complements、cross_domain、related。
- 不允许以一条 relation 同时表达“父子层级”和“横向关联”。

### 四维定位的数据表达
四维不是强制每个节点都必须有四个坐标值，而是四类可逐步完善的关系集合：
- 谱系：parent/child/sibling 与路径。
- 时间：knowledgeTime、TimelineEvent 和时间关系。
- 空间世界：domain / context / world membership。
- 横向：KnowledgeRelation 多对多网络。

没有数据时明确标记“未知/待定位”，不伪造坐标或关系。

## 5. 核心服务边界

- Local Knowledge Store：IndexedDB 事务、schema migration、文件 Blob、版本、备份与恢复；UI 不直接操作对象库。
- Source Ingestion Service：文件类型识别、解析器路由、指纹去重、原件保全、解析质量和失败重试。
- Extraction Service：将来源转为 ExtractionBatch / ExtractionItem；不直接创建正式节点。
- Knowledge Filter Engine：候选比较、重复发现、归位建议、关系建议、证据核验、冲突检测与 FilterDecision 记录。
- Framework Service：正式框架版本、父子层级、根系/主干/分支路径、框架差异与撤销。
- Spatial Projection Service：从已确认框架与关系生成三维布局数据；布局坐标是可重算的投影，不是知识本体事实。手动调整坐标与语义位置分开保存。
- Evidence Resolver：从节点/关系解析到来源、原文摘录和文件定位；处理失效引用与缺失定位。
- AI Gateway：只把用户明确选中的最小必要内容发送给 Worker，校验响应结构，返回候选提案；不得直接写正式数据。
- Review Service：统一处理接受、编辑后接受、拒绝、暂缓、撤销和版本回滚。

## 6. 前端信息架构：层级而非并列功能

### 主入口：Mind
- 全局认知宇宙与当前聚焦点。
- 当前路径、层级、父级和小地图锚点。
- 四维定位/关联层。
- 从当前点进入其内部知识宇宙。
- 当前点的证据入口与待审核状态提示。

### 从 Mind 派生的工作层
- 框架：过滤后形成的树状逻辑主干、分支和根系；可逐层进入，与 Mind 双向联动。
- 资料：原始来源、解析状态、提取批次、证据定位。
- 研究：单点研究、多来源比较、证据缺口和研究草稿。
- 学习：主动回忆、复述、测验、应用、迁移与复习。
- 审核：所有知识变更建议的统一队列。

侧边栏默认收起。用户选择节点、进入某个任务或明确请求时再展开相关上下文，不常驻堆叠所有工具。

## 7. 视图之间必须共享的状态

建立单一 MindContext（名称可调整）：
- currentNodeId、currentFrameworkId、currentLevel
- ancestorPath、siblingNodeIds、selectedRelationIds
- activeDimension、currentSourceLocator、focusMode
- cameraPose、spatialProjectionVersion

Mind、Framework、Source、Review 等视图都从同一状态读取/更新。切换视图不得丢失当前节点、路径和过滤任务上下文。

## 8. 实施优先级与里程碑

### P0｜统一规范与状态
- 所有文档将“观复 Mind”设为产品身份；“驾驶舱”降级为旧称/历史管理入口，不再作为北极星定位。
- 增加功能状态标记：代码已存在、UI 已接入、服务已部署、端到端已验证。
- 建立统一节点/关系/来源/框架术语表。
验收：新开发者只读 README 与最高总纲即可理解产品定位和规范优先级。

### P1｜过滤任务闭环（最高开发优先级）
- ExtractionBatch / ExtractionItem / FilterCase / FilterDecision。
- 候选去重、差异比较、定位、关联、证据核验、审核。
- 用户确认后才更新正式 KnowledgeNode / KnowledgeRelation / Framework。
- 每一步可追溯、可撤销。
验收：导入一份资料，能从原件看到提取候选、重复差异、候选归位、关联依据、审核结果，并在确认后进入框架。

### P2｜框架与空间定位联动
- Framework / FrameworkVersion。
- 清晰的主干、分支、根系和逐层进入。
- MindContext、小地图、父级路径、相邻节点。
- 逻辑框架与三维投影共享数据。
验收：从三维点进入框架对应层级，再从树状节点返回三维同一焦点；路径和层级一致。

### P3｜证据回溯完整闭环
- 逐条证据查看器、原文定位、来源健康检查。
- 支持 PDF 页码、Word 段落、EMMX/XMind 主题路径。
- 来源失效、解析不完整、证据冲突均有明确状态。
验收：任意已确认节点和关系都能查看其依据；来源定位缺失时明确告知，不伪造定位。

### P4｜AI 四维过滤与审核
- 更新 Worker 提示词和 JSON Schema。
- 四维字段固定为谱系、时间、空间、横向关联。
- AI 输出事实/推论/不确定性/证据缺口/待确认问题。
- ReviewProposal 接受后才写入正式框架。
验收：AI 可以提出准确可解释的定位/关联建议，但不能未经确认改变正式框架。

### P5｜调用、学习与输出
- 从框架检索并组合知识。
- 主动回忆、复述、应用和迁移记录。
- 输出内容能回链到节点与证据。
验收：用户可以从个人框架中提取一组知识，生成解释或输出，并检查来源依据。

## 9. 不得违反的工程约束

- 继续 Local-first，不引入登录、Clerk、Supabase、D1、R2 或自动云端整库同步，除非用户未来明确改变决定。
- 不改正式网页/预览 UI，除非任务明确授权。
- schema 变更必须有向前迁移、旧数据兼容和备份回滚方案。
- 原始资料不覆盖；去重不删除来源；关系不与层级混淆。
- AI 只生成提案；正式数据由用户确认。
- 所有跨视图操作共享同一 nodeId / frameworkId / path。
- 不能把布局坐标当成知识位置；空间布局是语义结构的投影。
- 不得把模型生成的猜测伪装成来源事实。
- 不得宣称未部署、未联调、未验收的能力已经可用。

## 10. 开发任务拆分建议

建议后续以小批次 PR/commit 推进：
1. 术语与状态统一（文档、UI 文案、类型定义）。
2. 过滤任务数据模型与迁移测试。
3. Source Ingestion → ExtractionBatch 流程。
4. FilterCase/FilterDecision 与审核闭环。
5. Framework Service 与版本化树状结构。
6. MindContext 与双向视图联动。
7. Evidence Resolver 与原文定位 UI。
8. AI Gateway Schema 与四维教练。
9. 学习/研究调用与输出回链。

每批提交必须包含：变更文件、数据迁移影响、测试结果、未完成项和真实验证范围。
