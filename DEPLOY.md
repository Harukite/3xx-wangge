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
| `/app/data` | SQLite 数据库 + 网格运行快照 + AI 状态 | **必须**，否则重新部署会丢配置和运行记录 |

> 只需挂载 `/app/data` 这个目录。不要把普通 Volume 挂到单个文件 `/app/.state.json`，也不要挂整个 `/app`（会遮蔽镜像中的程序文件）。

### 4. 端口与域名
- **Port**: `8080`（应用监听端口，Dokploy 路由到此）。
- **Domains**: 绑定你的域名，Dokploy 自动签发 HTTPS 证书（Traefik + Let's Encrypt）。

### 5. 部署并访问
点 **Deploy**。构建完成后访问绑定的域名 → 登录页 → 用 `LOGIN_EMAIL` + 密码登录。

## 运维要点

- **改配置后生效**：交易所模式/凭据在「设置」页改后写入数据库 + `.env`，需 **Restart 容器** 生效。数据库为配置真相源，重启后自动同步到运行环境。
- **健康检查**：`/api/live` 是容器存活探针；`/api/health` 是业务安全状态，持久化失败、恢复安全校验失败、或存在重启后无人接管的未完成交易意图时返回 `503`。两者分离，确保安全锁定时页面仍可访问并人工核对；当前进程正在执行且已有持久化意图保护的慢交易请求不会被误判为故障。
- **优雅关闭**：容器收到 `SIGTERM` 会保存网格快照后退出，重启自动续跑（交易所上的挂单保留不动）。
- **SSE 实时推送**：`/api/overview/stream` 等长连接，Dokploy 的 Traefik 默认支持。
- **升级**：Git 推新代码 → Dokploy 自动重新构建部署；持久卷保留数据与配置。

> 从旧版本升级：**第一次部署本修复前**，先暂停自动部署，在界面停止网格/撤单并核对仓位，确认状态不再变化后，在仍存在的旧容器终端执行 `cp /app/.state.json /app/data/grid-state.json`，然后立即部署。若必须保留实盘挂单续跑，请在复制后不要继续交易，并在新版本启动后逐单核对。新版也会把同一容器内仍存在的旧文件自动迁入新位置。旧容器已经删除且此前未持久化时，原快照无法由新容器恢复，须先到交易所核对遗留挂单和仓位。

> 旧版 paper 快照没有保存模拟余额/仓位账本，升级后会保留历史记录但拒绝自动续跑；请核对后手动重新启动模拟网格。实盘升级前尤其要先确认旧挂单和仓位仍受控。

> RISEx live 安全限制：当前 SDK 的 open-orders 响应无法证明部分成交后的真实剩余量。新版会保留快照、挂单和健康告警，但拒绝猜测式自动续跑；请在 RISEx 界面逐单核对剩余量与仓位后再停止/重置并重开策略。

生产环境保持 **1 个副本（Replicas = 1）**，并确保容器内的 `node` 用户可写 `/app/data`；多个机器人实例不能同时接管同一账户和同一份状态文件。

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
