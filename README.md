# 🚀 AnyTransfer

> **奶牛快传停止服务了？** 我们来填补这个空白！AnyTransfer 是一个开源、自托管的临时文件传输服务。

[![Deploy to Cloudflare](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## ✨ 特性

- ⚡ **即时提取码** - 选择文件后立即获得提取码，无需等待上传完成
- 📤 **直传存储** - 前端通过签名 URL 直接上传到 R2，Worker 不做中转
- 🔐 **GitHub 登录** - 匿名用户 100MB，登录用户 1GB
- 🛡️ **文件审核** - 管理员后台 + 举报系统
- 🎨 **精美 UI** - 粒子动画背景 + 暗色主题
- 🌐 **全球部署** - 基于 Cloudflare Edge 网络，国内可访问

## 🎯 为什么选择 AnyTransfer？

| 特性 | 奶牛快传 | AnyTransfer |
|------|---------|-------------|
| 服务状态 | ❌ 已停止 | ✅ 自托管 |
| 费用 | 付费 | 🆓 免费（Cloudflare 免费额度内） |
| 数据控制 | 第三方 | 🔒 完全自主 |
| 开源 | ❌ | ✅ MIT |

## 📸 预览

访问: [anytransfer.myfastools.com](https://anytransfer.myfastools.com)

## 🛠 技术栈

- **Runtime**: Cloudflare Workers (边缘计算)
- **Storage**: Cloudflare R2 (S3 兼容对象存储)
- **Metadata**: Cloudflare KV (键值存储)
- **Users**: Cloudflare D1 (SQLite 数据库)
- **Auth**: GitHub OAuth + JWT
- **Framework**: Hono (轻量级 Web 框架)

## 🚀 快速部署

详细教程请参考 [DEPLOY.md](DEPLOY.md)

### 1. 克隆并安装

```bash
git clone https://github.com/Myfastools/anytransfer.git
cd anytransfer
npm install
```

### 2. 创建 Cloudflare 资源

```bash
# KV Namespace
npx wrangler kv namespace create TRANSFERS_KV
npx wrangler kv namespace create TRANSFERS_KV --preview

# R2 Bucket
npx wrangler r2 bucket create anytransfer-files
npx wrangler r2 bucket cors set anytransfer-files --file cors.json --force

# D1 Database
npx wrangler d1 create anytransfer-users
npx wrangler d1 execute anytransfer-users --remote --file=schema.sql
```

### 3. 配置 Secrets

```bash
# R2 API (在 Cloudflare Dashboard 创建 API Token)
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

# GitHub OAuth (创建 OAuth App: https://github.com/settings/developers)
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put JWT_SECRET
```

### 4. 部署

```bash
npx wrangler deploy
```

## 📡 API 接口

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/init` | 初始化传输，返回提取码 + R2 上传签名 URL |
| POST | `/api/complete/:id` | 确认上传完成 |
| GET | `/api/sign/:id` | 获取 R2 下载签名 URL |
| GET | `/api/status/:id` | 获取文件状态 |
| GET | `/api/me` | 获取当前用户信息 |
| POST | `/api/report/:id` | 举报文件 |
| GET | `/admin/transfers` | [管理员] 文件列表 |
| POST | `/admin/ban/:id` | [管理员] 封禁文件 |

## 🔧 配置项

在 `wrangler.toml` 中配置：

```toml
[vars]
MAX_FILE_SIZE = "104857600"      # 匿名用户限制 100MB
AUTH_MAX_FILE_SIZE = "1073741824" # 登录用户限制 1GB
DEFAULT_EXPIRY_HOURS = "24"       # 默认过期时间
DEFAULT_MAX_DOWNLOADS = "10"      # 默认最大下载次数
ADMIN_GITHUB_LOGIN = "your_github_username"  # 管理员账号
```

## 📄 License

MIT © [Myfastools](https://github.com/Myfastools)

---

⭐ 如果这个项目对你有帮助，请给个 Star！
