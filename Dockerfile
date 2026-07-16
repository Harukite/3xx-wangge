# 三交易所网格机器人 · 容器镜像（Dokploy / Docker 部署用）
# 多阶段构建：build 阶段编译原生模块（better-sqlite3），run 阶段精简镜像。

# ── 构建阶段 ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 为原生模块，编译需要 python3 / make / g++
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=optional || npm install --omit=optional

# ── 运行阶段 ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
# 运行 better-sqlite3 原生模块所需（bookworm-slim 已含 libstdc++6，显式声明以保险）
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node test ./test
# data/（SQLite）与 .state.json 运行时写入：预先创建并归属 node 用户
RUN mkdir -p data && chown -R node:node /app
EXPOSE 8080
USER node
# 容器健康检查（Dokploy / Docker 探活；用 node 内置 fetch，免装 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
