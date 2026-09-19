import { alignClusters, buildBaselineCompareReport, parseBaselineAudit, currentClusterViews, type BaselineCluster } from '../src/lib/baseline';
import type { ClusterAudit } from '../src/types';

// ---- 暴力 LCS 配对数（用于校验保序贪心配对数等于 LCS） ----
function lcsCount(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0];
}

function mkView(text: string, status: 'covered' | 'missing' | 'free' = 'covered', assignedFont: string | null = 'F') {
  return { index: 0, text, status, assignedFont, codepoints: [], missingCodepoints: [] };
}

let failures = 0;
const assert = (cond: boolean, msg: string) => {
  if (!cond) {
    failures++;
    console.error('FAIL:', msg);
  }
};

// 随机序列：重复簇 + 插入删除
let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let t = 0; t < 5000; t++) {
  const vocab = ['a', 'b', 'a', 'c', 'a', '😀', ' ', 'é'];
  const lenA = Math.floor(rand() * 12);
  const lenB = Math.floor(rand() * 12);
  const base = Array.from({ length: lenA }, () => vocab[Math.floor(rand() * vocab.length)]);
  let cur = Array.from({ length: lenB }, () => vocab[Math.floor(rand() * vocab.length)]);
  // 以 50% 概率让 cur 由 base 编辑得到（更贴近真实）
  if (rand() < 0.5 && base.length) {
    cur = [...base];
    const edits = 1 + Math.floor(rand() * 4);
    for (let e = 0; e < edits && cur.length >= 0; e++) {
      const op = rand();
      if (op < 0.4) cur.splice(Math.floor(rand() * (cur.length + 1)), 0, vocab[Math.floor(rand() * vocab.length)]);
      else if (op < 0.7 && cur.length) cur.splice(Math.floor(rand() * cur.length), 1);
      else if (cur.length) cur[Math.floor(rand() * cur.length)] = vocab[Math.floor(rand() * vocab.length)];
    }
  }
  const bc: BaselineCluster[] = base.map((text, index) => ({ index, text, status: 'covered', assignedFont: 'X' }));
  const cc = cur.map((text, index) => ({ ...mkView(text), index }));
  const cmp = alignClusters(bc, cc);
  assert(cmp.summary.matched === lcsCount(base, cur),
    `matched=${cmp.summary.matched} != LCS=${lcsCount(base, cur)} base=${JSON.stringify(base)} cur=${JSON.stringify(cur)}`);
  assert(cmp.summary.matched + cmp.summary.inserted === cur.length, 'insert accounting');
  assert(cmp.summary.matched + cmp.summary.deleted === base.length, 'delete accounting');

  // 校验：所有 pair 顺序一致、index 不重不漏不错位；insert/delete 只标记自身
  let pb = -1, pc = -1;
  let ins = 0, del = 0, pairN = 0;
  const seenB = new Set<number>();
  const seenC = new Set<number>();
  for (const r of cmp.rows) {
    if (r.kind === 'pair' && r.baseline && r.current) {
      assert(r.baseline.text === r.current.text, 'pair text equal');
      assert(r.baseline.index > pb && r.current.index > pc, 'strictly increasing indices, no shift');
      assert(!seenB.has(r.baseline.index) && !seenC.has(r.current.index), 'no double match');
      seenB.add(r.baseline.index);
      seenC.add(r.current.index);
      pb = r.baseline.index; pc = r.current.index;
      pairN++;
    } else if (r.kind === 'insert') {
      assert(r.baseline === null, 'insert has no baseline');
      ins++;
    } else if (r.kind === 'delete') {
      assert(r.current === null, 'delete has no current');
      del++;
    }
  }
  assert(pairN === cmp.summary.matched && ins === cmp.summary.inserted && del === cmp.summary.deleted,
    'row counts consistent');

  // 合并序列按顺序拼回应等于各自原序列
  const rebuiltB = cmp.rows.filter(r => r.baseline).map(r => r.baseline!.text);
  const rebuiltC = cmp.rows.filter(r => r.current).map(r => r.current!.text);
  assert(JSON.stringify(rebuiltB) === JSON.stringify(base), 'baseline order preserved');
  assert(JSON.stringify(rebuiltC) === JSON.stringify(cur), 'current order preserved');
}

