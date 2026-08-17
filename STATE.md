# 项目状态

## 最近运行

- 2026-08-13：完成重新部署持久化、安全续跑闸门及交易动作 crash-window 修复；`npm test`、全部改动 JS 的 Node 语法检查、`git diff --check`、生产依赖 dry-run、`npm ls --depth=0` 与 RISEx 动态 import 验证通过。三路独立终审均批准固定候选。Docker 镜像未能在本机构建，因 Docker daemon 不可用。
- 2026-08-17：新增 `compose.yaml` 固定命名卷 `grid-bot-data`，`docker compose up -d --build` 自动创建并复用 `/app/data`，减少重新部署时的手动卷配置。

## 当前任务

- 修复重新部署后，部署前正在执行的网格策略及其运行记录消失的问题。
- 当前阶段：已实现并通过正式验证与三路独立终审；已增加 Compose 一键持久化入口，生产仍需使用 Compose 部署或在 Dokploy Dockerfile 模式下配置一次 `/app/data`。

## 未决

- 待运维确认生产 Dokploy 是否切换到仓库 `compose.yaml`；若继续 Dockerfile 模式，仍需确认 `/app/data` 命名卷实际存在且 `node` 用户可写。
- 若旧容器仍存在，升级前按 `DEPLOY.md` 的停网格/撤单/核对/迁移步骤处理旧 `.state.json`。

## 已知之险

- 工作区已有用户未提交修改：`src/config.js`、`src/exchange/rs/paper.js`、`src/server.js`；本任务必须保留。
- 实盘重启恢复会接管交易所现存挂单，测试必须使用隔离临时目录/模拟适配器，不能触发真实交易请求。
- 本机 Docker daemon 不可用，因此完整 `docker build` 仍需由 Dokploy/CI 执行；已用生产依赖 dry-run、SDK import 与语法检查覆盖镜像内代码/依赖风险。

## 教训（近三）

- 容器 writable layer 会随 redeploy 消失；运行状态必须和数据库共用持久卷。
- 模拟盘续跑不仅要保存 bot active，还要保存余额、仓位、已实现盈亏、订单序号及 reduce-only 语义。
- 损坏/丢失/不可写快照必须 fail closed，不能伪装成首次启动或盲目撤销无法确认市场的订单。
- 每笔外部下单需先持久化 pending intent；对账/重连期间的成交补挂需持久化 deferred intent，互斥结束或重启后继续执行。
- 恢复时的实时价、真实挂单和再次实时价必须在同一禁止下单的 gate 内核验；期间成交只记账并留存 deferred，不得提前下单。
- 外层 reconnect mutation 释放前不得清恢复 gate；最终补挂必须在释放后重新核验实时价和真实挂单，不能交给普通 mutation `finally`。
