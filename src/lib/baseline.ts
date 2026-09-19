/**
 * 基线对比。
 *
 * 导入本工具导出的审计 JSON（tool = unicode-font-fallback-audit, version = 1），
 * 与当前实时结果按**字素簇文本序列**做保序对齐：
 *
 * - 对齐路径等价于两侧文本序列的最长公共子序列（Myers O(ND) 差分），
 *   重复簇按出现次序逐次配对（同一个字出现 5 次就匹配 5 次，不跨序）；
 * - 未配对项只标记为「插入（当前独有）/ 删除（基线独有）」自身，
 *   不吞掉、不让任何后续簇的原始 index 错位；
 * - 已对齐簇再区分**覆盖状态变化**（新增缺失 / 已修复缺失）与**承接字体变化**
 *   （两侧均覆盖但 assignedFont 不同）。
 */
import type { ClusterAudit, ClusterStatus, ParsedFont } from '../types';
import { formatCodepoint } from './grapheme';

export const BASELINE_TOOL = 'unicode-font-fallback-audit';
export const BASELINE_VERSION = 1;

/** 基线审计 JSON 中参与对比的簇视图 */
export interface BaselineCluster {
  /** 基线导出时的簇序号（从 0 开始） */
  index: number;
  text: string;
  status: ClusterStatus;
  /** 基线中承接该簇的字体名称；缺失时为 null */
  assignedFont: string | null;
}

/** 解析成功的基线元数据 */
export interface BaselineData {
  /** 导入来源文件名（仅展示用） */
  source: string | null;
  generatedAt: string | null;
  graphemeCount: number;
  coveredCount: number;
  missingCount: number;
  clusters: BaselineCluster[];
}

export type BaselineParseResult =
  | { ok: true; baseline: BaselineData }
  | { ok: false; error: string };

const VALID_STATUS: ReadonlySet<string> = new Set(['covered', 'missing', 'free']);

/**
 * 解析并校验导入的审计 JSON。
 * 非法 JSON、工具/version 不匹配、缺少 result.clusters 均返回错误信息；
 * 调用方据此保留上一次有效基线。
 */
export function parseBaselineAudit(text: string, source?: string): BaselineParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `非法 JSON：${msg}` };
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: '文件内容不是有效的审计 JSON（顶层应为对象）' };
  }
  const root = data as Record<string, unknown>;

  if (root.tool !== BASELINE_TOOL) {
    if (root.analysis === 'single-font-failure-resilience') {
      return {
        ok: false,
        error: '这是「单字体失效韧性分析」JSON，不是审计 JSON；请导入由「审计 JSON → 下载」导出的文件。',
      };
    }
    return {
      ok: false,
      error: `工具标识不匹配：tool 应为 "${BASELINE_TOOL}"，实际为 ${JSON.stringify(root.tool) ?? '缺失'}。`,
    };
  }
  if (root.version !== BASELINE_VERSION) {
    return {
      ok: false,
      error: `版本不匹配：仅支持 version ${BASELINE_VERSION}，文件为 ${JSON.stringify(root.version) ?? '缺失'}。`,
    };
  }

  const result = root.result as Record<string, unknown> | undefined;
  const rawClusters = result?.clusters;
  if (!Array.isArray(rawClusters)) {
    return { ok: false, error: '缺少 result.clusters：该文件不包含逐字素簇审计结果。' };
  }

  const clusters: BaselineCluster[] = [];
  for (let i = 0; i < rawClusters.length; i++) {
    const entry = rawClusters[i] as Record<string, unknown> | null;
    if (typeof entry !== 'object' || entry === null) {
      return { ok: false, error: `result.clusters[${i}] 不是对象，文件可能已损坏。` };
    }
    if (typeof entry.text !== 'string') {
      return { ok: false, error: `result.clusters[${i}] 缺少字符串字段 text。` };
    }
    if (typeof entry.status !== 'string' || !VALID_STATUS.has(entry.status)) {
      return {
        ok: false,
        error: `result.clusters[${i}] 的 status 非法（应为 covered / missing / free）。`,
      };
    }
    if (entry.assignedFont !== null && typeof entry.assignedFont !== 'string') {
      return { ok: false, error: `result.clusters[${i}] 的 assignedFont 应为字符串或 null。` };
    }
    clusters.push({
      index: typeof entry.index === 'number' && Number.isInteger(entry.index) ? entry.index : i,
      text: entry.text,
      status: entry.status as ClusterStatus,
      assignedFont: entry.assignedFont,
    });
  }

  const num = (v: unknown, fallback: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const missingCount = clusters.filter((c) => c.status === 'missing').length;

  return {
    ok: true,
    baseline: {
      source: source ?? null,
      generatedAt: typeof root.generatedAt === 'string' ? root.generatedAt : null,
      graphemeCount: num(result?.graphemeCount, clusters.length),
      coveredCount: num(result?.coveredCount, clusters.length - missingCount),
      missingCount: num(result?.missingCount, missingCount),
      clusters,
    },
  };
}

