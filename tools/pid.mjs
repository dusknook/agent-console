/* 查后端 pid，给批处理用来停止服务
 *   node tools/pid.mjs http://127.0.0.1:8787
 * 没在跑就退出码 1、不输出。
 */
const base = process.argv[2] || 'http://127.0.0.1:8787';
try {
  const r = await fetch(base + '/v1/health');
  if (!r.ok) process.exit(1);
  const j = await r.json();
  process.stdout.write(String(j.data.pid));
} catch { process.exit(1); }
