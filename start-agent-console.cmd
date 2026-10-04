@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agent Console

set "NODE=C:\Users\30762\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" set "NODE=node"

REM 已经在跑就别重复起
"%NODE%" --no-warnings -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if %errorlevel%==0 (
  echo   [i] 后端已在运行，直接打开页面。
  start "" "http://127.0.0.1:8787/"
  exit /b 0
)

echo   [1/2] 启动后端...
start "agent-console server" /min cmd /c _serve.cmd

echo   [2/2] 等待就绪...
set /a tries=0
:wait
set /a tries+=1
"%NODE%" --no-warnings -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >nul 2>nul
if %errorlevel%==0 goto ready
if %tries% GEQ 40 goto failed
ping -n 1 -w 250 127.0.0.1 >nul
goto wait

:ready
echo        就绪。
start "" "http://127.0.0.1:8787/"
exit /b 0

:failed
echo   [x] 10 秒内没起来。到最小化的那个窗口看报错。
echo       常见原因：端口 8787 被占用 → 换端口： set PORT=8790 ^&^& node server.js
pause
exit /b 1
