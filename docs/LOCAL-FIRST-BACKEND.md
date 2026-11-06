# NEBULA 本地优先后台（当前采用方案）

NEBULA 采用 **Local-first**：不要求注册、登录、Clerk、Supabase、D1、R2 或百度网盘。知识图谱、原始讲义、AI 已学习对话分别保存在当前浏览器的 IndexedDB 独立对象库中。

## 文件
- `nebula-local.js`：本地数据层与讲义解析器。IndexedDB 使用 `lectureSources` 保存原始讲义，使用 `aiConversations` 保存 AI 已学习对话；schema v4 另含 `sources`、`nodeSourceLinks`、`knowledgeRelations`、`knowledgeVersions`、`reviewProposals`、`learningRecords`、`researchSessions`，分别承担来源目录、节点证据链接、横向关系、知识版本、AI 审核队列、学习记录与研究草稿。旧版 `references` 数据继续兼容读取。
- `deepseek-worker.js`：可选的 DeepSeek 桥接服务，保留 DeepSeek 历史分享链接读取与历史内容分析，并新增 `POST /coach`（知识校正/四维/逻辑链）、`POST /mnemonic`（口诀核对）和 `GET /research?q=...`（Crossref 元数据检索）。它不存储知识库或讲义文件。
- `index.html`：现有 UI 与知识图谱逻辑。节点/关系仍兼容旧 LocalStorage，同时保存到 IndexedDB；原有“导出 JSON”入口已改为导出完整本地备份，原有 JSON 导入入口识别完整备份并提供覆盖恢复确认，不改变整体视觉布局。

## 支持的讲义类型
| 格式 | 本地处理方式 | 说明 |
|---|---|---|
| PDF | PDF.js 提取逐页文字 | 原 PDF Blob 同时保留；扫描件需 OCR |
| Word DOCX | Mammoth 提取文字与 HTML | 尽量保留段落/表格 HTML；原文件保留 |
| Word DOC | 原件保存 | 旧二进制格式建议另存 DOCX/PDF 后提取 |
| EdrawMind EMMX | 解压 XML 提取文本线索 | 原件完整保留；复杂结构需按实际文件格式适配 |
| XMind | 解析 content.json / content.xml 主题 | 原件完整保留；不同版本格式需样本验证 |

## 本地数据与隐私
- 原始讲义库：原文件 Blob、提取文本、页面索引、主题树和解析提示保存在 `lectureSources`。
- AI 已学习对话库：原始对话文本、来源/文件名、导入时间及 AI 分析结果保存在 `aiConversations`。
- 两个库独立保存；知识节点可以引用两个库的来源，但 AI 分析不得覆盖原始讲义。录入文件时先选择目标库。
- 不会上传讲义或知识库到 NEBULA 服务器。
- 只有用户主动触发 AI 分析/DeepSeek 历史导入时，所选文字才会发送到已配置的 DeepSeek Worker。
- 浏览器清除站点数据、卸载浏览器或设备损坏可能导致本地数据丢失；现已提供完整 JSON 备份与恢复，包含图谱、关系、讲义 Blob、AI 对话、来源目录、证据链接、审核记录、版本、学习记录与研究草稿。备份带 SHA-256 完整性校验；恢复前会校验并提示，默认覆盖当前本地数据。\n- 文件夹授权句柄不会写入备份；恢复后需要重新选择并授权讲义文件夹。\n- 备份包含原始文件，文件较大时会占用内存并生成较大的 JSON 文件；建议定期备份到用户自己管理的安全位置。
- 建议在首次保存时请求浏览器持久化存储权限；浏览器仍可能在磁盘空间不足时回收数据。
- 本地数据不会自动跨电脑同步。

## 认知数据模型（schema v4）\n- `sources` 将知识来源抽象成独立目录记录；上传讲义和 AI 对话时自动登记，旧资料会在本地启动时补建目录记录。\n- `nodeSourceLinks` 支持节点与来源多对多关联，可记录页码、段落、主题路径、摘录及证据类型。\n- `knowledgeRelations` 独立保存因果、对比、前置、类比、应用、证据支持/挑战等关系，不与父子层级混用。\n- `knowledgeVersions` 保存节点内容快照；`reviewProposals` 保存 AI 建议及审核状态。接受 update/reparent/create/relation 建议时才写入正式数据；merge/split 当前保留为待审核提案，因需要显式节点映射与来源迁移，暂不自动执行。\n- `learningRecords` 与 `researchSessions` 分别保存主动学习表现和研究草稿。\n- `findDuplicateCandidates()` 仅返回相似候选，不自动合并；重复判断必须由用户决定。相同内容的讲义文件与 AI 对话会通过 SHA-256 内容指纹拦截重复保存；语义相似但内容不同的资料仍作为候选，不自动合并。\n\n## 浏览器文件夹授权
普通网页不能静默扫描电脑文件夹。后续 UI 可提供“选择讲义文件夹”入口，通过 File System Access API 在用户明确授权后访问文件夹；若浏览器不支持，则退回普通文件选择。文件夹持续监听、自动同步与后台扫描不属于当前静态网页后台能力。

## AI 与学术检索
- DeepSeek AI 通过 Worker Secret 保存 API Key；前端不得保存 DeepSeek API Key。
- 讲义/用户内容仅在用户点击分析时按需发送；需要在 UI 明示发送范围。
- 学术检索可通过 Crossref 等公开元数据服务完成，必须保留 DOI、作者、年份和来源链接；不能把元数据检索描述成论文全文下载。
- 语音识别、语音合成和图片 OCR 是独立的前端/浏览器能力，尚需在 UI 接入后逐项测试。

## 当前已接入的本地后台 API\n- 完整备份：`exportFullBackup()`、`previewFullBackup()`、`restoreFullBackup()`。\n- AI 接口适配：`analyzeConversation()`、`coachKnowledge()`、`checkMnemonic()`、`searchResearch()`、`fetchDeepSeekShare()`；仅在显式调用时向 Worker 发送对应文本。\n- 来源内容：`getNodeEvidence()`、`getSourceContent()` 可从节点回溯来源及原始记录。\n- 来源与证据：`saveSource()`、`linkNodeSource()`、`listNodeSources()`、`listSourceNodes()`。\n- 关系：`saveKnowledgeRelation()`、`listKnowledgeRelations()`。\n- 审核与版本：`createProposal()`、`listProposals()`、`applyProposal()`、`listNodeVersions()`。\n- 学习与研究：`saveLearningRecord()`、`listLearningRecords()`、`saveResearchSession()`、`listResearchSessions()`。\n- 驾驶舱汇总：`getCognitiveDashboard()`。\n\n这些 API 已进入本地数据层，但相应审核面板、证据查看器、研究界面和学习训练 UI 尚未全部接入。\n\n## 部署与下一步
本地知识库不需要部署任何账户或云数据库服务。DeepSeek Worker 若已部署，需将仓库新版 `deepseek-worker.js` 部署到原 Worker（保留原 Worker 名称与原有两个 secrets），即可启用新增 AI 端点。仓库的 `wrangler.toml` 仅部署无状态 DeepSeek Worker，不含 D1/R2。需要命令行部署时，在仓库目录执行：\n\n```bash\nnpx wrangler login\nnpx wrangler secret put DEEPSEEK_API_KEY\nnpx wrangler secret put NEBULA_SYNC_TOKEN\nnpx wrangler deploy\n```\n\n按提示填入你自己原有的密钥；不要把密钥发给我或写进仓库。若 Worker 已有同名 secrets，确认仍保留即可，不要为了重新部署而更换令牌。
