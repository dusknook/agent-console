@echo off
chcp 65001 >nul
rem 一条命令跑完 AI 视角验收：起服务 -> 测评 -> 关服务。
rem 前提：Node 22.5 或更高（用到内置 node:sqlite）。零 npm 依赖。
rem
rem   EVAL-PACKAGE\run-eval.cmd
rem
setlocal
cd /d "%~dp0.."

if not exist server.js (
  echo [x] 这里没有 server.js。
  echo     请把整个项目目录（不只是 EVAL-PACKAGE\）一起提供 --
  echo     EVAL-PACKAGE 是文档与快照，可执行的部分在上一层。
  exit /b 1
)

set "NODE_BIN=node"
where %NODE_BIN% >nul 2>nul || (echo [x] 找不到 node。请装 Node 22.5+ 后重试。& exit /b 1)

if "%PORT%"=="" set "PORT=8787"

echo 起服务（:%PORT%，最小化窗口）...
start "agent-console-eval" /min cmd /c "set PORT=%PORT%&& node --no-warnings server.js"

set /a n=0
:waitloop
node -e "fetch('http://127.0.0.1:%PORT%/v1/health').then(()=>process.exit(0)).catch(()=>process.exit(1))" >nul 2>nul
if not errorlevel 1 goto ready
set /a n+=1
if %n% GEQ 80 (echo [x] 服务 24 秒内没起来。手动跑 node server.js 看报错。& exit /b 1)
ping -n 1 -w 250 127.0.0.1 >nul
goto waitloop

:ready
echo.
node --no-warnings agent-trial.mjs --base "http://127.0.0.1:%PORT%"
set RC=%errorlevel%

echo.
echo ------------------------------------------------------------
echo 要关掉服务，请关闭那个最小化的 "agent-console-eval" 窗口。
echo 想继续探索就留着它，然后：
echo   curl -H "Accept: application/json" http://127.0.0.1:%PORT%/
echo ------------------------------------------------------------
exit /b %RC%
