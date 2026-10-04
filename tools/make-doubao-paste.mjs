// 粘贴通道交付层：把「豆包开测版」切成若干条可粘贴的纯文本分片。
//
// 为什么需要它：URL 通道不是万能的。对方（另一个模型/聊天窗口）可能完全抓不到网，
// 或者抓到了但解析失败。这时唯一可用的通道是「人肉复制粘贴」，而聊天窗口有长度上限。
// 分片必须满足两个硬条件：
//   1) 每片足够短，能一次贴完不被截断；
//   2) 片与片之并 == 原文，不丢一行、不重一行。
// 条件 2 不靠人眼核对，靠机器断言：把 N 片的 body 拼回来，必须与原文逐字节相等。
//
// ── 切点为什么不能硬编码（2026-10-03 21:0x 真事故）──────────────────────
// 上一版把切点写成 `[97, 464, 656]`。内容一变（证据章节因为加了 _volatile 块，
// 从 12KB 涨到 16.9KB），行号全错位 —— 第 4 片直接 15.1KB 超限，S3 自检拦下。
// **行号是最脆的硬编码**：任何一次正文增删都会让它失效。
// 改成：按「章节边界」自动切 + 体积约束贪心。三级优先级 ——
//   ① `## ` 一级章节边界   ② `### ` 小节边界   ③ 任意空行边界
// 每片在 ≤ MAX 的前提下尽量往后吃，且切点天然落在空行上，不会劈开表格或段落。
//
// 切分点还必须保证不劈开代码块 —— 见 S4。**空行边界挡不住这件事**：
// Markdown 代码块内部允许空行，实测曾有合法切点落在块内。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/2026-10-03-16-38-27';
const SRC = path.join(ROOT, 'DOUBAO-DELIVERY/豆包开测版.md');
const OUT = path.join(ROOT, 'DOUBAO-DELIVERY/粘贴版');
const MAX_BYTES = 13000;

if (!fs.existsSync(SRC)) {
  console.error(`找不到源文件 ${SRC}`);
  process.exit(1);
}

// 统一换行，保证拼回可逐字节比较
const raw = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n'); // 若原文以 \n 结尾，末尾会有一个 '' —— 保留它，join 才能还原

const isBlank = (s) => s !== undefined && s.trim() === '';
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const bytesOf = (a, b) => bytes(lines.slice(a, b).join('\n'));