// ---- 重复簇逐次匹配：基线 5 个 a，当前 5 个 a，字体交替应逐次比较 ----
{
  const bc: BaselineCluster[] = Array.from({ length: 5 }, (_, i) => ({ index: i, text: 'a', status: 'covered', assignedFont: 'Old' }));
  const cc = Array.from({ length: 5 }, (_, i) => ({ ...mkView('a', 'covered', i % 2 ? 'Old' : 'New'), index: i }));
  const cmp = alignClusters(bc, cc);
  assert(cmp.summary.matched === 5, `dup matched=${cmp.summary.matched}`);
  assert(cmp.summary.fontChanged === 3 && cmp.summary.unchanged === 2, `dup alternating changes ${cmp.summary.fontChanged}`);
}

// ---- 中间插入：后续 index 不应错位配对 ----
{
  const bc: BaselineCluster[] = ['x', 'y', 'z'].map((text, index) => ({ index, text, status: 'covered', assignedFont: 'A' }));
  // 当前：x, NEW, y, z
  const cc = [mkView('x'), mkView('NEW'), mkView('y'), mkView('z')].map((v, index) => ({ ...v, index }));
  const cmp = alignClusters(bc, cc);
  assert(cmp.summary.matched === 3 && cmp.summary.inserted === 1 && cmp.summary.deleted === 0, 'single insert');
  const pairZ = cmp.rows.find(r => r.baseline?.text === 'z');
  assert(pairZ?.current?.index === 3, `z still aligns to current index 3, got ${pairZ?.current?.index}`);
}

// ---- 变化分类 ----
{
  const bc: BaselineCluster[] = [
    { index: 0, text: 'p', status: 'covered', assignedFont: 'A' },
    { index: 1, text: 'q', status: 'missing', assignedFont: null },
    { index: 2, text: 'r', status: 'covered', assignedFont: 'A' },
    { index: 3, text: 's', status: 'missing', assignedFont: null },
  ];
  const cc = [
    { ...mkView('p', 'missing'), index: 0 }, // 新增缺失
    { ...mkView('q', 'covered', 'B'), index: 1 }, // 已修复
    { ...mkView('r', 'covered', 'B'), index: 2 }, // 字体改接
    { ...mkView('s', 'missing'), index: 3 }, // 仍缺失
  ];
  const cmp = alignClusters(bc, cc);
  assert(cmp.summary.newMissing === 1, 'newMissing');
  assert(cmp.summary.fixedMissing === 1, 'fixedMissing');
  assert(cmp.summary.fontChanged === 1, 'fontChanged');
  assert(cmp.summary.unchanged === 1, 'unchanged');
  assert(cmp.summary.regressionCount === 2, 'regression = newMissing + fontChanged');
}

// ---- currentClusterViews：字体下标 → 名称，与基线 JSON 同口径 ----
{
  const audits: ClusterAudit[] = [
    { index: 0, text: 'a', start: 0, codepoints: [97], required: [97], candidates: [0, 1], free: false, assigned: 1, status: 'covered', missingCodepoints: [] },
    { index: 1, text: 'b', start: 1, codepoints: [98], required: [98], candidates: [], free: false, assigned: null, status: 'missing', missingCodepoints: [98] },
  ];
  const fonts = [{ id: '1', name: 'Font1' }, { id: '2', name: 'Font2' }] as any;
  const views = currentClusterViews(audits, fonts);
  assert(views[0].assignedFont === 'Font2', 'assigned resolved by index');
  assert(views[1].assignedFont === null, 'missing => null');
}

