# NEBULA 本地优先后台（当前采用方案）

NEBULA 采用 **Local-first**：不要求注册、登录、Clerk、Supabase、D1、R2 或百度网盘。知识图谱、原始讲义、AI 已学习对话分别保存在当前浏览器的 IndexedDB 独立对象库中。

## 文件
- `nebula-local.js`：本地数据层与讲义解析器。IndexedDB 使用 `lectureSources` 保存原始讲义，使用 `aiConversations` 保存 AI 已学习对话，二者独立读写；旧版 `references` 数据只作为兼容来源读取并迁移。
- `deepseek-worker.js`：可选的 DeepSeek 桥接服务，保留 DeepSeek 历史分享链接读取与历史内容分析，并新增 `POST /coach`（知识校正/四维/逻辑链）、`POST /mnemonic`（口诀核对）和 `GET /research?q=...`（Crossref 元数据检索）。它不存储知识库或讲义文件。
- `index.html`：当前 UI 与现有知识图谱逻辑。当前文件已有 LocalStorage 节点/关系保存，以及 IndexedDB 讲义原件保存逻辑；新数据层已单独准备，下一阶段接入 UI 时统一迁移并验证，不在这一步改动视觉界面。

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
- 浏览器清除站点数据、卸载浏览器或设备损坏可能导致本地数据丢失；应实现并使用知识库备份/恢复功能。
- 建议在首次保存时请求浏览器持久化存储权限；浏览器仍可能在磁盘空间不足时回收数据。
- 本地数据不会自动跨电脑同步。

## 浏览器文件夹授权
普通网页不能静默扫描电脑文件夹。后续 UI 可提供“选择讲义文件夹”入口，通过 File System Access API 在用户明确授权后访问文件夹；若浏览器不支持，则退回普通文件选择。文件夹持续监听、自动同步与后台扫描不属于当前静态网页后台能力。

## AI 与学术检索
- DeepSeek AI 通过 Worker Secret 保存 API Key；前端不得保存 DeepSeek API Key。
- 讲义/用户内容仅在用户点击分析时按需发送；需要在 UI 明示发送范围。
- 学术检索可通过 Crossref 等公开元数据服务完成，必须保留 DOI、作者、年份和来源链接；不能把元数据检索描述成论文全文下载。
- 语音识别、语音合成和图片 OCR 是独立的前端/浏览器能力，尚需在 UI 接入后逐项测试。

## 部署与下一步
本地知识库不需要部署任何账户或云数据库服务。DeepSeek Worker 若已部署，需将仓库新版 `deepseek-worker.js` 部署到原 Worker（保留原 Worker 名称与原有两个 secrets），即可启用新增 AI 端点。仓库的 `wrangler.toml` 仅部署无状态 DeepSeek Worker，不含 D1/R2。需要命令行部署时，在仓库目录执行：\n\n```bash\nnpx wrangler login\nnpx wrangler secret put DEEPSEEK_API_KEY\nnpx wrangler secret put NEBULA_SYNC_TOKEN\nnpx wrangler deploy\n```\n\n按提示填入你自己原有的密钥；不要把密钥发给我或写进仓库。若 Worker 已有同名 secrets，确认仍保留即可，不要为了重新部署而更换令牌。