/** 当前实时结果中参与对齐的簇视图（字体下标解析为名称，与基线 JSON 同口径） */
export interface CurrentClusterView {
  index: number;
  text: string;
  status: ClusterStatus;
  assignedFont: string | null;
  codepoints: number[];
  missingCodepoints: number[];
}

export function currentClusterViews(
  clusters: ClusterAudit[],
  validFonts: ParsedFont[],
): CurrentClusterView[] {
  return clusters.map((c) => ({
    index: c.index,
    text: c.text,
    status: c.status,
    assignedFont: c.assigned === null ? null : validFonts[c.assigned]?.name ?? null,
    codepoints: c.codepoints,
    missingCodepoints: c.missingCodepoints,
  }));
}

/** 已对齐（配对）簇的变化分类 */
export type PairChange =
  | 'unchanged'
  | 'new-missing'
  | 'fixed-missing'
  | 'font-changed';

/** 对齐明细行：pair 两侧都有；insert 仅当前侧；delete 仅基线侧 */
export interface AlignmentRow {
  /** 保序合并序列中的展示序号（从 0 开始） */
  order: number;
  kind: 'pair' | 'insert' | 'delete';
  /** 仅 kind=pair 时有值 */
  change: PairChange | null;
  /** 退化项：新增缺失或字体改接 */
  regression: boolean;
  baseline: BaselineCluster | null;
  current: CurrentClusterView | null;
}

export interface AlignmentSummary {
  baselineCount: number;
  currentCount: number;
  matched: number;
  inserted: number;
  deleted: number;
  unchanged: number;
  /** 退化：基线覆盖 → 当前缺失 */
  newMissing: number;
  /** 修复：基线缺失 → 当前覆盖 */
  fixedMissing: number;
  /** 两侧均覆盖但承接字体名称变化 */
  fontChanged: number;
  /** 退化合计 = 新增缺失 + 字体改接 */
  regressionCount: number;
}

export interface BaselineComparison {
  rows: AlignmentRow[];
  summary: AlignmentSummary;
}

/** 比较两侧配对簇的覆盖状态与承接字体 */
function classifyPair(b: BaselineCluster, c: CurrentClusterView): PairChange {
  const wasMissing = b.status === 'missing';
  const nowMissing = c.status === 'missing';
  if (wasMissing !== nowMissing) {
    return nowMissing ? 'new-missing' : 'fixed-missing';
  }
  if (wasMissing) {
    return 'unchanged'; // 两侧都缺失
  }
  // 双方都非缺失：仅含格式字符的簇不依赖具体字体，两侧皆 free 时不计改接
  if (b.status === 'free' && c.status === 'free') {
    return 'unchanged';
  }
  return (b.assignedFont ?? null) === (c.assignedFont ?? null) ? 'unchanged' : 'font-changed';
}

/**
 * 按字素簇文本序列保序对齐。
 *
 * 使用 Myers O(ND) 差分（等价于求最长公共子序列路径），重复簇严格按出现
 * 次序逐次配对；插入/删除只产生自身事件，不改变任何已配对簇的原始 index。
 * 两侧高度相似时成本近似线性；先剥离公共前缀/后缀。若搜索超过预算
 * （两侧几乎完全无关且规模巨大时 O(ND) 才会退化），退回保序贪心配对——
 * 配对未必最多，但保序、重复逐次、插入删除不越位等结构性质仍然成立。
 */
