@echo off
chcp 65001 >nul
title 三交易所网格机器人（实盘模式）
cd /d "%~dp0"

echo ╔══════════════════════════════════════════╗
echo ║  三交易所网格机器人  [实盘模式]          ║
echo ║  ⚠ 此模式涉及真实资金，请谨慎操作！      ║
echo ╚══════════════════════════════════════════╝
echo.

rem ── 第 1 步：检查 Node.js ─────────────────────
where node >nul 2>nul
if not errorlevel 1 goto node_ok

echo [环境] 未检测到 Node.js，尝试自动安装...
where winget >nul 2>nul
if errorlevel 1 goto manual_node

winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
set "PATH=%PATH%;%ProgramFiles%\nodejs;%APPDATA%\npm"
where node >nul 2>nul
if not errorlevel 1 goto node_ok

:manual_node
echo.
echo [提示] 自动安装失败，已为你打开 Node.js 官网下载页。
echo        请下载并安装 LTS 版本，v20 或更高，安装完成后重新双击本脚本。
start https://nodejs.org/zh-cn/download
pause
exit /b 1

:node_ok
for /f "delims=" %%v in ('node -v') do echo [环境] Node.js %%v 已就绪

rem ── 第 2 步：检查配置文件 ──────────────────────
if not exist ".env" (
  echo.
  echo [错误] 未找到 .env 文件！
  echo        实盘模式必须先配置 API 密钥：
  echo        1. 复制 .env.example 为 .env
  echo        2. 按 README.md 教程填入交易所凭据，并把对应的
  echo           DE_MODE / EX_MODE / RS_MODE 改为 live
  pause
  exit /b 1
)

rem ── 第 3 步：安装依赖，仅首次 ──────────────────
if not exist "node_modules" (
  echo [安装] 首次运行，正在安装依赖，需要联网，约 1-3 分钟...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，常见原因是网络不通。
    echo        可先执行下面这行命令切换国内镜像，再重新双击本脚本：
    echo        npm config set registry https://registry.npmmirror.com
    pause
    exit /b 1
  )
  echo [安装] 依赖安装完成
)

rem ── 第 4 步：实盘确认 ──────────────────────────
echo.
echo 请确认已在 .env 中：
echo   1. 把要实盘的交易所 DE_MODE / EX_MODE / RS_MODE 设为 live
echo   2. 填写了对应交易所的 API 凭据
echo.
set /p CONFIRM="输入 YES 继续，其他任意键取消: "
if /i not "%CONFIRM%"=="YES" (
  echo 已取消。
  pause
  exit /b 0
)

rem ── 第 5 步：启动并自动打开浏览器 ──────────────
echo.
echo 正在启动... 4 秒后自动打开浏览器仪表盘
echo 仪表盘地址：http://localhost:8080
echo 关闭本窗口 = 停止所有机器人
echo.
start "" /min cmd /c "timeout /t 4 /nobreak >nul & start http://localhost:8080"
node src/server.js

echo.
echo 程序已退出。
pause
