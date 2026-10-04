@echo off
chcp 65001 >nul
cd /d "%~dp0"
title agent-console server

set "NODE=C:\Users\30762\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" set "NODE=node"

echo.
echo   Agent Console 后端 v4
echo   -------------------------------------------
echo   db  : %DB%
if "%DB%"=="" echo   db  : %~dp0agent-console.sqlite
echo   ui  : http://127.0.0.1:8787/
echo   密钥: %APPROVAL_SECRET%
if "%APPROVAL_SECRET%"=="" echo   密钥: （未启用 —— 裁决端点依赖「本机单人」前提）
echo.
echo   关掉这个窗口 = 停掉闸门。页面会退回本地 mock 模式。
echo.

"%NODE%" --no-warnings server.js

echo.
echo   服务已退出（code=%errorlevel%）。窗口保持打开，方便看报错。
pause
