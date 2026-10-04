#!/usr/bin/env node
/**
 * 交付层一致性护栏：**重跑流水线 ≠ 重采输入**。
 *
 * ── 真事故（2026-10-03 19:32）────────────────────────────────────────
 * 生成器有两类输入，新鲜度不同：
 *   · 契约（速查表 / 契约全文）  ← 走 **live** 服务，每次生成现拉
 *   · 证据（403 样本 / 响应头）  ← 走 **冻结快照** EVAL-PACKAGE/snapshot/
 * 19:32 重跑生成链时服务是活的，契约更新到了 cc64b0c7a9178b32；
 * 但快照没人重采，还停在 19:12 的 c92ee81bdf73b795。结果同一份交付物里
 * **两个 contract_digest 并存**，包内自相矛盾。
 *
 * 更糟的是旧快照里还留着已修掉的 `"x-requires": "auto | human"` 复合字符串 ——
 * 评测者读「关键证据原文」章节，会复报一个**已经修好**的缺陷，
 * 或者直接判定「这个包内部不一致，证据不可信」。两种都很贵。
 *
 * ── 处置 ────────────────────────────────────────────────────────────
 * 只要活服务可达，交付物里每一份契约副本都必须与活契约同摘要，否则**拒绝生成**。
 * 不做静默降级：服务不可达时才允许整包用快照，且必须显式标注来源。
 * 让生成器自己拦住 —— 同一个坑踩两次之后，不该再靠「我下次注意」。
 */
import fs from 'node:fs';
import path from 'node:path';

const rd = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

/** 读文件里的 contract_digest；读不到/没有就返回 null（绝不猜）。 */
export function digestIn(p) {
  try {
    const j = JSON.parse(rd(p));
    return j?.['x-agent-console']?.contract_digest || null;
  } catch { return null; }
}

