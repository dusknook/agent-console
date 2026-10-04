/* 桩环境测试的共用壳
 *
 * 只做一件事：把 ai-workbench.html 的 <script> 抠出来、套上桩 DOM/localStorage/location，
 * 丢给子进程跑，然后把结果原样吐回来。痛点集中在这里，别再各复制一份。
 *
 * ---------------------------------------------------------------------------
 * 🔴 死坑（2026-10-03 定位）：子进程的 stdin 必须是 'ignore'。
 *
 *   stdio 的默认值是 ['pipe','pipe','pipe']。本机沙箱在同步 spawn 时会直接拒绝，
 *   抛 EBUSY（errno -4082，而 status / signal / stdout / stderr 全是 null/undefined）。
 *
 *   表现极具误导性：外层看到的是「子进程退出码 0、零输出、没有任何报错」——
 *   看着像测试跑过了，其实一行都没跑。ui-dom-smoke.mjs 当初写对了，
 *   新写的 ui-mock-gate.mjs 漏了这一行，于是静默空输出。
 *
 *   修法：stdio: ['ignore', 'pipe', 'pipe']。stdout/stderr 用 pipe 没问题，
 *   只有 stdin 是 'pipe' 时才会被拦。已验证 ['ignore','ignore','pipe'] / 'inherit' 均可。
 * ---------------------------------------------------------------------------
 *
 * 另外：任何情况下都不许静默失败。子进程零输出必须吼出来并判 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const ROOT = path.dirname(HERE);

/** 页面里的桩 DOM / 存储 / 地址栏。所有桩测试共用这一份，保证前提一致。 */
export const baseStub = ({ protocol = 'file:', port = '' } = {}) => `
const mkEl = () => ({ innerHTML:'', value:'', textContent:'', className:'', style:{}, dataset:{},
  querySelectorAll:()=>[], classList:{add(){},remove(){}}, onclick:null, disabled:false });
const __els = {};
globalThis.document = { getElementById: id => (__els[id] = __els[id] || mkEl()), querySelectorAll: () => [] };
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { protocol:${JSON.stringify(protocol)}, port:${JSON.stringify(port)} };
globalThis.__els = __els;
const $t = id => document.getElementById(id);
`;

function extractPageScript() {
  const html = fs.readFileSync(path.join(ROOT, 'ai-workbench.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('ai-workbench.html 里没找到 <script> 块');
  return m[1];
}

/**
 * @param {object} o
 * @param {string} o.stub   桩代码（用 baseStub() 拼出来）
 * @param {string} o.tests  测试体。约定：自己 console.log PASS/FAIL，
 *                          结尾打印 `---- N passed / M failed ----`
 * @param {string} [o.tmpName]
 */
export function runStubbed({ stub, tests, tmpName = '.stub-run.mjs' }) {
  const tmp = path.join(ROOT, tmpName);
  fs.writeFileSync(tmp, stub + extractPageScript() + '\n' + tests);

  let out = '';
  try {
    out = execFileSync(process.execPath, ['--no-warnings', tmp], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],   // stdin 必须 'ignore'，见文件头
    });
    process.stdout.write(out);
  } catch (e) {
    process.stdout.write(e.stdout || '');
    process.stderr.write(e.stderr || '');
    if (!e.stdout && !e.stderr) {
      console.error('\n  [x] 子进程零输出 —— 这多半是 spawn 根本没起来，不是断言挂了。');
      console.error('      code=' + e.code + '  errno=' + e.errno + '  syscall=' + e.syscall);
      if (e.code === 'EBUSY') {
        console.error('      EBUSY = 沙箱拦掉了同步 spawn。检查 stdio[0] 是否为 "ignore"（不能是 "pipe"）。');
      }
      console.error('      若 code 是 undefined，把 catch 里的 e 整个打出来看。');
    }
    process.exitCode = 1;
    return;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }

  if (!/0 failed/.test(out)) {
    console.error('\n  [x] 子进程没有跑出 "0 failed"（实收 ' + out.length + ' 字节输出）');
    process.exitCode = 1;
  }
}
