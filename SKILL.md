# 项目规则册

## 技术栈

- Node.js `>=20`，原生 ES Modules（出处：`package.json` 的 `engines` 与 `type`）。
- 无 Web 框架的 Node HTTP/SSE 服务，前端为 `public/index.html` 单文件（出处：`src/server.js`、`public/index.html`）。
- 本地 SQLite，驱动为 `better-sqlite3 ^12.11.1`；数据库默认位于 `data/app.db`（出处：`package.json`、`src/db.js`）。
- Docker 运行镜像为 `node:20-bookworm-slim`，以非 root 的 `node` 用户运行（出处：`Dockerfile`）。

## 约定

- JavaScript 使用 2 空格缩进、单引号、分号与具名导出；import 置于文件顶部（出处：`src/grid.js`、`src/persist.js`、`src/db.js`、测试文件）。
- 交易核心由纯函数与适配器分离；三个交易所统一通过 `GridBot` 编排（出处：`src/grid.js`、`src/bot.js`、`src/server.js`）。
- 异步交易所调用在可安全降级处使用局部 `try/catch`，不得让持久化或遥测异常击穿交易主流程（出处：`src/bot.js`、`src/persist.js`）。
- 测试使用 Node 内置 `node:assert/strict` 与轻量自定义 runner，不额外引入测试框架（出处：`test/grid.test.js`、`test/auth.test.js`）。
- `.env`、运行状态及数据库均含敏感或账户数据，不提交版本库，不在诊断输出中泄露（出处：`.gitignore`、`.dockerignore`）。

## 硬规

- 修改前先跑基线测试；逻辑、数据或行为改变必须增加能覆盖用户症状的回归测试。
- 保留工作区中已有的未提交修改，不覆盖、不顺手重排无关代码。
- 最小 diff；不得为单一实现提前抽象，也不得静默增加依赖。
- 验证三闸未过时，读完整错误、定位根因、作局部修复并重跑，最多三轮；三轮未果、同错回环、需改公共 API/数据契约/schema、或需删测/放宽断言时停止并请人工裁定。
- 状态恢复属于资金安全路径：恢复失败不得臆测本地状态与交易所状态一致，必须保留明确告警与安全降级。

## 验证套件

- 正式测试：`npm test`（实际脚本依次运行 `node test/grid.test.js`、`node test/auth.test.js` 与 `node test/persist.test.js`）。
- 启动：`npm start`（实际脚本为 `node src/server.js`；会访问交易所网络，不作为无人值守测试）。
- 当前未配置独立的 typecheck、lint 或 build 脚本。

## 教训

- 2026-08-12：容器内运行状态必须写入已挂载的 `/app/data`，不能放在 `/app` 根层；跨部署测试必须使用两个独立 release 根目录且只迁移 `data/`，避免模块内缓存造成假绿。
- 2026-08-12：交易状态恢复必须以稳定市场名称和明确 paper/live 模式校验；数字 `marketId`、残缺快照或无法解析的市场均不得用于猜测式续跑/撤单。
- 2026-08-12：任何会产生外部订单的状态转移，必须先同步、原子且 fsync 地持久化可恢复状态；运行期写失败要重试并反映到健康检查。
- 2026-08-12：交易所调用成功与本地记录完成之间必须有可恢复的两阶段意图；并发对账期间的成交补挂也必须进入快照，不能因互斥锁直接跳过。
- 2026-08-13：持久化的补挂意图只能在可信的真实挂单对账后执行；恢复对账失败必须可通过受控重连重试，不得绕过其他交易锁。
- 2026-08-13：交易所 SDK 的“成功”须按其实际返回契约判定；如 RISEx `{ success: false }` 属于明确失败，绝不能因对象 truthy 而清理本地跟踪。
- 2026-08-13：恢复安全闸必须跨越外层 reconnect mutation 的完整生命周期；闸内未完成的补挂不能留给普通 `finally`，否则期间行情越界仍可能提交 opening 单。
- 2026-08-13：实盘续跑只能接管具备稳定身份、真实剩余量、方向与 reduce-only 元数据的订单；部分成交、字段残缺或跟踪单消失时必须 fail closed，不能用策略配置猜测。
- 2026-08-13：适配器应以交易所实际接受的量化价格/数量同时更新返回值和内部 tracker，保证成交统计、恢复快照与后续补挂使用同一事实。
- 2026-08-17：若要求“重新部署无需手动挂卷”，必须提供固定名称的 Compose named volume；应用层无法在容器销毁后凭空恢复宿主机数据，Dockerfile 的 `VOLUME` 只能作兜底，不能替代稳定命名卷。

## 待确认

- 未见 CI 配置与统一 lint/typecheck 工具；是否补充需由项目维护者决定。
- Dokploy 生产环境实际挂载仍需运维侧核对；代码和文档现统一要求唯一目录卷 `/app/data`，不得挂单文件或整个 `/app`。