export function alignClusters(
  baseline: BaselineCluster[],
  current: CurrentClusterView[],
): BaselineComparison {
  const aText = baseline.map((c) => c.text);
  const bText = current.map((c) => c.text);

  // 公共前缀
  let p = 0;
  while (p < aText.length && p < bText.length && aText[p] === bText[p]) p++;
  // 公共后缀（不与前缀重叠）
  let s = 0;
  while (
    p + s < aText.length &&
    p + s < bText.length &&
    aText[aText.length - 1 - s] === bText[bText.length - 1 - s]
  ) {
    s++;
  }

  type Event =
    | { type: 'match'; a: number; b: number }
    | { type: 'insert'; b: number }
    | { type: 'delete'; a: number };
  const events: Event[] = [];
  for (let i = 0; i < p; i++) events.push({ type: 'match', a: i, b: i });

  const midN = aText.length - p - s;
  const midM = bText.length - p - s;
  events.push(
    ...myersMiddle(aText, bText, p, midN, midM, MYERS_CELL_BUDGET).map((e) =>
      e.type === 'match'
        ? { type: 'match' as const, a: e.a + p, b: e.b + p }
        : e.type === 'insert'
          ? { type: 'insert' as const, b: e.b + p }
          : { type: 'delete' as const, a: e.a + p },
    ),
  );

  for (let k = 0; k < s; k++) {
    events.push({ type: 'match', a: aText.length - s + k, b: bText.length - s + k });
  }

  const rows: AlignmentRow[] = events.map((ev, order) => {
    if (ev.type === 'match') {
      const b = baseline[ev.a];
      const c = current[ev.b];
      const change = classifyPair(b, c);
      return {
        order,
        kind: 'pair' as const,
        change,
        regression: change === 'new-missing' || change === 'font-changed',
        baseline: b,
        current: c,
      };
    }
    if (ev.type === 'insert') {
      return { order, kind: 'insert', change: null, regression: false, baseline: null, current: current[ev.b] };
    }
    return { order, kind: 'delete', change: null, regression: false, baseline: baseline[ev.a], current: null };
  });

  const matched = rows.reduce((n, r) => n + (r.kind === 'pair' ? 1 : 0), 0);
  const summary: AlignmentSummary = {
    baselineCount: baseline.length,
    currentCount: current.length,
    matched,
    inserted: current.length - matched,
    deleted: baseline.length - matched,
    unchanged: 0,
    newMissing: 0,
    fixedMissing: 0,
    fontChanged: 0,
    regressionCount: 0,
  };
  for (const row of rows) {
    if (row.kind !== 'pair') continue;
    switch (row.change) {
      case 'unchanged':
        summary.unchanged++;
        break;
      case 'new-missing':
        summary.newMissing++;
        break;
      case 'fixed-missing':
        summary.fixedMissing++;
        break;
      case 'font-changed':
        summary.fontChanged++;
        break;
    }
  }
  summary.regressionCount = summary.newMissing + summary.fontChanged;

  return { rows, summary };
}

/** Myers 搜索的 (d,k) 格子预算，超出则退回保序贪心 */
const MYERS_CELL_BUDGET = 500_000;

/** 中段差分事件（局部下标） */
type MidEvent =
  | { type: 'match'; a: number; b: number }
  | { type: 'insert'; b: number }
  | { type: 'delete'; a: number };

/**
 * 对剥去公共前缀/后缀后的中段做 Myers O(ND) 差分。
 * 下标为中段局部下标（0 起）。预算耗尽时退回保序贪心。
 */