// ---- 解析校验：非法 JSON / tool / version / clusters / 韧性 JSON ----
const validReport = {
  tool: 'unicode-font-fallback-audit',
  version: 1,
  generatedAt: '2026-01-01T00:00:00.000Z',
  result: {
    graphemeCount: 1,
    coveredCount: 1,
    missingCount: 0,
    clusters: [{ index: 0, text: 'a', status: 'covered', assignedFont: 'F' }],
  },
};
{
  const ok = parseBaselineAudit(JSON.stringify(validReport), 'audit.json');
  assert(ok.ok, 'valid report parses');
  assert(!parseBaselineAudit('{not json').ok, 'invalid JSON rejected');
  assert(!parseBaselineAudit(JSON.stringify({ ...validReport, tool: 'other' })).ok, 'tool mismatch rejected');
  assert(!parseBaselineAudit(JSON.stringify({
    tool: 'unicode-font-fallback-audit', analysis: 'single-font-failure-resilience', version: 1,
  })).ok, 'resilience JSON rejected with hint');
  assert(!parseBaselineAudit(JSON.stringify({ ...validReport, version: 2 })).ok, 'version mismatch rejected');
  assert(!parseBaselineAudit(JSON.stringify({ tool: validReport.tool, version: 1, result: {} })).ok, 'missing clusters rejected');
  const badCluster = JSON.parse(JSON.stringify(validReport));
  badCluster.result.clusters[0].status = 'weird';
  assert(!parseBaselineAudit(JSON.stringify(badCluster)).ok, 'bad cluster status rejected');
  const badText = JSON.parse(JSON.stringify(validReport));
  delete badText.result.clusters[0].text;
  assert(!parseBaselineAudit(JSON.stringify(badText)).ok, 'missing cluster text rejected');
  // 上一次有效基线保留由调用方处理；此处确认解析失败不带 baseline
  const failed = parseBaselineAudit('[]');
  assert(!failed.ok && !(failed as any).baseline, 'failure keeps no baseline object');
}

// ---- 性能：公共前后缀剥离使大文本近似线性；极端发散触发预算回退仍保持结构 ----
{
  const N = 20000;
  const bc1: BaselineCluster[] = Array.from({ length: N }, (_, i) => ({ index: i, text: 'a', status: 'covered', assignedFont: 'X' }));
  const cc1 = Array.from({ length: N }, (_, i) => ({ ...mkView('a'), index: i }));
  const t0 = Date.now();
  const r1 = alignClusters(bc1, cc1);
  assert(r1.summary.matched === N && r1.summary.inserted === 0 && r1.summary.deleted === 0, `identical 20k match (${Date.now() - t0}ms)`);

  // 同文 20k，仅中段一处插入
  const texts1 = Array.from({ length: N }, (_, i) => `c${i % 50}`);
  const texts2 = [...texts1.slice(0, N / 2), 'INSERTED', ...texts1.slice(N / 2)];
  const bc2: BaselineCluster[] = texts1.map((text, index) => ({ index, text, status: 'covered', assignedFont: 'X' }));
  const cc2 = texts2.map((text, index) => ({ ...mkView(text), index }));
  const t1 = Date.now();
  const r2 = alignClusters(bc2, cc2);
  assert(r2.summary.matched === N && r2.summary.inserted === 1, `near-identical 20k (${Date.now() - t1}ms)`);

  // 完全不同的大序列：预算回退后配对 0，全部插入/删除，不挂起
  const bc3: BaselineCluster[] = Array.from({ length: 4000 }, (_, i) => ({ index: i, text: `aaa${i}`, status: 'covered', assignedFont: 'X' }));
  const cc3 = Array.from({ length: 4000 }, (_, i) => ({ ...mkView(`bbb${i}`), index: i }));
  const t2 = Date.now();
  const r3 = alignClusters(bc3, cc3);
  assert(r3.summary.matched === 0 && r3.summary.inserted === 4000 && r3.summary.deleted === 4000, `fully-divergent fallback (${Date.now() - t2}ms)`);
  assert(Date.now() - t2 < 5000, 'fallback returns promptly');
  // 回退路径也要保持保序/不越位结构不变量
  assert(r3.rows.filter(r => r.kind === 'delete').every((r, i) => r.baseline?.index === i), 'fallback delete order');
  const rb = r3.rows.filter(r => r.baseline).map(r => r.baseline!.text);
  const rc = r3.rows.filter(r => r.current).map(r => r.current!.text);
  assert(rb.length === 4000 && rc.length === 4000, 'fallback covers both sides');

  // 长公共前后缀 + 中段完全发散（触发预算回退）：已配对锚点的 index 仍严格递增、不错位
  const pre = Array.from({ length: 4000 }, (_, i) => `pre${i}`);
  const suf = Array.from({ length: 4000 }, (_, i) => `suf${i}`);
  const bc4text = [...pre, ...Array.from({ length: 1500 }, (_, i) => `A${i}`), ...suf];
  const cc4text = [...pre, ...Array.from({ length: 1500 }, (_, i) => `B${i}`), ...suf];
  const bc4: BaselineCluster[] = bc4text.map((text, i) => ({ index: i, text, status: 'covered', assignedFont: 'X' }));
  const cc4 = cc4text.map((text, i) => ({ ...mkView(text), index: i }));
  const t4 = Date.now();
  const r4 = alignClusters(bc4, cc4);
  let pb4 = -1, pc4 = -1;
  for (const row of r4.rows.filter((x) => x.kind === 'pair')) {
    assert(row.baseline!.index > pb4 && row.current!.index > pc4, 'fallback pairs order-preserving');
    pb4 = row.baseline!.index;
    pc4 = row.current!.index;
  }
  assert(r4.summary.matched === 8000, `anchors matched=${r4.summary.matched} (${Date.now() - t4}ms)`);
  assert(r4.summary.inserted === 1500 && r4.summary.deleted === 1500, 'divergent middle self-marked');
  // 后缀锚点的当前 index 没有因中段插入/删除而错位
  const firstSuf = r4.rows.find((x) => x.current?.text === 'suf0');
  assert(firstSuf?.current?.index === 5500 && firstSuf?.baseline?.index === 5500, 'suffix index not shifted');
}

