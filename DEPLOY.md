# Dokploy 部署指南

把"三交易所网格机器人"部署到 [Dokploy](https://dokploy.com)（自托管 PaaS，基于 Docker + Traefik，自带 HTTPS）。

## 前置条件

- 一个可用的 Dokploy 实例（已配好服务器域名与 HTTPS）。
- 代码已推送到 Git 仓库（如 `github.com/Harukite/3xx-wangge`）。
- 项目自带 `Dockerfile`，Dokploy 用 Docker 类型构建即可。

## 部署步骤

### 1. 新建应用
Dokploy → **Applications** → Create → Source 选 **Git** → 类型选 **Dockerfile**（Docker）→ 连接仓库、选分支。构建命令留空，Dokploy 自动用根目录 `Dockerfile`。

### 2. 环境变量（Environment）
首次部署填入；之后交易所凭据可在应用内「⚙ 设置」页管理（存数据库持久卷）：

| 变量 | 值 | 说明 |
|---|---|---|
| `LOGIN_EMAIL` | `jaychougo@gmail.com` | 白名单登录邮箱（唯一允许） |
| `LOGIN_PASSWORD_HASH` | `scrypt:...` | 本地跑 `npm run hash` 生成后粘贴 |
| `SESSION_SECRET` | 一段随机长串 | 会话签名密钥（建议固定，重启不掉登录） |
| `SESSION_COOKIE_SECURE` | `true` | Dokploy 是 HTTPS，开启 Secure cookie |
| `HOST` | `0.0.0.0` | 容器内监听（Dockerfile 已默认） |
| `PORT` | `8080` | 端口（Dockerfile 已默认） |
| `PAPER_BALANCE` | `10000` | 模拟盘初始余额 |
| `DE_MODE` / `EX_MODE` / `RS_MODE` | `paper` | 初始模式；实盘凭据在应用内「设置」页填 |

> 交易所私钥、AI、Telegram 等可选配置可在此填，也可登录后在「⚙ 设置 → 🏦 交易所实盘配置」里管理。

### 3. 持久化存储（重要！）
Dokploy → Application → **Persistent Storage / Volumes**，添加：

| 容器路径 | 作用 | 必要性 |
|---|---|---|
| `/app/data` | SQLite 数据库（登录用户、交易所凭据） | **必须**，否则重启丢配置 |
| `/app/.state.json`（或 `/app`） | 网格运行快照（崩溃续跑） | 推荐 |

> 不挂持久卷，容器每次重启都会丢失数据库与配置。

### 4. 端口与域名
- **Port**: `8080`（应用监听端口，Dokploy 路由到此）。
- **Domains**: 绑定你的域名，Dokploy 自动签发 HTTPS 证书（Traefik + Let's Encrypt）。

### 5. 部署并访问
点 **Deploy**。构建完成后访问绑定的域名 → 登录页 → 用 `LOGIN_EMAIL` + 密码登录。

## 运维要点

- **改配置后生效**：交易所模式/凭据在「设置」页改后写入数据库 + `.env`，需 **Restart 容器** 生效。数据库为配置真相源，重启后自动同步到运行环境。
- **健康检查**：`/api/health` 公开端点，`Dockerfile` 已配 `HEALTHCHECK`。
- **优雅关闭**：容器收到 `SIGTERM` 会保存网格快照后退出，重启自动续跑（交易所上的挂单保留不动）。
- **SSE 实时推送**：`/api/overview/stream` 等长连接，Dokploy 的 Traefik 默认支持。
- **升级**：Git 推新代码 → Dokploy 自动重新构建部署；持久卷保留数据与配置。

## 本地用 Docker 验证（可选）

```bash
# 生成登录密码哈希
npm run hash

# 构建并运行（data 目录用持久卷）
docker build -t grid-bot .
docker run -p 8080:8080 -v "$PWD/data":/app/data \
  -e LOGIN_EMAIL=you@example.com \
  -e LOGIN_PASSWORD_HASH=scrypt:... \
  -e SESSION_SECRET=anyrandom \
  -e SESSION_COOKIE_SECURE=false \
  grid-bot
```

浏览器打开 `http://localhost:8080` 登录。
