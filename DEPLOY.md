# AnyTransfer 部署教程

本教程面向 AI Agent，提供完整的部署步骤。

## 前置条件

- Node.js 18+
- Cloudflare 账号（已登录 wrangler）
- Git

## 快速部署

### 步骤 1: 克隆并安装

```bash
git clone https://github.com/YOUR_USERNAME/anytransfer.git
cd anytransfer
npm install
```

### 步骤 2: 创建 Cloudflare 资源

```bash
# 登录 Cloudflare (如果还没登录)
npx wrangler login

# 创建 KV Namespace (生产)
npx wrangler kv namespace create TRANSFERS_KV
# 输出会显示 id = "xxx"，记下这个值

# 创建 KV Namespace (开发)
npx wrangler kv namespace create TRANSFERS_KV --preview
# 输出会显示 preview_id = "xxx"，记下这个值

# 创建 R2 Bucket (生产)
npx wrangler r2 bucket create anytransfer-files

# 创建 R2 Bucket (开发)
npx wrangler r2 bucket create anytransfer-files-preview

# 配置 R2 CORS (允许前端直传)
npx wrangler r2 bucket cors set anytransfer-files --file cors.json --force
```

### 步骤 3: 更新 wrangler.toml

将 `wrangler.toml` 中的占位符替换为实际值：

```toml
[[kv_namespaces]]
binding = "TRANSFERS_KV"
id = "你的KV_NAMESPACE_ID"        # 替换这里
preview_id = "你的KV_PREVIEW_ID"   # 替换这里
```

### 步骤 4: 创建 R2 API Token

R2 签名 URL 需要 S3 兼容 API 凭据：

1. 打开 https://dash.cloudflare.com
2. 进入 R2 → Overview → **Manage R2 API Tokens**
3. 点击 **Create API token**
4. 配置:
   - Permissions: **Object Read & Write**
   - Bucket: **anytransfer-files** (或所有 bucket)
5. 复制生成的:
   - Access Key ID
   - Secret Access Key
6. 在 Cloudflare Dashboard 顶部复制你的 **Account ID**

### 步骤 5: 配置 Secrets

```bash
# 使用步骤 4 获取的值
echo "你的ACCOUNT_ID" | npx wrangler secret put R2_ACCOUNT_ID
echo "你的ACCESS_KEY_ID" | npx wrangler secret put R2_ACCESS_KEY_ID
echo "你的SECRET_ACCESS_KEY" | npx wrangler secret put R2_SECRET_ACCESS_KEY
```

### 步骤 6: 部署

```bash
npx wrangler deploy
```

部署成功后会显示 URL，例如：`https://anytransfer.YOUR_SUBDOMAIN.workers.dev`

---

## 本地开发

创建 `.dev.vars` 文件（**不要提交到 Git**）：

```
R2_ACCOUNT_ID=你的account_id
R2_ACCESS_KEY_ID=你的access_key_id
R2_SECRET_ACCESS_KEY=你的secret_access_key
```

启动开发服务器：

```bash
npx wrangler dev --remote
```

> ⚠️ 必须使用 `--remote`，R2 签名 URL 在 local 模式不工作。

---

## 项目结构

```
anytransfer/
├── src/
│   ├── index.ts      # Worker 主逻辑 (Hono 路由)
│   └── types.ts      # TypeScript 类型定义
├── public/
│   ├── index.html    # 上传页面
│   └── download.html # 下载页面
├── wrangler.toml     # Cloudflare 配置
├── cors.json         # R2 CORS 配置
└── .dev.vars         # 本地开发凭据 (不提交)
```

---

## API 接口

| 方法 | 路径 | 描述 |
|------|------|------|
| POST | `/api/init` | 初始化传输，返回提取码 + 上传签名 URL |
| POST | `/api/complete/:id` | 确认上传完成，保存文件元数据 |
| GET | `/api/sign/:id` | 获取下载签名 URL，递增下载计数 |
| GET | `/api/status/:id` | 获取文件状态 |
| GET | `/t/:id` | 短链接重定向到下载页 |

---

## 工作流程

```
1. 用户选择文件
2. 前端调用 POST /api/init → 获得提取码 + R2 PUT 签名 URL
3. 前端使用签名 URL 直接 PUT 文件到 R2 (不经过 Worker)
4. 上传完成后调用 POST /api/complete/:id 确认
5. 分享提取码给接收者
6. 接收者访问 /t/:id → 前端调用 GET /api/sign/:id → 获得签名下载 URL
7. 前端使用签名 URL 直接从 R2 下载
```

---

## 故障排查

### CORS 错误
确保已配置 R2 CORS：
```bash
npx wrangler r2 bucket cors set anytransfer-files --file cors.json --force
```

### 下载页显示"上传中"
检查 `/api/status/:id` 返回的 `ready` 字段是否为 `true`。如果为 `false`，说明 `/api/complete` 未被调用。

### 签名 URL 不工作
确认 R2 API Token 权限包含 Object Read & Write，且 Secrets 配置正确。