// ---- 对比 JSON 报告结构 ----
{
  const base: BaselineData = {
    source: 'b.json', generatedAt: '2026-01-01T00:00:00.000Z',
    graphemeCount: 3, coveredCount: 3, missingCount: 0,
    clusters: [
      { index: 0, text: 'a', status: 'covered', assignedFont: 'Old' },
      { index: 1, text: 'b', status: 'covered', assignedFont: 'Old' },
      { index: 2, text: 'z', status: 'missing', assignedFont: null },
    ],
  };
  const cur = [
    { ...mkView('a', 'covered', 'New'), index: 0 },
    { ...mkView('b', 'covered', 'Old'), index: 1 },
    { ...mkView('c', 'covered', 'New'), index: 2 },
    { ...mkView('z', 'covered', 'New', ), index: 3 },
  ];
  const cmp = alignClusters(base.clusters, cur);
  const report = buildBaselineCompareReport(base, cmp, '2026-02-01T00:00:00.000Z');
  assert(report.tool === 'unicode-font-fallback-audit', 'report tool');
  assert(report.analysis === 'baseline-comparison', 'report analysis tag');
  assert(report.summary.newMissing === 0 && report.summary.fixedMissing === 1 && report.summary.fontChanged === 1, 'report summary');
  assert(report.summary.inserted === 1 && report.summary.deleted === 0, 'report insert');
  assert(report.alignment.length === 4, '4 alignment rows');
  const ins = report.alignment.find((x: any) => x.relation === 'inserted');
  assert(ins && ins.baseline === null && ins.current.text === 'c', 'inserted row self-only');
  const json = JSON.stringify(report);
  assert(JSON.parse(json).alignment[0].change, 'report is valid JSON');
}

// ---- 空序列 ----
{
  const r = alignClusters([], []);
  assert(r.rows.length === 0 && r.summary.matched === 0, 'empty both');
  const bc: BaselineCluster[] = [{ index: 0, text: 'x', status: 'covered', assignedFont: 'A' }];
  const r2 = alignClusters(bc, []);
  assert(r2.summary.deleted === 1 && r2.rows[0].kind === 'delete', 'current empty => delete');
  const cc = [{ ...mkView('y'), index: 0 }];
  const r3 = alignClusters([], cc);
  assert(r3.summary.inserted === 1 && r3.rows[0].kind === 'insert', 'baseline empty => insert');
}

if (failures === 0) console.log('ALL TESTS PASSED');
else console.error(`${failures} FAILURE(S)`);
process.exit(failures ? 1 : 0);
