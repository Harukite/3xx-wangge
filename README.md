# 三交易所整合网格交易机器人

一个跑在你自己电脑上的加密货币**永续合约网格交易机器人**，同时支持三家去中心化交易所：**Decibel**（Aptos 链）、**Extended**（Starknet 链）、**RISEx**。三个交易所可以同时各跑一个网格策略，统一在一个浏览器仪表盘里监控和操控。

> ⚠️ **免责声明**：本程序仅供学习和研究。合约交易带高杠杆风险，可能损失全部本金。实盘前请务必先用模拟模式充分熟悉。使用本程序造成的任何盈亏由使用者自行承担。

---

## 目录

- [一、功能总览](#一功能总览)
- [二、三分钟快速上手（模拟模式）](#二三分钟快速上手模拟模式)
- [三、一键启动脚本做了什么](#三一键启动脚本做了什么)
- [四、手动安装（备选方案）](#四手动安装备选方案)
- [五、仪表盘使用教程](#五仪表盘使用教程)
- [六、网格策略原理与参数详解](#六网格策略原理与参数详解)
- [七、实盘模式：API 密钥获取与配置](#七实盘模式api-密钥获取与配置)
- [八、代理 / IP 配置](#八代理--ip-配置)
- [九、AI 助手配置](#九ai-助手配置)
- [十、通知推送（Telegram / Webhook）](#十通知推送telegram--webhook)
- [十一、.env 配置项完整对照表](#十一env-配置项完整对照表)
- [十二、断电 / 崩溃自动恢复机制](#十二断电--崩溃自动恢复机制)
- [十三、REST API 一览（进阶）](#十三rest-api-一览进阶)
- [十四、常见问题 FAQ](#十四常见问题-faq)
- [十五、项目结构](#十五项目结构)
- [十六、安全须知](#十六安全须知)

---

## 一、功能总览

### 交易核心

| 功能 | 说明 |
|---|---|
| 三交易所并行 | Decibel / Extended / RISEx 各自独立运行一个网格机器人，互不影响 |
| 双运行模式 | `paper` 模拟盘（虚拟资金，真实行情）和 `live` 实盘（真实下单） |
| 三种网格类型 | 中性（区间震荡双向吃单）、做多（低吸高抛）、做空（高抛低补） |
| 等差网格 | 在设定区间内均匀布单，每次成交后在相邻一格自动补反向单，赚取格差 |
| 智能填充参数 | 一键根据近期 K 线趋势分析，自动推荐网格类型、区间上下界、格数 |
| 稳健 / 激进两档 | 稳健 = 格距大成交少更安全；激进 = 格距小成交频繁风险高 |
| 区间外止损策略 | 价格冲出区间时可选：直接平仓停止，或只减仓回收阶梯（recover） |
| 在线调整区间 | 不停止网格的情况下平移 / 扩缩区间 |
| 风控内置 | 杠杆上限、保证金预检查、手续费/格距合理性校验、挂单定期对账 |
| 崩溃续跑 | 断电 / 崩溃后重启程序，自动接管交易所上还挂着的单继续跑 |

### 仪表盘（浏览器操作，无需改代码）

- 📊 **总览页**：三所余额、权益、总盈亏、已实现/未实现盈亏、收益率、成交量、完成格数实时刷新（SSE 秒级推送）
- 每个交易所独立**控制台**：选交易对、看 K 线趋势分析、启动 / 停止 / 撤单 / 平仓 / 重置统计 / 重连交易所
- ⚙ **IP 配置页**：在网页里直接设置全局或各所独立代理，检测出口 IP，写入 .env
- 🤖 **AI 助手页**：连接你自己的 AI 服务（DeepSeek / Kimi / OpenAI / Claude / Gemini / Ollama 等），提供五大能力：
  1. **风控哨兵**：定时巡检三所状态，发现异常推送告警
  2. **每日复盘日报**：每天定点生成交易总结
  3. **市况分析**：定时生成 BTC 市况报告
  4. **对话操控**：用自然语言问状态、下指令（如"把 Extended 上边界调到 66000"，AI 只提议，你点确认才执行）
  5. **出区间建议**：价格冲出网格区间时，AI 给出处置建议
- 📱 **通知推送**：Telegram 机器人 + 通用 Webhook，成交异常 / 哨兵告警 / 日报自动推送

### 安全设计

- AI 永远不进交易快回路，下单补单对账全部是纯规则代码
- AI 对话只能"提议"操作，必须由你在网页上点确认才会执行
- 私钥只存在本机 `.env` 文件，程序不上传任何数据

---

## 二、三分钟快速上手（模拟模式）

模拟模式**不需要任何 API 密钥、不需要任何账号**，用虚拟的 10000 USDC 和真实行情练手。

1. **下载本项目**到电脑任意文件夹（如果是 zip 包，先解压）。
2. **双击 `一键启动.bat`**。脚本会自动完成所有准备工作（没装 Node.js 会帮你装，详见下一节）。
3. 等待窗口显示"已启动"，浏览器会**自动打开** `http://localhost:8080`。
4. 在网页里任选一个交易所（比如 Decibel），点 **🎯 智能填充参数**，再点 **启动 Decibel 网格**。
5. 完成！观察总览页的盈亏变化。想停就点 **停止 + 撤单 + 平仓**，想关程序就关掉那个黑色命令行窗口。

---

## 三、一键启动脚本做了什么

`一键启动.bat`（模拟模式）逐步执行以下动作，全程无需手动干预：

1. **检查 Node.js**
   - 已安装 → 直接进入下一步；
   - 未安装 → 自动调用 Windows 自带的 winget 静默安装 Node.js LTS 版；
   - winget 也不可用（老系统）→ 自动打开 Node.js 官网下载页 `https://nodejs.org/zh-cn/download`，你手动安装后重新双击脚本即可。
2. **初始化配置**：如果没有 `.env` 文件，自动从 `.env.example` 复制一份。默认配置就是全模拟模式，零填写。
3. **安装依赖**：如果没有 `node_modules` 文件夹（首次运行），自动执行 `npm install`，约 1–3 分钟。失败时会提示切换国内 npm 镜像的命令。
4. **启动程序**：运行 `node src/server.js`，4 秒后自动打开浏览器仪表盘。

`实盘启动.bat` 多两个保护步骤：检查 `.env` 是否存在（实盘必须先配置密钥），以及要求你手动输入 `YES` 确认才会启动。

> 💡 关闭命令行窗口 = 停止程序。已挂在交易所的单不会被自动撤销，下次启动程序会自动接管续跑（见[第十二节](#十二断电--崩溃自动恢复机制)）。

---

## 四、手动安装（备选方案）

如果你不想用 bat 脚本，或在 Mac / Linux 上运行：

1. 安装 [Node.js](https://nodejs.org/zh-cn/download) v20 或更高版本。验证：终端执行 `node -v` 能显示版本号。
2. 在项目文件夹打开终端，执行：
   ```bash
   npm install        # 安装依赖
   cp .env.example .env   # Windows 用: copy .env.example .env
   npm start          # 启动，等价于 node src/server.js
   ```
3. 浏览器打开 `http://localhost:8080`。
4. 运行测试（可选）：`npm test`。

---

## 五、仪表盘使用教程

启动后浏览器打开 `http://localhost:8080`，顶部有五个页签：**📊 总览**、三个交易所控制台、**⚙ IP配置**、**🤖 AI助手**。

### 5.1 总览页

三张卡片分别对应三个交易所，实时显示（每秒刷新）：

- **运行状态**：是否在跑、paper/live 模式
- **余额 / 权益**：账户余额和含未实现盈亏的总权益
- **总盈亏** = 已实现盈亏 + 未实现盈亏，以及收益率百分比
- **成交量 / 完成格数**：累计成交额和已完成的"买-卖"完整来回次数
- **挂单数**：本地跟踪的挂单 vs 交易所实际挂单（对账用）
- **出区间警示**：价格冲出网格区间时高亮提醒

点"进入 XX 控制台 →"跳到对应交易所页面。

### 5.2 交易所控制台（三个所界面相同）

**第一步：选交易对**。下拉框列出该所全部可交易市场（如 BTC/USD、ETH/USD）。

**第二步：看趋势（可选）**。选择 K 线周期后，程序自动拉取近 200 根 K 线做趋势分析（涨/跌/震荡、强度、波动率 ATR），并给出推荐的网格类型。

**第三步：填参数**。两种方式：

- **🎯 智能填充参数**（推荐新手）：根据趋势分析自动填好网格类型、上下边界、网格数量、每格数量。你只需要检查一下再启动。还可以点"采用推荐策略 + 自动区间"完全托管。
- **手动填写**：
  | 参数 | 含义 |
  |---|---|
  | 网格类型 | 中性 / 做多 / 做空（详见第六节） |
  | 下边界 / 上边界 | 网格区间的最低价和最高价 |
  | 网格数量 | 区间内均分成多少格，格数越多格距越小、成交越频繁 |
  | 每格数量(币) | 每一格挂单的币数量（如 0.001 BTC） |
  | 杠杆 (x) | 使用的杠杆倍数，程序有保证金预检查，超了不让启动 |
  | 稳健 / 激进 | 快捷预设：稳健=成交少更安全，激进=成交频繁风险高 |
  | 区间外止损策略 | 价格冲出区间怎么办：`平仓` 或 `只减仓回收阶梯` |

**第四步：点"启动 XX 网格"**。程序会先做风控检查（保证金够不够、格距是否大于手续费成本），通过后一次性铺满区间挂单。

**运行中可用的操作**：

- **调整区间（不停止网格）**：直接改上下边界，程序增补/撤销对应挂单
- **撤销所有挂单（保留持仓）**：清掉挂单但不动仓位
- **停止 + 撤单 + 平仓**：完全退出，市价平掉持仓
- **重置统计（盈亏/成交量清零）**：只清显示数据，不动交易
- **🔌 重连交易所（不动挂单/持仓）**：网络闪断后重建连接并自动对账续跑

**遗留持仓处理**：如果程序重启后发现交易所上还有没处理完的持仓，界面会弹出三个选项：
① 只减仓回收阶梯（挂 reduce-only 单逐步退出）② 按现价重开网格 ③ 市价平仓。

### 5.3 ⚙ IP 配置页

给三个交易所配置网络代理（部分地区直连不了交易所 API 时需要）：

- **全局代理**：一个地址同时用于三个所（优先级最高）
- **各所独立代理**：给不同交易所配不同出口 IP
- **检测当前出口 IP**：验证代理是否生效
- 点"写入 .env"保存，重启程序后生效

格式见[第八节](#八代理--ip-配置)。

### 5.4 🤖 AI 助手页

见[第九节](#九ai-助手配置)。

---

## 六、网格策略原理与参数详解

### 6.1 网格是怎么赚钱的

在你设定的价格区间 `[下边界, 上边界]` 内均匀画出 N 条价格线（格线）。程序在现价**下方格线挂买单、上方格线挂卖单**。价格每穿过一条格线就会成交一单，成交后程序立刻在**相邻一格**挂出反向单：

- 买单成交 → 在上方一格挂卖单（等反弹卖出）
- 卖单成交 → 在下方一格挂买单（等回落买回）

每完成一次"买入→卖出"来回，就赚到 `格距 × 每格数量` 的差价（扣除手续费）。**震荡行情来回越多赚越多；单边行情冲出区间就会被套**，所以区间外策略和止损很重要。

### 6.2 三种网格类型

| 类型 | 挂单方式 | 适合行情 |
|---|---|---|
| 中性 | 现价下方挂买单、上方挂卖单，双向开仓 | 横盘震荡 |
| 做多 | 只在下方挂买单（低吸），涨上去只挂平多的卖单 | 震荡偏涨 |
| 做空 | 只在上方挂卖单（高抛），跌下来只挂平空的买单 | 震荡偏跌 |

做多网格的卖单、做空网格的买单都是 **reduce-only（只减仓）**，不会反向开仓。

### 6.3 参数选择建议

- **区间**：包住近期主要震荡范围。区间太窄容易冲出去，太宽则格距大、成交少。"智能填充"会按 ATR 波动率自动算。
- **格数**：格距 = (上边界 − 下边界) / 格数。**格距必须明显大于一来一回的手续费**，否则做一单亏一单——程序启动时会强制校验这一点。
- **每格数量**：决定资金占用。程序启动前做保证金预检查：所有格子同方向全部成交时所需保证金不能超过 `余额 × 杠杆`。
- **杠杆**：放大收益也放大爆仓风险。新手建议 ≤ 5x，先用模拟盘试。
- **区间外策略**：`平仓`（冲出区间立即撤单+平仓+停止，损失确定）或 `recover 只减仓回收`（挂 reduce-only 阶梯单等价格回来逐步退出，不追加风险但退出时间不确定）。

---

## 七、实盘模式：API 密钥获取与配置

### 7.0 总体步骤

1. 用记事本（或任何文本编辑器）打开项目文件夹里的 `.env` 文件（没有就先复制 `.env.example` 改名为 `.env`；注意文件名就是 `.env`，前面有个点，没有别的后缀）。
2. 把你要实盘的交易所的模式改为 live：`DE_MODE=live`（Decibel）/ `EX_MODE=live`（Extended）/ `RS_MODE=live`（RISEx）。**三个所互相独立**，可以只实盘一个、其余保持 paper。
3. 按下面各小节获取并填入对应凭据。
4. 保存 `.env`，双击 `实盘启动.bat`，输入 `YES` 确认启动。
5. 启动日志里看到 `[XX] ✓ 连接成功 [LIVE 模式]` 即成功。

> ⚠️ 填写规则：等号后面直接跟值，不要加空格和引号（例：`DECIBEL_API_KEY=abc123`）。私钥是极度敏感信息，`.env` 绝不要发给任何人、绝不要提交到 GitHub（本项目 `.gitignore` 已默认排除）。

### 7.1 Decibel（Aptos 链）

需要填 3 项：

```ini
DE_MODE=live
DECIBEL_API_KEY=       # ① API Key
DECIBEL_PRIVATE_KEY=   # ② API 钱包 Ed25519 私钥
DECIBEL_SUBACCOUNT=    # ③ Trading Account 地址
```

获取步骤：

1. **① API Key**：到 **geomi.dev**（Aptos 官方 API 网关，原 Aptos Build）注册账号 → 创建项目 → 生成 API Key。这是访问 Aptos 全节点 API 的通行证。
2. **② API 钱包私钥**：打开 **app.decibel.trade/api** → 连接你的钱包 → 创建 **API Wallet**，会生成一个 Ed25519 私钥。这个 API 钱包只有交易权限，不能提币，安全性比主钱包私钥高。复制生成的私钥填入。
3. **③ Trading Account 地址**：在 Decibel 交易界面里查看你的 **Trading Account（子账户）地址**（0x 开头的一长串），复制填入。
4. 确保该 Trading Account 里有 USDC 作为保证金。

### 7.2 Extended（Starknet 链）

需要填 4 项：

```ini
EX_MODE=live
EXTENDED_API_KEY=              # ① API Key
EXTENDED_VAULT=                # ② Vault ID
EXTENDED_STARK_PRIVATE_KEY=    # ③ Stark 私钥
EXTENDED_STARK_PUBLIC_KEY=     # ④ Stark 公钥
```

获取步骤：

1. 打开 **app.extended.exchange**，连接钱包并完成开户（首次会创建你的 Starknet 交易账户）。
2. 进入 **API Management**（一般在账户设置 / 头像菜单里）→ 点 **Create API Key**。
3. 页面会一次性展示 4 个值：**API Key、Vault（数字 ID）、Stark Private Key、Stark Public Key**。⚠️ 私钥只显示一次，务必当场复制保存。
4. 四个值对应填入 `.env`。`EXTENDED_MAX_FEE`（最大手续费率）保持默认 `0.0005` 即可。
5. 确保账户里有 USDC 保证金。

### 7.3 RISEx

需要填 2 项：

```ini
RS_MODE=live
ACCOUNT_ADDRESS=       # ① 账户地址
SIGNER_PRIVATE_KEY=    # ② 签名私钥
```

获取步骤：

1. 打开 RISEx 官网交易应用，连接钱包完成开户。
2. 在账户 / API 设置中查看你的**账户地址**，并创建 / 导出用于签名下单的 **Signer 私钥**（具体入口以 RISEx 官方文档为准，通常在 API 或账户安全设置里）。
3. 两个值填入 `.env`，确保账户有保证金。

`RISEX_API_URL` / `RISEX_WS_URL` 留空即用官方默认地址，一般不用改。

### 7.4 测试网练手（可选）

三个所都支持先连测试网（用测试币实盘流程）：把对应的 `DE_NETWORK` / `EX_NETWORK` / `RS_NETWORK` 改为 `testnet`，再用测试网的账户凭据即可。

---

## 八、代理 / IP 配置

部分地区网络直连不了交易所 API，需要代理。两种配置方式：**仪表盘 ⚙ IP配置页**（推荐，可在线检测）或直接编辑 `.env`。

```ini
# 全局代理：三个所共用（优先级最高）
GLOBAL_PROXY=

# 各所独立代理（仅当 GLOBAL_PROXY 为空时生效）
DECIBEL_PROXY=
EXTENDED_PROXY=
RISEX_PROXY=
```

支持的格式：

| 格式 | 示例 |
|---|---|
| HTTP(S) 代理 | `http://127.0.0.1:7890` |
| SOCKS5 代理 | `socks5://127.0.0.1:1080` |
| 带账号密码 | `socks5://user:pass@host:port` |
| 简写格式 | `host:port:user:pass` |

启动时程序会自动检测代理连通性并打印出口 IP。**实盘模式下代理不通会直接中止启动**（防止断网状态下挂单失控）；模拟模式则继续运行但可能拿不到真实行情。

> 💡 用本机代理软件（如 Clash 默认 `http://127.0.0.1:7890`）时，请保证代理软件先启动。

---

## 九、AI 助手配置

AI 助手是**可选**功能，不配置完全不影响交易。它把你自己的大模型 API 接进来，提供风控哨兵、日报、市况分析、对话操控、出区间建议五个能力。

### 9.1 在仪表盘配置（推荐）

打开 **🤖 AI助手** 页签 → 选择**服务商**（会自动填好协议、接口地址、推荐模型）→ 填入 **API Key** → 点**测试连接** → 通过后点**保存配置**（自动写入 `.env`）。

### 9.2 支持的服务商与 Key 获取

`AI_PROVIDER` 只有三种协议：`openai`（所有 OpenAI 兼容服务都选它）、`anthropic`、`gemini`。

| 服务商 | AI_PROVIDER | AI_BASE_URL | Key 获取地址 |
|---|---|---|---|
| DeepSeek（便宜好用） | `openai` | `https://api.deepseek.com/v1` | platform.deepseek.com |
| Kimi / 月之暗面 | `openai` | `https://api.moonshot.cn/v1` | platform.moonshot.cn |
| 通义千问 | `openai` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 阿里云百炼控制台 |
| OpenAI | `openai` | 留空 | platform.openai.com |
| OpenRouter（聚合） | `openai` | `https://openrouter.ai/api/v1` | openrouter.ai |
| Claude / Anthropic | `anthropic` | 留空 | console.anthropic.com |
| Gemini / Google | `gemini` | 留空 | aistudio.google.com |
| Ollama（本地免费） | `openai` | `http://127.0.0.1:11434/v1` | 无需 Key，本地跑 |

通用流程：注册账号 → 控制台里找 **API Keys** → 创建 Key（一般 `sk-` 开头）→ 复制填入。多数国产服务需要先充值几块钱。

### 9.3 相关配置项

```ini
AI_PROVIDER=openai
AI_API_KEY=sk-xxxx
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat        # 主模型：复盘/分析/对话
AI_MODEL_SMALL=               # 小模型：哨兵高频巡检省钱，留空=同主模型
AI_SENTINEL_MINUTES=5         # 哨兵巡检间隔（分钟，0=关闭）
AI_MARKET_MINUTES=30          # BTC 市况报告间隔（分钟，0=关闭）
AI_REPORT_HOUR=20             # 每天几点生成日报（0-23 整点）
```

### 9.4 对话操控示例

在 AI 助手页的对话框输入自然语言，例如：

- "三个所现在整体情况怎么样？"
- "把 Extended 上边界调到 66000"
- "Decibel 该不该止损？"

涉及**写操作**（调区间、停止等）时 AI 只会提出建议，网页弹出确认框，你点确认才真正执行——AI 无法擅自动你的仓位。

---

## 十、通知推送（Telegram / Webhook）

配置后，哨兵告警、日报、重要事件会自动推送到你手机。不配则只在网页显示。

### Telegram 机器人（推荐）

1. 在 Telegram 搜索 **@BotFather** → 发送 `/newbot` → 按提示给机器人起名 → 得到 **Bot Token**（形如 `123456:ABC-xxx`），填入 `TELEGRAM_BOT_TOKEN`。
2. 获取你的 **Chat ID**：给刚创建的机器人随便发一条消息，然后浏览器打开 `https://api.telegram.org/bot<你的Token>/getUpdates`，返回 JSON 里 `"chat":{"id":123456789}` 的数字就是 Chat ID，填入 `TELEGRAM_CHAT_ID`。（或者直接给 @userinfobot 发消息查自己的 ID。）
3. 保存后在 AI 助手页可以点"立即巡检一次"测试推送。

### 通用 Webhook

`NOTIFY_WEBHOOK=https://你的接收地址`，程序会 POST `{"text": "消息内容"}`，可对接企业微信 / 钉钉 / 飞书机器人或自建服务。

---

## 十一、.env 配置项完整对照表

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | 仪表盘端口，被占用时改成 8081 等 |
| `PAPER_BALANCE` | `10000` | 模拟模式初始虚拟余额（USDC） |
| `GLOBAL_PROXY` | 空 | 全局代理，见第八节 |
| `DECIBEL_PROXY` / `EXTENDED_PROXY` / `RISEX_PROXY` | 空 | 各所独立代理 |
| `DE_MODE` / `EX_MODE` / `RS_MODE` | `paper` | 各所运行模式：`paper` 或 `live` |
| `DE_NETWORK` / `EX_NETWORK` / `RS_NETWORK` | `mainnet` | 主网 / 测试网 |
| `DECIBEL_API_KEY` | 空 | Decibel：geomi.dev 的 API Key |
| `DECIBEL_PRIVATE_KEY` | 空 | Decibel：API 钱包 Ed25519 私钥 |
| `DECIBEL_SUBACCOUNT` | 空 | Decibel：Trading Account 地址 |
| `DECIBEL_API_URL` | 官方默认 | 自定义 API 地址，一般不填 |
| `EXTENDED_API_KEY` | 空 | Extended：API Key |
| `EXTENDED_VAULT` | 空 | Extended：Vault ID |
| `EXTENDED_STARK_PRIVATE_KEY` / `EXTENDED_STARK_PUBLIC_KEY` | 空 | Extended：Stark 密钥对 |
| `EXTENDED_MAX_FEE` | `0.0005` | Extended 最大手续费率 |
| `EXTENDED_API_URL` | 官方默认 | 自定义 API 地址 |
| `ACCOUNT_ADDRESS` | 空 | RISEx：账户地址 |
| `SIGNER_PRIVATE_KEY` | 空 | RISEx：签名私钥 |
| `RISEX_API_URL` / `RISEX_WS_URL` | 官方默认 | 自定义 API / WebSocket 地址 |
| `AI_PROVIDER` | `openai` | AI 协议：`openai` / `anthropic` / `gemini` |
| `AI_API_KEY` / `AI_BASE_URL` / `AI_MODEL` / `AI_MODEL_SMALL` | 空 | 见第九节 |
| `AI_SENTINEL_MINUTES` | `5` | 哨兵巡检间隔（分钟，0=关） |
| `AI_MARKET_MINUTES` | `30` | 市况报告间隔（分钟，0=关） |
| `AI_REPORT_HOUR` | `20` | 日报生成时间（0-23 点） |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | Telegram 推送，见第十节 |
| `NOTIFY_WEBHOOK` | 空 | 通用 Webhook 推送地址 |

---

## 十二、断电 / 崩溃自动恢复机制

程序每次状态变化都会把快照写入项目目录下的 `.state.json`（自动生成，含配置、挂单、累计统计）。重启后：

1. **上次是运行状态** → 自动**续跑**：重新连接交易所，按市场名称重新解析交易对（交易所每次连接会重新编号市场 ID），接管还挂着的单，对账后继续运行。
2. **续跑失败**（如交易所连不上）→ 撤销遗留挂单，绝不在"半知半解"状态下运行网格。
3. **交易所暂时连不上** → 跳过续跑、保留挂单，等你在界面点 **🔌 重连交易所** 成功后自动接管。
4. **发现遗留持仓** → 界面弹三选项：只减仓回收 / 按现价重开网格 / 市价平仓。

累计盈亏、成交量等统计也随快照保留，跨重启连续显示。想清零就点"重置统计"。

---

## 十三、REST API 一览（进阶）

服务是纯 HTTP + SSE，可以自行编程调用。`{ex}` 为 `de` / `ex` / `rs`：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/overview` | 三所总览 |
| GET | `/api/overview/stream` | 总览 SSE 实时流 |
| GET | `/api/{ex}/markets` | 市场列表 |
| GET | `/api/{ex}/trend?marketId=&intervalSec=` | K 线 + 趋势分析 |
| GET | `/api/{ex}/state` | 机器人当前状态 |
| GET | `/api/{ex}/stream` | 单所 SSE 实时流 |
| POST | `/api/{ex}/start` | 启动网格（JSON：marketId, mode, lower, upper, gridCount, sizeBase, leverage, outOfRangeAction） |
| POST | `/api/{ex}/stop` | 停止（`{"closePosition": true/false}`） |
| POST | `/api/{ex}/adjust` | 在线调整区间 |
| POST | `/api/{ex}/cancel-orders` | 撤所有挂单 |
| POST | `/api/{ex}/close-position` | 市价平仓 |
| POST | `/api/{ex}/start-recovery` | 启动只减仓回收阶梯 |
| POST | `/api/{ex}/reset` | 重置统计 |
| POST | `/api/{ex}/reconnect` | 重连交易所 |
| GET/POST | `/api/ai/status`, `/api/ai/test`, `/api/ai/chat`, `/api/ai/analyze`, `/api/ai/report`, `/api/ai/sentinel-run`, `/api/ai/market-run` | AI 助手相关 |
| GET | `/api/proxy-check`, `/api/proxy-config` | 代理检测 / 查询 |
| POST | `/api/env` | 写入白名单内的 .env 配置（代理 / AI / 通知类，交易密钥不允许通过此接口修改） |

---

## 十四、常见问题 FAQ

**Q：双击 bat 窗口一闪而过？**
右键 bat → 编辑，确认文件完整；或先打开 cmd，把 bat 拖进去回车运行，即可看到报错信息。

**Q：提示"端口 8080 已被占用"？**
上一个程序窗口没关，先关掉；或编辑 `.env` 把 `PORT=8080` 改成 `8081`，重启后访问 `http://localhost:8081`。

**Q：npm install 很慢或失败？**
执行 `npm config set registry https://registry.npmmirror.com` 切换国内镜像后重试。

**Q：交易所显示"初始化失败 / ENOTFOUND / 连接超时"？**
网络问题。到 ⚙ IP配置页配置代理（见第八节），点"检测当前出口 IP"验证，然后点 🔌 重连交易所。

**Q：模拟模式的行情是真的吗？**
是。paper 模式拉真实行情、用虚拟资金撮合；拿不到行情时会退化为合成数据（界面会标注 dataSource）。

**Q：启动网格时报"格距过小"之类的错误？**
格距不够覆盖手续费。减少网格数量或扩大区间。

**Q：启动时报保证金不足？**
降低每格数量、减少格数，或提高杠杆（谨慎）。

**Q：想同时实盘 A 所、模拟 B 所可以吗？**
可以，三个所的 `*_MODE` 各自独立。

**Q：程序会把我的私钥传到哪里吗？**
不会。私钥只在本机 `.env`，仅用于给交易请求签名。代码全部开源可审计。

**Q：怎么彻底重置程序？**
关程序 → 删除 `.state.json`（和 `.env` 如果想清配置）→ 重新启动。

---

## 十五、项目结构

```
├── 一键启动.bat          # 模拟模式一键启动（自动装环境）
├── 实盘启动.bat          # 实盘模式启动（带确认）
├── .env.example          # 配置模板（复制为 .env 使用）
├── package.json          # 依赖与脚本定义
├── public/
│   └── index.html        # 仪表盘前端（单文件，无构建）
├── src/
│   ├── server.js         # HTTP/SSE 服务器与路由
│   ├── bot.js            # 网格机器人核心（下单/补单/风控/恢复）
│   ├── grid.js           # 网格纯函数（铺单/补单规则）
│   ├── config.js         # .env 加载与三所配置
│   ├── trend.js          # K 线趋势分析（智能填充用）
│   ├── indicators.js     # 技术指标
│   ├── proxy.js          # 代理设置与检测
│   ├── persist.js        # 状态快照持久化
│   ├── ai/               # AI 助手（provider 适配 + 服务）
│   └── exchange/
│       ├── de/           # Decibel 接入（live + paper）
│       ├── ex/           # Extended 接入（live + paper + Stark 签名）
│       └── rs/           # RISEx 接入（live + paper）
└── test/
    └── grid.test.js      # 网格逻辑单元测试
```

---

## 十六、安全须知

1. **`.env` 是最高机密**：里面的私钥等于你的资金控制权。不要截图、不要发群、不要提交到任何代码仓库（`.gitignore` 已默认排除，fork 后请保留）。
2. **优先使用交易所的 API 钱包 / API Key**，而不是主钱包私钥——API 凭据通常只有交易权限、无提币权限，泄露损失可控。
3. **实盘前先模拟**：同样的参数先在 paper 模式跑几天，理解成交节奏和风险再上真钱。
4. **小资金起步**：首次实盘用你亏得起的钱。
5. **仪表盘默认只监听本机**（localhost）。若日志提示监听 `0.0.0.0`，说明局域网内其他设备也能访问，请确保网络环境可信。
6. 本程序没有远程服务器、不上传任何数据，所有状态都在你本机。

---

祝交易顺利 📈
