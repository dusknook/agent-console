#!/usr/bin/env bash
# 十一套测试总入口（bash 版 · 本机已验证）
#   ./run-tests.sh
# 自动：清理端口 → 起三个实例（8787/8788 共库，8789 带裁决密钥且独立库）
#      → 跑七套 → 裁决密钥 → 采集指纹 → 杀掉全部 → 重启 → 验证持久化
#      → 端到端验收（人读证据版）→ AI 视角验收（以 agent 为第一用户）→ 汇总
# 跑完保留 8787 实例。
#
# 最后两套的分别：
#   acceptance.mjs   人走一遍真流程，验证「体验是对的」
#   agent-trial.mjs  剥夺内幕（只用 HTTP + 契约、不读源码、不依赖中文），
#                    度量「AI 用起来顺不顺」—— 往返数 / token / 需猜次数 / 可程序化程度
# 这个产品的第一用户是 agent，所以第二套才是主验收。
# 另有一套「真浏览器双窗口」验收不在这里：它需要一个带调试端口的 Chrome，
# 属于人工验收而非 CI。用法见 acceptance-browser.mjs 头部注释。
set -u
cd "$(dirname "$0")"

# 每套输出同时落盘，供 tools/collect-tests.mjs 解析出机器可读的 .tests-summary.json。
# 交付包断言数一律从这份文件读，**不硬编码** —— 旧日志冒充新证据是踩过的坑，所以每次清空重采。
LOG=".testlog-all.txt"
: > "$LOG"

NODE="C:/Users/30762/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
[ -x "$NODE" ] || NODE="node"
ROOTW="$(pwd -W 2>/dev/null || pwd)"
SECRET_DB="$ROOTW/agent-console-secret.sqlite"
SECRET_VAL="apr_secret_probe_2026"
PASS=0; FAIL=0

pid_on(){ "$NODE" --no-warnings tools/pid.mjs "http://127.0.0.1:$1" 2>/dev/null; }
stop_port(){
  local p; p="$(pid_on "$1")"
  if [ -n "$p" ]; then taskkill //PID "$p" //F >/dev/null 2>&1 && echo "  已停止 :$1 (pid $p)"; fi
  for i in $(seq 1 40); do [ -z "$(pid_on "$1")" ] && return; sleep 0.12; done
}
wait_up(){
  for i in $(seq 1 60); do [ -n "$(pid_on "$1")" ] && { echo "  :$1 就绪 (pid $(pid_on "$1"))"; return 0; }; sleep 0.2; done
  echo "  [x] :$1 12 秒内没起来"; return 1
}
# 跑一条命令：屏幕照打，同时追加到 $LOG（供采集器解析）。返回被跑命令的退出码。
run_logged(){
  local out=".suite-out.$$"
  "$@" > "$out" 2>&1
  local rc=$?
  cat "$out"
  cat "$out" >> "$LOG"
  rm -f "$out"
  return $rc
}
suite(){
  local name="$1" file="$2"; shift 2
  echo ""
  echo "============================================================"
  echo "  $name"
  echo "============================================================"
  if run_logged "$NODE" --no-warnings "$file" "$@"; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}

echo "清理端口上的旧实例…"
stop_port 8787; stop_port 8788; stop_port 8789
rm -f agent-console.sqlite* agent-console-secret.sqlite*
sleep 0.4

echo "拉起三个后端实例（A/B 共库；C 带 APPROVAL_SECRET、独立库）…"
PORT=8787 "$NODE" --no-warnings server.js >/dev/null 2>&1 &
PORT=8788 "$NODE" --no-warnings server.js >/dev/null 2>&1 &
PORT=8789 DB="$SECRET_DB" APPROVAL_SECRET="$SECRET_VAL" "$NODE" --no-warnings server.js >/dev/null 2>&1 &
wait_up 8787 || exit 2
wait_up 8788 || exit 2
wait_up 8789 || exit 2
echo "  db=$ROOTW/agent-console.sqlite  journal=$("$NODE" --no-warnings -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>r.json()).then(j=>console.log(j.data.journal_mode))")"
echo "  门控端点=$("$NODE" --no-warnings -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>r.json()).then(j=>console.log(j.data.gate.policy.length))")  裁决密钥=:$("$NODE" --no-warnings -e "fetch('http://127.0.0.1:8789/v1/health').then(r=>r.json()).then(j=>console.log(j.data.gate.approval_secret_required))")"