/** 问活服务要 digest；服务没开/超时返回 null。 */
export async function liveDigestOf(base, timeoutMs = 3000) {
  try {
    const r = await fetch(`${base}/v1/openapi.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json())?.['x-agent-console']?.contract_digest || null;
  } catch { return null; }
}

/**
 * 比对若干份契约副本与活契约的摘要。
 * @param {{label:string, digest:string|null, path:string}[]} sources
 * @param {string|null} liveDigest  活服务摘要；null = 服务不可达
 * @param {string} base
 */
export function assertContractDigestsAgree(sources, liveDigest, base) {
  if (!liveDigest) {
    console.warn('⚠  活服务（' + base + '）不可达 —— 无法核对契约新鲜度。');
    console.warn('   本产物里所有契约内容均来自冻结输入，请在产物内如实标注来源，不要假装它描述的是正在跑的进程。');
    return { checked: false, liveDigest: null };
  }

  const bad = sources.filter((s) => s.digest !== liveDigest);
  if (bad.length === 0) {
    console.log('✔ 契约一致性：' + sources.map((s) => s.label).join(' / ') + ' 摘要均为 ' + liveDigest);
    return { checked: true, liveDigest };
  }

  console.error('\n✖ 契约摘要不一致 —— 拒绝生成，绝不静默用旧数据。\n');
  console.error('  活服务        : ' + liveDigest + '   ← ' + base + '/v1/openapi.json');
  for (const b of bad) {
    console.error('  ' + b.label.padEnd(10) + ': ' + (b.digest || '(未声明)') + '   ← ' + b.path);
  }
  console.error('\n  最常见的原因：改了服务或契约之后**只重跑了生成链，没有重采快照**。');
  console.error('  生成器的契约走 live、证据走快照 —— 不重采输入，产出物就会自相矛盾：');
  console.error('  速查表是新摘要，证据章节的响应头是旧摘要，评测者一眼就看得出。\n');
  console.error('  修法：node tools/make-eval-snapshot.mjs      （服务需在 ' + base + ' 运行）');
  console.error('        然后按 package → site → start 的顺序重跑本生成器。\n');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 第二道护栏：证据样本的新鲜度。
//
// ── 真事故（2026-10-03 20:23）─────────────────────────────────────────────
// 第一道护栏（契约摘要）只保了「契约」这一条输入。**证据样本那条通道仍然裸奔。**
// 事故形态：交付物里写着 `"bytes": 1260`（描述 GET / 的根索引响应），
// 而实测是 1263 —— 差 3 字节。根因不是采集错了，而是那份响应里含**运行态字段**：
//   _meta.request_id / _meta.latency_ms / _meta.budget.reserved
// 采集那一刻 reserved=0，之后服务跑着跑着变成 0.42 —— 恰好 3 字节。
// 也就是说：**只要响应含运行态字段，写进交付物的字节数就必然过期**，
// 而评测者拿它去核对，只会得出「这包数字不实」的结论。
//
// ── 处置 ────────────────────────────────────────────────────────────────
// 1) 采集器对无副作用的端点**连采两次**，自动 diff 出运行态字段清单（不靠人猜），
//    写进样本的 `_volatile.fields`，并把字节数记成观测区间。
// 2) 本护栏重放这些端点，**只屏蔽 `_volatile.fields` 里的路径**后做深度相等断言：
//      · 全部差异都落在清单内  → 通过（漂移是已知的、已被标注的）
//      · 出现清单外的任何差异  → exit 1（说明漂移清单不完整，或语义真的变了）
//    这一步的价值在于：**运行态字段不可能再悄悄增加** —— 新增一个就会立刻被抓住。
// ─────────────────────────────────────────────────────────────────────────────

/** 把 `a.b[0].c` 解析成 ['a','b',0,'c'] */
export function parsePath(s) {
  const out = [];
  String(s).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
    .forEach((k) => out.push(/^\d+$/.test(k) ? Number(k) : k));
  return out;
}

/** 就地把某路径的值替换成哨兵（不存在则跳过） */
export function maskPath(obj, pathStr, sentinel = '__VOLATILE__') {
  const keys = parsePath(pathStr);
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return obj;
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (cur != null && typeof cur === 'object' && last in cur) cur[last] = sentinel;
  return obj;
}

/** 深度 diff：返回所有不相等的路径（`a.b[0].c` 形式） */
export function diffPaths(a, b, base = '', out = []) {
  if (a === b) return out;
  const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push(base || '(root)'); return out; }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = base ? base + '.' + k : k;
      if (!(k in a) || !(k in b)) { out.push(p); continue; }
      diffPaths(a[k], b[k], p, out);
    }
    return out;
  }
  if (ta === 'array') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const p = base + '[' + i + ']';
      if (i >= a.length || i >= b.length) { out.push(p); continue; }
      diffPaths(a[i], b[i], p, out);
    }
    return out;
  }
  out.push(base);
  return out;
}

/**
 * 重放**无副作用**的样本端点，断言「与快照的差异只出现在已知运行态字段内」。
 * 有副作用的样本（撞门控会造待审批单、单查依赖那张单）不在这里重放 —— 见 README 的说明。
 *
 * @param {string} snapDir  EVAL-PACKAGE/snapshot
 * @param {string} base     活服务地址
 * @param {number} timeoutMs
 */
export async function assertSamplesStable(snapDir, base, timeoutMs = 3000) {
  const PROBES = [
    { file: 'bootstrap-root.sample.json', path: '/', headers: { accept: '*/*' } },
    { file: 'health.sample.json', path: '/v1/health', headers: undefined },
  ];

  let liveOk = false;
  try {
    const r = await fetch(base + '/v1/health', { signal: AbortSignal.timeout(timeoutMs) });
    liveOk = r.ok;
  } catch { liveOk = false; }

  if (!liveOk) {
    console.warn('⚠  活服务（' + base + '）不可达 —— 跳过证据样本新鲜度核对。');
    console.warn('   请确保产物内如实标注这些样本是**冻结快照**，不代表正在跑的进程。');
    return { checked: false };
  }

  const problems = [];
  const notes = [];

  for (const probe of PROBES) {
    const fp = path.join(snapDir, probe.file);
    if (!fs.existsSync(fp)) { notes.push(`  (跳过 ${probe.file}：文件不存在)`); continue; }
    const snap = JSON.parse(rd(fp));
    const volatileFields = snap?._volatile?.fields || [];

    let r;
    try { r = await fetch(base + probe.path, probe.headers ? { headers: probe.headers } : undefined); }
    catch (e) { notes.push(`  (跳过 ${probe.file}：重放失败 ${e.message})`); continue; }
    const live = await r.json();

    // 只屏蔽快照声明的运行态字段，别的一律不允许有差异 —— 白名单越窄，护栏越有牙
    const a = JSON.parse(JSON.stringify(snap.body));
    const b = JSON.parse(JSON.stringify(live));
    for (const f of volatileFields) { maskPath(a, f); maskPath(b, f); }

    const diffs = diffPaths(a, b);
    if (diffs.length === 0) {
      notes.push(`  ✔ ${probe.file}  语义一致（已屏蔽 ${volatileFields.length} 个运行态字段：${volatileFields.join(', ') || '无'}）`);
    } else {
      problems.push({ file: probe.file, path: probe.path, diffs, volatileFields });
    }
  }

  if (problems.length === 0) {
    notes.forEach((n) => console.log(n));
    console.log('✔ 证据样本新鲜度：无副作用的样本重放后语义一致（运行态字段已按 _volatile.fields 屏蔽）');
    return { checked: true };
  }

  console.error('\n✖ 证据样本与活服务语义不一致 —— 拒绝生成。\n');
  for (const p of problems) {
    console.error('  ' + p.file + '   ← ' + p.path);
    console.error('    快照声明的运行态字段：' + (p.volatileFields.join(', ') || '(无)'));
    console.error('    屏蔽之后仍然对不上的路径：');
    p.diffs.slice(0, 12).forEach((d) => console.error('      · ' + d));
    if (p.diffs.length > 12) console.error('      …还有 ' + (p.diffs.length - 12) + ' 处');
  }
  console.error('\n  两种可能：');
  console.error('   1) 响应里出现了**新的运行态字段**，而采集时的双采 diff 没覆盖到它 —— 这是最常见的。');
  console.error('   2) 服务语义真的变了（改了字段/文案），快照已过时。');
  console.error('\n  两种都靠同一条命令解决：node tools/make-eval-snapshot.mjs（服务需在 ' + base + ' 运行）');
  console.error('  它会重新双采、重算 _volatile.fields，然后按 package → site → start 重跑生成器。\n');
  process.exit(1);
}

