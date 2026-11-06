# 已弃用：NEBULA 云端私人账户后台

NEBULA 已根据产品决定改为本地优先模式。**不再要求 Clerk、Supabase、D1、R2、账户登录或百度网盘。**

请以新的架构说明为准：[LOCAL-FIRST-BACKEND.md](./LOCAL-FIRST-BACKEND.md)。

旧版 `api-worker.js`、`wrangler.toml` 和 D1 migration 已从主分支移除，避免误部署云端账户服务。现有 DeepSeek Worker 仅作为可选的 AI/历史导入桥接，不保存知识库和讲义原件。
