# NEBULA 私人账户后台：部署与最简操作

当前代码已经放进仓库，但**尚未上线，也没有可供登录的账户**。必须先配置 Cloudflare 资源和 OIDC 登录服务。后台不依赖当前网页 UI；等 UI 方案确定后再接前端。

## 当前已具备的后台代码

- `api-worker.js`：独立 Worker API。
- `migrations/0001_private_data.sql`：D1 私人知识与讲义元数据表。
- `wrangler.toml`：Cloudflare 部署配置模板。
- `GET /v1/me`：验证登录身份。
- `GET/PUT/DELETE /v1/knowledge`：账户隔离的加密知识数据。
- `GET/POST /v1/references`：私人讲义元数据。
- `PUT/GET/DELETE /v1/references/:id/file`：私人加密文件。
- `POST /v1/ai/analyze`：知识正确性、精炼表达、四维分析、逻辑链。
- `POST /v1/ai/mnemonic`：口诀准确性与记忆优化建议。
- `GET /v1/research?q=...`：Crossref 论文元数据检索。

所有数据库查询都使用验证后的 OIDC subject 作为 owner_id。前端传入的 owner_id 不会被信任。知识和文件上传接口只接受加密后的 payload；解密密钥不应发送给 Worker。AI 分析是用户主动触发的临时外部请求，不写入本 Worker 的数据库。

## 还不能自动完成的事情

1. 尚未创建 Cloudflare D1 数据库和 R2 bucket。
2. 尚未选定并配置登录身份服务，因此没有真实用户注册/登录流程。
3. 尚未设置 Worker secrets，也未部署此 Worker。
4. 当前静态网页尚未连接这些接口；等 UI 方案到位后再接。
5. 图片视觉理解、PDF/Word/EMMX/XMind 文件解析、语音录入/朗读，需要前端导入与交互层实现。AI 接口已可接收 OCR/转录文字，但还没有图像/音频上传识别流程。
6. Crossref 是学术元数据检索，不等于全文下载或全网搜索。
7. 百度网盘尚未接入。当前方案只允许未来针对用户主动提供的单个分享链接授权读取，不扫描网盘，也不索取账号密码/Cookie；是否能自动读取取决于百度网盘当时提供的合法接口和分享访问规则。

## 最简单的部署步骤（需要用户本人操作一次）

### A. 建立登录服务
推荐使用 Clerk 作为账户登录服务（邮箱登录/验证码等由 Clerk 管理）。
1. 在 Clerk 创建一个应用。
2. 配置一个用于 NEBULA API 的 JWT 模板/受众，确保签发 RS256 access token，且 token 含有 `iss`、`sub`、`exp`、`aud`。
3. 记录 Issuer URL、JWKS URL、Audience。Issuer 必须与 token 的 `iss` 完全一致；Audience 必须与 token 的 `aud` 匹配。
4. 不要把 Clerk Secret Key 发给我或写进网页代码。此 Worker 只需要公开的 JWKS URL、Issuer、Audience。

### B. 建立 Cloudflare 存储
1. 登录 Cloudflare Dashboard。
2. Workers & Pages → D1 → Create database，名称填 `nebula-private`。
3. R2 → Create bucket，名称填 `nebula-private-files`。
4. 把 D1 页面提供的 database_id 填入仓库 `wrangler.toml` 的 `database_id`。

### C. 部署 Worker
在本地电脑安装 Node.js，再在仓库目录打开终端执行：
```bash
npm install -g wrangler
wrangler login
wrangler d1 migrations apply nebula-private --remote
wrangler secret put OIDC_JWKS_URL
wrangler secret put OIDC_ISSUER
wrangler secret put OIDC_AUDIENCE
wrangler secret put DEEPSEEK_API_KEY
wrangler deploy
```
每次 `secret put` 后，按提示粘贴对应值。DeepSeek API Key 只放 Worker Secret，不放网页前端。
部署成功后记下 Worker URL，并把它交给我，后续 UI 接口会连接该地址。

### D. 安全注意事项
- 只允许 GitHub Pages 当前域名访问浏览器 API；正式域名变更后再调整 ALLOWED_ORIGIN。
- R2 bucket 不得设置为公开访问。
- 不要把数据库、R2、身份服务的管理密钥写进仓库。
- 私人讲义和知识正文必须先由浏览器 WebCrypto 加密再上传。UI 接入时需要设计密钥生成、备份/恢复与跨设备解锁流程；没有恢复机制前不要上传唯一原件。
- 登录后每次请求都带身份服务签发的 Bearer access token。
- 目前不应把 Worker 地址当成“已经启用的私人云盘”；只有部署并完成安全测试后才可使用。

## API 请求约定

请求头：`Authorization: Bearer <OIDC access token>`。

知识保存示例：
```json
{ "id": "stable-id-123", "encryptedPayload": "base64-or-encoded-ciphertext" }
```

讲义元数据示例：
```json
{ "id": "reference-123", "name": "私人讲义.pdf", "mime": "application/pdf", "size": 12345 }
```

AI 分析示例：
```json
{ "userInput": "我这样理解对吗？", "sourceText": "讲义提取文字", "context": [] }
```

口诀分析示例：
```json
{ "mnemonic": "口诀内容", "sourceText": "对应讲义内容" }
```
