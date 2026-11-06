# NEBULA 私人账户后台基础设施（准备阶段）

本目录新增的是后台基础，不修改现有 index.html，也不会改变当前线上 UI。

## 已准备的能力
- OIDC JWT 身份验证：使用身份服务签发的 RS256 access token；校验签名、issuer、audience、有效期和 subject。
- D1 私有知识存储：每条数据以 owner_id 隔离。
- R2 私人资料存储：对象键以已验证的 owner_id 隔离，读取/删除前先检查 D1 所有权。
- 客户端加密存储约定：知识 payload 与原始文件必须在浏览器加密后上传；Worker 不持有解密密钥。
- AI 知识判断接口：将用户问题、讲义文字/图片 OCR 结果和已有知识上下文作为临时请求发给 DeepSeek；不写入数据库。
- 文献检索接口：先接 Crossref 元数据检索，返回 DOI、作者、年份和原文链接。
- 每个私有 API 请求都要求账户 access token；不接受前端传来的 owner_id 作为权限依据。

## 尚未启用的内容（不要误认为已经上线）
- 尚未选择/创建 OIDC 登录服务，尚未配置账户注册与找回密码。
- 尚未创建 Cloudflare D1 / R2 资源，也未绑定到 Worker。
- 尚未配置域名、Worker route、CORS 与身份服务参数。
- 现有 GitHub Pages 是静态站点；单靠 GitHub Pages 不能提供私有账户登录和数据访问控制。
- 本阶段没有修改旧 Worker 或前端，避免在 UI 方案确定前反复改动。

## 部署前需要配置
1. 选择 OIDC 身份服务（例如 Auth0、Clerk 或其他兼容 RS256/JWKS 的 OIDC 提供方），配置 issuer、audience、JWKS URL。
2. 创建 D1 数据库并执行 `migrations/0001_private_data.sql`。
3. 创建 R2 bucket 并绑定为 `PRIVATE_FILES`。
4. 将本文件 `api-worker.js` 部署为独立 Worker，绑定 D1 为 `DB`、R2 为 `PRIVATE_FILES`。
5. 设置 Worker secrets：`OIDC_JWKS_URL`、`OIDC_ISSUER`、`OIDC_AUDIENCE`、`DEEPSEEK_API_KEY`；设置变量 `ALLOWED_ORIGIN`。
6. 登录 UI 确定后，再将 OIDC token 注入 API 请求，并实现 WebCrypto AES-GCM 文件/知识加密、解密与密钥恢复方案。

## API
- `GET /v1/me`
- `GET /v1/knowledge`
- `PUT /v1/knowledge` body: `{id, encryptedPayload}`
- `GET /v1/references`
- `POST /v1/references` body: `{id,name,mime,size}`
- `PUT /v1/references/:id/file` 上传加密文件二进制
- `GET /v1/references/:id/file` 下载加密文件二进制
- `DELETE /v1/references/:id`
- `POST /v1/ai/analyze` body: `{userInput,sourceText,context}`
- `GET /v1/research?q=...` Crossref 检索

百度网盘：后续只接受用户主动提供的 pan.baidu.com 分享 URL，并且只读取该分享链接明确授权的文件。不会请求百度网盘账号密码、Cookie，也不会扫描整个网盘。是否能自动解析取决于百度网盘公开分享访问机制和合法 API 能力；当前不宣称已接通。

语音：语音识别/播放优先在前端调用浏览器或明确授权的语音服务；转录文本进入 `/v1/ai/analyze`。不会默认保存原始录音。