suite "1/11 后端单进程冒烟（含门控路径）"           smoke-http.mjs
suite "2/11 门控 · 拦截 / 挂起 / 裁决 / 回放"       smoke-approval.mjs
suite "3/11 跨进程 · 幂等与租约仲裁"                smoke-multiproc.mjs
suite "4/11 跨进程 · 门控与并发裁决"                smoke-approval.mjs --xproc
suite "5/11 契约导出 · OpenAPI 不漂移且不撒谎"      smoke-openapi.mjs
suite "6/11 前端 DOM 冒烟（走真 HTTP + 真闸门）"     tests/ui-dom-smoke.mjs
suite "7/11 前端离线降级（mock 里闸门也照常成立）"   tests/ui-mock-gate.mjs

echo ""
echo "============================================================"
echo "  8/11 裁决密钥（闸门脱离「本机即信任」）"
echo "============================================================"
echo "  提示：本套只允许显式带上密钥跑，故意不给它走 :suite 的默认环境"
if run_logged env APPROVAL_SECRET="$SECRET_VAL" "$NODE" --no-warnings smoke-approval.mjs --secret; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "============================================================"
echo "  9/11 重启持久化（含待批队列跨重启存活）"
echo "============================================================"
run_logged "$NODE" --no-warnings smoke-restart.mjs snap
echo ""
echo "  杀掉全部后端进程（状态此刻只存在于 sqlite 文件里）…"
stop_port 8787; stop_port 8788; stop_port 8789; sleep 0.4
if [ -z "$(pid_on 8787)" ]; then echo "  确认 8787 已无人监听"; else echo "  [x] 8787 仍有进程"; fi
echo "  重启单个实例…"
PORT=8787 "$NODE" --no-warnings server.js >/dev/null 2>&1 &
wait_up 8787 || exit 2
if run_logged "$NODE" --no-warnings smoke-restart.mjs verify; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi

echo ""
echo "============================================================"
echo "  10/11 端到端验收（人读证据版：拦得住 / 批得动 / 文档不撒谎）"
echo "============================================================"
echo "  它不是断言机器（那是上面九套的活），是把人真正会走的那几条路走一遍，"
echo "  每步打印真实 Request ID 与前后状态。全量输出在 .acceptance.txt。"
if "$NODE" --no-warnings acceptance.mjs > .acceptance.txt 2>&1; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi
grep -E "验收项|全部通过|有失败项" .acceptance.txt || tail -4 .acceptance.txt

echo ""
echo "============================================================"
echo "  11/11 AI 视角验收（以 agent 为第一用户，剥夺内幕后测量摩擦）"
echo "============================================================"
echo "  这一套才是主验收：不看代码、不用中文、只用 HTTP 与契约。"
echo "  它度量的是往返数 / token / 需猜次数 / 可程序化程度 —— "
echo "  这些恰恰是人点按钮时永远看不见的东西。全量输出在 .agent-trial.txt。"
# --json 顺手把 baseline 一起刷新：它是交付物「基线数字」的来源之一，
# 只靠手动跑就会静默过期（踩过：交付物印着比实测更旧的 tokens）。
if "$NODE" --no-warnings agent-trial.mjs --json EVAL-PACKAGE/agent-trial-baseline.json > .agent-trial.txt 2>&1; then
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi
grep -E "项判定|FRICTION|BLOCKER" .agent-trial.txt | tail -6

echo ""
echo "============================================================"
echo "  采集机器可读结果（交付包读它，不硬编码数字）"
echo "============================================================"
"$NODE" --no-warnings tools/collect-tests.mjs || echo "  [warn] 采集失败：交付包会标注「未采集」，绝不改用旧数字"

echo ""
echo "============================================================"
echo "  汇总：$PASS 套通过 / $FAIL 套失败"
echo "============================================================"
echo "  服务保持运行： http://127.0.0.1:8787/"
exit $FAIL
