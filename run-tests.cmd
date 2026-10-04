@echo off
chcp 65001 >nul
cd /d "%~dp0"
setlocal enabledelayedexpansion
title Agent Console 测试

set "NODE=C:\Users\30762\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" set "NODE=node"

set "SECRET_VAL=apr_secret_probe_2026"
set PASS=0
set FAIL=0

echo ============================================================
echo   清理端口与数据库
echo ============================================================
call :stop 8787
call :stop 8788
call :stop 8789
del /q agent-console.sqlite* >nul 2>nul
del /q agent-console-secret.sqlite* >nul 2>nul
timeout /t 1 /nobreak >nul

echo ============================================================
echo   拉起三个后端实例（A/B 共库；C 带裁决密钥、独立库）
echo ============================================================
set "PORT=8787"
start "ac-A" /min cmd /c _serve.cmd
set "PORT=8788"
start "ac-B" /min cmd /c _serve.cmd
set "PORT=8789"
set "DB=%~dp0agent-console-secret.sqlite"
set "APPROVAL_SECRET=%SECRET_VAL%"
start "ac-C" /min cmd /c _serve.cmd
set "PORT="
set "DB="
set "APPROVAL_SECRET="
call :wait 8787 || goto :bail
call :wait 8788 || goto :bail
call :wait 8789 || goto :bail
echo   三个实例就绪（:8789 已启用 APPROVAL_SECRET）。
echo.

call :suite "1/11 后端单进程冒烟（含门控路径）"          smoke-http.mjs
call :suite "2/11 门控 · 拦截 / 挂起 / 裁决 / 回放"      smoke-approval.mjs
call :suite "3/11 跨进程 · 幂等与租约仲裁"               smoke-multiproc.mjs
call :suite "4/11 跨进程 · 门控与并发裁决"               smoke-approval.mjs --xproc
call :suite "5/11 契约导出 · OpenAPI 不漂移且不撒谎"     smoke-openapi.mjs
call :suite "6/11 前端 DOM 冒烟（走真 HTTP + 真闸门）"    tests\ui-dom-smoke.mjs
call :suite "7/11 前端离线降级（mock 里闸门也照常成立）"  tests\ui-mock-gate.mjs

echo ============================================================
echo   8/11 裁决密钥（闸门脱离「本机即信任」）
echo ============================================================
set "APPROVAL_SECRET=%SECRET_VAL%"
"%NODE%" --no-warnings smoke-approval.mjs --secret
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
set "APPROVAL_SECRET="
echo.

echo ============================================================
echo   9/11 重启持久化（含待批队列跨重启存活）
echo ============================================================
"%NODE%" --no-warnings smoke-restart.mjs snap
echo.
echo   杀掉全部后端进程（状态此刻只存在于 sqlite 文件里）...
call :stop 8787
call :stop 8788
call :stop 8789
timeout /t 1 /nobreak >nul
echo   重启单个实例...
set "PORT=8787"
start "ac-A" /min cmd /c _serve.cmd
set "PORT="
call :wait 8787 || goto :bail
"%NODE%" --no-warnings smoke-restart.mjs verify
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.

echo ============================================================
echo   10/11 端到端验收（人读证据版：拦得住 / 批得动 / 文档不撒谎）
echo ============================================================
echo   不是断言机器（那是上面十套的活），走一遍人真正会走的路并打印证据。
"%NODE%" --no-warnings acceptance.mjs > .acceptance.txt 2>&1
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
findstr /c:"验收项" .acceptance.txt
echo.

echo ============================================================
echo   汇总：!PASS! 套通过 / !FAIL! 套失败
echo ============================================================
echo.
echo   服务仍在 8787 运行，页面： http://127.0.0.1:8787/
echo   用完请关掉那三个最小化的 "ac-A" / "ac-B" / "ac-C" 窗口。
if /i "%~1"=="/nopause" exit /b %FAIL%
pause
exit /b %FAIL%

:suite
echo ============================================================
echo   %~1
echo ============================================================
"%NODE%" --no-warnings %~2 %~3
if errorlevel 1 (set /a FAIL+=1) else (set /a PASS+=1)
echo.
exit /b 0

:wait
set /a n=0
:w1
"%NODE%" --no-warnings tools\pid.mjs http://127.0.0.1:%1 >nul 2>nul
if not errorlevel 1 exit /b 0
set /a n+=1
if %n% GEQ 60 exit /b 1
ping -n 1 -w 200 127.0.0.1 >nul
goto w1

:stop
set "P="
for /f %%p in ('"%NODE%" --no-warnings tools\pid.mjs http://127.0.0.1:%1') do set "P=%%p"
if defined P (
  taskkill /PID !P! /F >nul 2>nul
  echo   已停止 :%1  ^(pid !P!^)
) else (
  echo   :%1 没有在跑
)
exit /b 0

:bail
echo   [x] 后端没能在 12 秒内就绪，测试中止。看最小化窗口里的报错。
pause
exit /b 1
