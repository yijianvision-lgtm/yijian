# NEBULA × DeepSeek 同步方案

## 目标
保留 DeepSeek 网页版原有工作方式，同时把历史对话尽可能迁移到 NEBULA；以后可把选定对话/笔记导出后批量分析入库。

## 重要边界
- NEBULA 不能通过 DeepSeek 分享链接自动读取用户账号下的全部私有历史记录，也不能安全地用用户名、密码、Cookie 登录抓取。
- DeepSeek API 与 DeepSeek 网页聊天历史不是同一个数据接口；API 不会自动枚举网页版历史会话。
- 历史迁移需要用户从 DeepSeek 官方产品可用的导出/分享/复制功能取得数据，再将导出文件交给 NEBULA。若官方提供完整数据导出，优先用完整导出；否则分批导出重要对话。
- 新对话可以继续在 DeepSeek 网页版进行，结束后导出/复制需要沉淀的对话；将来若 DeepSeek 提供授权连接器/API，可再做自动同步。当前不宣称后台自动监听 DeepSeek 网页对话。
- API Key 只能存 Worker Secret，绝不写入 index.html、浏览器 LocalStorage 或 GitHub 仓库。

## 已提供的桥接 Worker
文件：`deepseek-worker.js`
1. 在 Cloudflare 创建 Worker，将该文件作为 Worker 源码部署。
2. 在 Worker Settings → Variables and Secrets 添加 Secret：`DEEPSEEK_API_KEY`。
3. 可选添加变量 `DEEPSEEK_MODEL`，默认 `deepseek-v4-pro`。
4. Worker 提供 `POST /analyze`，接收 `{ text, existingNodes }`，返回结构化 nodes、links、mergeSuggestions、uncertain。
5. 仅允许从可信来源调用时，应把 Worker 的 CORS 白名单从 * 改为 NEBULA 实际域名，并增加访问令牌/用户鉴权。生产环境不应长期使用开放 CORS。

## 历史对话迁移流程
1. 在 DeepSeek 中使用官方可用的数据导出功能；若没有完整导出，逐批分享/复制知识对话。
2. 保存为 JSON、Markdown 或 TXT。
3. 在 NEBULA 的 DeepSeek 同步中心上传；先分析预览，查看重复合并建议、层级与来源。
4. 你确认后才写入节点。原文作为来源保留，AI 推断标记为待确认。
5. 分批处理长档案，避免一次请求超出上下文或 Worker 请求限制。

## 当前状态
- 已准备 Worker 源码和部署说明。
- GitHub Pages 是静态托管，不会自动运行 Cloudflare Worker；Worker 必须单独部署后才能调用。
- 尚未替用户部署 Worker、创建 API Key 或访问 DeepSeek 账号。
- 不能保证完整历史一次性自动导入；迁移范围取决于 DeepSeek 实际提供的导出能力和导出文件内容。
