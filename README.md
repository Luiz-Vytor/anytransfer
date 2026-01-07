# AnyTransfer

🚀 安全便捷的临时文件传输服务，基于 Cloudflare Workers + R2 + KV。

## 特性

- ⚡ **即时提取码** - 选择文件后立即获得提取码，无需等待上传完成
- 📤 **直传 R2** - 前端通过签名 URL 直接上传到 R2，Worker 不做中转
- 🔒 **下载限制** - 可配置最大下载次数和过期时间
- 🌐 **全球部署** - 基于 Cloudflare Edge 网络

## 技术栈

- **Runtime**: Cloudflare Workers
- **Storage**: Cloudflare R2 (文件) + KV (元数据)
- **Framework**: Hono
- **Presigned URLs**: AWS S3 SDK (R2 兼容)

## 部署

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 Cloudflare 资源

```bash
# KV Namespace
npx wrangler kv namespace create TRANSFERS_KV
npx wrangler kv namespace create TRANSFERS_KV --preview

# R2 Bucket
npx wrangler r2 bucket create anytransfer-files
npx wrangler r2 bucket create anytransfer-files-preview

# 配置 CORS (允许前端直传)
npx wrangler r2 bucket cors set anytransfer-files --file cors.json --force
```

### 3. 配置 R2 API Token

在 [Cloudflare Dashboard](https://dash.cloudflare.com) 创建 R2 API Token，然后：

```bash
# 设置生产环境 secrets
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

本地开发创建 `.dev.vars`:

```
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
```

### 4. 更新 wrangler.toml

将 KV namespace ID 替换为实际值。

### 5. 部署

```bash
npx wrangler deploy
```

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/init` | 初始化传输，返回提取码 + R2 上传签名 URL |
| POST | `/api/complete/:id` | 确认上传完成 |
| GET | `/api/sign/:id` | 获取 R2 下载签名 URL |
| GET | `/api/status/:id` | 获取文件状态 |
| GET | `/t/:id` | 下载页面重定向 |

## License

MIT