// ---------- 1. 自动选切点 ----------
// 合法边界 = 前面是空行、自己非空（这样切下去不会把段落/表格拦腰截断）
const B_H2 = []; const B_H3 = []; const B_ANY = [];
for (let i = 1; i < lines.length; i++) {
  if (!(isBlank(lines[i - 1]) && !isBlank(lines[i]))) continue;
  B_ANY.push(i);
  if (/^##\s/.test(lines[i])) B_H2.push(i);
  else if (/^###\s/.test(lines[i])) B_H3.push(i);
}

const bounds = [0];
let start = 0;
let guard = 0;
while (start < lines.length) {
  if (++guard > 500) { console.error('切分未收敛 —— 疑似死循环'); process.exit(1); }
  let end = null;
  if (bytesOf(start, lines.length) <= MAX_BYTES) {
    // 剩下的全装得下 → 直接收尾。
    // 少了这一条，文件末尾不构成 `## ` 边界，贪心会切出 0.0KB 的碎渣尾片。
    end = lines.length;
  } else {
    for (const pool of [B_H2, B_H3, B_ANY]) {
      const ok = pool.filter((e) => e > start && bytesOf(start, e) <= MAX_BYTES);
      if (ok.length) { end = ok[ok.length - 1]; break; }
    }
    if (end === null) {
      // 连最近的边界都装不下（存在不可分的巨块）—— 退一步只前进一步，别卡死。
      end = B_ANY.find((e) => e > start) ?? lines.length;
    }
  }
  bounds.push(end);
  start = end;
}

const parts = [];
for (let k = 0; k + 1 < bounds.length; k++) {
  parts.push({ body: lines.slice(bounds[k], bounds[k + 1]).join('\n'), startLine: bounds[k] + 1, endLine: bounds[k + 1] });
}
const cuts = bounds.slice(1, -1); // 内部切点（最后一个是文件末尾，不算切点）

// 每片的可读标题：取该片第一个 `##`/`###` 标题
const titleOf = (k) => {
  const seg = lines.slice(bounds[k], bounds[k + 1]);
  const h = seg.find((l) => /^#{2,3}\s/.test(l));
  return h ? h.replace(/^#{2,3}\s*/, '').trim() : '（无标题片段）';
};
const titles = parts.map((_, k) => titleOf(k));

// ---------- 2. 自检 ----------
let failed = 0;
const chk = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  —— ' + detail : ''}`);
  if (!ok) failed++;
};

console.log(`源文件 ${(bytes(raw) / 1024).toFixed(1)} KB / ${lines.length} 行 → 切 ${parts.length} 片\n`);

// S1 拼回恒等
const rejoined = parts.map((p) => p.body).join('\n');
chk(rejoined === raw, 'S1 分片拼回 === 原文（逐字节）', `${bytes(rejoined)}B vs ${bytes(raw)}B`);

// S2 行数守恒
const totalLines = parts.reduce((a, p) => a + (p.endLine - p.startLine + 1), 0);
chk(totalLines === lines.length, 'S2 行数守恒', `${totalLines} vs ${lines.length}`);

// S3 每片体积
parts.forEach((p, i) => {
  const b = bytes(p.body);
  chk(b <= MAX_BYTES, `S3.${i + 1} 第 ${i + 1} 片 ≤ ${(MAX_BYTES / 1024).toFixed(0)}KB`, `${(b / 1024).toFixed(1)} KB  「${titles[i]}」`);
});

// S4 每片代码块闭合（``` 计数为偶）—— 劈开代码块是分片最典型的翻车方式
parts.forEach((p, i) => {
  const n = (p.body.match(/^```/gm) || []).length;
  chk(n % 2 === 0, `S4.${i + 1} 第 ${i + 1} 片代码围栏成对`, `计数 ${n}`);
});

// S5 切点必须落在空行后
cuts.forEach((c, i) => {
  chk(isBlank(lines[c - 1]), `S5.${i + 1} 第 ${i + 1} 个切点落在空行`, `行 ${c - 1} = ${JSON.stringify(lines[c - 1] || '')}`);
});

// S6 关键锚点未被切坏
// 摘要类锚点**从契约现场读**，不写死：写死就会变成「内容一变、自检先坏」——
// 而这个自检本来是拿来抓**切分**问题的，不该被契约更新打成假警报。
const contractPath = path.join(ROOT, 'DOUBAO-DELIVERY/多文件版/06_契约全文.openapi.json');
const liveDigest = JSON.parse(fs.readFileSync(contractPath, 'utf8'))['x-agent-console'].contract_digest;
const ANCHORS = [
  'REQUIRE_APPROVAL', 'stop_retry', 'optional', liveDigest,
  '六维检查清单', '输出模板', '已知边界', '第 0 步：评估条件声明',
];
for (const a of ANCHORS) {
  const inParts = parts.map((p, i) => (p.body.includes(a) ? i + 1 : 0)).filter(Boolean);
  chk(inParts.length > 0, `S6 锚点在场「${a}」`, `落在第 ${inParts.join(',')} 片`);
}

// S7 没有空片
parts.forEach((p, i) => chk(p.body.trim().length > 0, `S7.${i + 1} 第 ${i + 1} 片非空`));

// S8 片头行号必须连续且覆盖全文（把「贴漏了」变成可机器检查的事）
const gaps = [];
for (let i = 1; i < parts.length; i++) {
  if (parts[i].startLine !== parts[i - 1].endLine + 1) gaps.push(`${parts[i - 1].endLine}→${parts[i].startLine}`);
}
chk(gaps.length === 0, 'S8 片头行号连续无缺口', gaps.length ? gaps.join(', ') : `1–${lines.length}`);

if (failed) {
  console.error(`\n自检未通过（${failed} 项失败）—— 不写出任何文件。`);
  process.exit(1);
}

// ---------- 3. 落盘 ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const slugOf = (s) => s.replace(/[\\/:*?"<>|`()（）]/g, '').replace(/[·—]/g, '').replace(/\s+/g, '_').slice(0, 22);
const fileOf = (i) => `${String(i + 1).padStart(2, '0')}_${slugOf(titles[i])}.md`;

const written = [];
for (let i = 0; i < parts.length; i++) {
  const p = parts[i];
  const head =
    `【粘贴第 ${i + 1} / ${parts.length} 片】${titles[i]}\n` +
    `【正文行 ${p.startLine}–${p.endLine}，共 ${lines.length} 行；本片 ${(bytes(p.body) / 1024).toFixed(1)} KB】\n` +
    (i === 0
      ? `【这是完整评测包的开头。后续还有 ${parts.length - 1} 片，请按序号连续贴完再开工。】\n`
      : `【接上一条消息的第 ${i} 片，本条是第 ${i + 1} 片，请继续贴完。】\n`) +
    `${'-'.repeat(60)}\n`;
  const fp = path.join(OUT, fileOf(i));
  fs.writeFileSync(fp, head + p.body, 'utf8');
  written.push({ fp, bytes: bytes(p.body), total: bytes(head + p.body) });
}

// 全量单条（与源文件同字节，用于对方能收长文本时一次贴完）
const fullBytes = bytes(raw);
const fpFull = path.join(OUT, '00_全量单条.md');
fs.writeFileSync(fpFull, raw, 'utf8');
chk(fs.readFileSync(fpFull, 'utf8') === raw, 'S9 全量单条与开测版同字节', `${(fullBytes / 1024).toFixed(1)} KB`);

// ---------- 4. README：所有数字由程序算，不手写 ----------
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
const rows = written
  .map((w, i) => `| ${i + 1} | \`${path.basename(w.fp)}\` | ${kb(w.bytes)} | ${kb(w.total)} | ${titles[i]} |`)
  .join('\n');

const readme = `# 怎么把这包贴给豆包（粘贴通道）

你的通道是**复制粘贴**，不是 URL。做法：把下面 ${parts.length} 条消息**按序号依次**发出去，
发完再让它开工。

**顺序不能乱，也不要跳片。** ${parts.length} 片是同一份文档按序切开的，
拼起来**逐字节等于** \`豆包开测版.md\`（${bytes(raw)} 字节 / ${lines.length} 行）——
也就是说，贴全了就等于贴了整份原始文档，没有删减。

| 顺序 | 文件 | 正文 | 含片头 | 本片覆盖 |
|---|---|---|---|---|
${rows}

## 两条路，选一条

- **对方支持长文本** → 直接贴 \`00_全量单条.md\`（${kb(fullBytes)}，与 \`豆包开测版.md\` 同字节），一条搞定。
- **对方单条有长度上限 / 会被截断** → 用上面 ${parts.length} 片，逐条贴。

## 怎么知道没贴漏

每片开头有一行 \`【正文行 X–Y，共 ${lines.length} 行…】\`。
贴完 ${parts.length} 片后，可以让对方**回读每片的行号范围**：
接起来应当是 \`1–${lines.length}\` 连续且无缺口（生成时 S8 已机器校验过连续性）。

## 各片内容一览

${parts.map((p, i) => `- **第 ${i + 1} 片**（行 ${p.startLine}–${p.endLine}）：${titles[i]}`).join('\n')}

## 生成方式（可复现）

\`\`\`
node tools/make-doubao-paste.mjs
\`\`\`

切点是**自动选的**（按 \`## \` → \`### \` → 任意空行 三级优先，在 ≤ ${(MAX_BYTES / 1024).toFixed(0)}KB 的前提下尽量装满），
不是手写行号 —— 手写行号任何一次正文增删都会失效。
生成器带 9 组自检（拼回恒等、行数守恒、每片体积、代码围栏成对、切点落空行、关键锚点在场、
无空片、片头行号连续、全量同字节），任一不过就 **exit 1 且不写出任何文件**。
`;

const fpReadme = path.join(OUT, 'README_粘贴顺序.md');
fs.writeFileSync(fpReadme, readme, 'utf8');

console.log('\n写出：');
console.log(`  ${path.basename(fpFull)}  ${kb(fullBytes)}  （= 豆包开测版.md，支持长文本时首选）`);
for (const w of written) console.log(`  ${path.basename(w.fp)}  ${kb(w.bytes)} 正文 / ${kb(w.total)} 含头`);
console.log(`  ${path.basename(fpReadme)}  ${kb(bytes(readme))}`);
console.log(`\n切点（自动选）：${bounds.slice(1, -1).map((b) => '行' + (b + 1)).join(' / ')}`);
console.log(`校验口径：把 ${parts.length} 片的「正文」按序拼回，与 豆包开测版.md 逐字节相等。`);