function myersMiddle(
  a: string[],
  b: string[],
  offset: number,
  n: number,
  m: number,
  budget: number,
): MidEvent[] {
  if (n === 0) return Array.from({ length: m }, (_, i) => ({ type: 'insert' as const, b: i }));
  if (m === 0) return Array.from({ length: n }, (_, i) => ({ type: 'delete' as const, a: i }));

  const aAt = (i: number) => a[offset + i];
  const bAt = (j: number) => b[offset + j];

  const greedyFallback = (): MidEvent[] => {
    // 保序、重复逐次；未配对项只标记自身（结构性不变量仍满足，配对未必最多）
    const queues = new Map<string, number[]>();
    for (let j = 0; j < m; j++) {
      const t = bAt(j);
      const q = queues.get(t);
      if (q) q.push(j);
      else queues.set(t, [j]);
    }
    const ev: MidEvent[] = [];
    let ai = 0;
    let bi = 0;
    const take = (pa: number, pb: number) => {
      while (ai < pa) ev.push({ type: 'delete', a: ai++ });
      while (bi < pb) ev.push({ type: 'insert', b: bi++ });
      ev.push({ type: 'match', a: ai++, b: bi++ });
    };
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      const q = queues.get(aAt(i));
      if (!q) continue;
      while (q.length > 0 && q[0] < cursor) q.shift();
      if (q.length > 0) take(i, q.shift()!);
      cursor = bi;
    }
    while (ai < n) ev.push({ type: 'delete', a: ai++ });
    while (bi < m) ev.push({ type: 'insert', b: bi++ });
    return ev;
  };

  const max = n + m;
  // V[k+max]：到达对角线 k 时的最远 x；每轮 d 开始时快照供回溯
  const v = new Int32Array(2 * max + 1);
  const trace: { start: number; arr: Int32Array }[] = [];
  let reachedD = -1;
  let cells = 0;

  outer: for (let d = 0; d <= max; d++) {
    // 本轮仅会读写 k ∈ [-(d+1), d+1]
    const start = max - d - 1;
    const arr = v.slice(start, start + 2 * d + 3);
    trace.push({ start, arr });
    for (let k = -d; k <= d; k += 2) {
      if (++cells > budget) break outer;
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max]; // 向下：插入 b 元素
      } else {
        x = v[k - 1 + max] + 1; // 向右：删除 a 元素
      }
      let y = x - k;
      while (x < n && y < m && aAt(x) === bAt(y)) {
        x++;
        y++;
      }
      v[k + max] = x;
      if (x >= n && y >= m) {
        reachedD = d;
        break outer;
      }
    }
  }

  if (reachedD < 0) return greedyFallback();

  // 沿 trace 回溯生成编辑脚本
  const rev: MidEvent[] = [];
  let x = n;
  let y = m;
  for (let d = reachedD; d > 0; d--) {
    const snap = trace[d];
    const get = (k: number) => snap.arr[k + max - snap.start];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      rev.push({ type: 'match', a: x, b: y });
    }
    if (x === prevX) {
      y--;
      rev.push({ type: 'insert', b: y });
    } else {
      x--;
      rev.push({ type: 'delete', a: x });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    rev.push({ type: 'match', a: x, b: y });
  }
  return rev.reverse();
}

const clusterSideJson = (c: CurrentClusterView) => ({
  index: c.index,
  text: c.text,
  codepoints: c.codepoints.map(formatCodepoint),
  status: c.status,
  assignedFont: c.assignedFont,
  missingCodepoints: c.missingCodepoints.map(formatCodepoint),
});

/** 构建含对齐明细的基线对比 JSON 报告 */
export function buildBaselineCompareReport(
  baseline: BaselineData,
  comparison: BaselineComparison,
  generatedAt: string,
) {
  const { summary } = comparison;
  const currentMissing = comparison.rows.filter(
    (r) => r.current?.status === 'missing',
  ).length;

  return {
    tool: BASELINE_TOOL,
    analysis: 'baseline-comparison',
    version: BASELINE_VERSION,
    generatedAt,
    baseline: {
      source: baseline.source,
      generatedAt: baseline.generatedAt,
      graphemeCount: baseline.graphemeCount,
      coveredCount: baseline.coveredCount,
      missingCount: baseline.missingCount,
    },
    current: {
      graphemeCount: summary.currentCount,
      coveredCount: summary.currentCount - currentMissing,
      missingCount: currentMissing,
    },
    summary,
    /** 保序对齐明细：重复簇逐次配对；inserted/deleted 仅标记自身，不改变任何 index */
    alignment: comparison.rows.map((r) => ({
      order: r.order,
      relation: r.kind === 'pair' ? 'matched' : r.kind === 'insert' ? 'inserted' : 'deleted',
      change: r.change,
      regression: r.regression,
      baseline: r.baseline
        ? {
            index: r.baseline.index,
            text: r.baseline.text,
            status: r.baseline.status,
            assignedFont: r.baseline.assignedFont,
          }
        : null,
      current: r.current ? clusterSideJson(r.current) : null,
    })),
  };
}
