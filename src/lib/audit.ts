import type { ClusterAudit, ParsedFont } from '../types';
import { countCodepoints } from './ranges';
import { formatCodepoint } from './grapheme';
import type { FailureScenario } from './resilience';

/** 转义 CSS 字符串中的引号与反斜杠 */
export function cssStringEscape(name: string): string {
  return name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildFontFamily(chainNames: string[], generic = 'sans-serif'): string {
  return [...chainNames.map((n) => `"${cssStringEscape(n)}"`), generic].join(', ');
}

export interface ChainEntry {
  /** 有效字体列表下标 */
  fontIndex: number;
  name: string;
  preference: number;
  assignedClusters: number;
}

export function buildCssExport(chain: ChainEntry[], generatedAt: string): string {
  const lines = [
    `/* 由 Unicode 字体回退链审计台生成 · ${generatedAt} */`,
    '/* 回退链（按优先级从高到低）：',
    ...chain.map(
      (e, i) => `   ${i + 1}. "${e.name}" — 承接 ${e.assignedClusters} 个字素簇`,
    ),
    '   缺失字素簇不在任何字体覆盖范围内，详见审计 JSON。',
    '*/',
    '.audited-text {',
    `  font-family: ${buildFontFamily(chain.map((e) => e.name))};`,
    '}',
  ];
  return lines.join('\n');
}

export interface AuditInput {
  text: string;
  fonts: ParsedFont[];
  /** 有效字体在原始列表中的下标 */
  validFontOrder: number[];
  lengthPriority: number;
  ignoreFormatCodepoints: boolean;
  /** 是否开启“按实测覆盖求解” */
  useMeasuredCoverage: boolean;
}

export interface AuditResultData {
  feasible: boolean;
  exact: boolean;
  objective: number;
  nodesExplored: number;
  chain: ChainEntry[];
  unselected: { name: string; preference: number }[];
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
}

export function buildAuditReport(
  input: AuditInput,
  result: AuditResultData,
  generatedAt: string,
) {
  const { validFonts } = result;
  const fontName = (i: number | null) => (i === null ? null : validFonts[i].name);
  const covered = result.clusters.filter((c) => c.status !== 'missing').length;
  const missing = result.clusters.length - covered;

  const fmtRanges = (rs: [number, number][]) =>
    rs.map(([s, e]) => [formatCodepoint(s), formatCodepoint(e)]);

  return {
    tool: 'unicode-font-fallback-audit',
    version: 1,
    generatedAt,
    input: {
      text: input.text,
      options: {
        lengthPriority: input.lengthPriority,
        ignoreFormatCodepoints: input.ignoreFormatCodepoints,
        useMeasuredCoverage: input.useMeasuredCoverage,
      },
      fonts: input.fonts.map((f, i) => ({
        preference: i + 1,
        name: f.name,
        ranges: f.rangesText,
        parsedRanges: f.error
          ? null
          : fmtRanges(f.ranges),
        declaredCodepointCount: f.error ? 0 : f.codepointCount,
        declaredError: f.error,
        uploadedFont: f.file
          ? {
              fileName: f.file.name,
              sizeBytes: f.file.size,
              sfntVersion: f.file.sfntVersion,
              cmapFormats: f.file.cmapFormats,
              parsedAt: f.file.parsedAt,
              // 仅输出实测码位区间等元数据；文件二进制从未离开浏览器
              measuredRanges: fmtRanges(f.file.ranges),
              measuredCodepointCount: f.file.codepointCount,
              parseError: f.fileError,
            }
          : null,
        /** 本次分析实际使用的范围来源与区间 */
        effectiveCoverage: {
          source: f.effectiveSource,
          codepointCount: f.effectiveCount,
          ranges: fmtRanges(f.effectiveRanges),
        },
        /** 声明 vs 实测 双向差集 */
        declaredVsMeasured: f.file
          ? {
              declaredOnly: {
                count: f.diffDeclaredOnly ? countCodepoints(f.diffDeclaredOnly) : 0,
                segmentCount: f.diffDeclaredOnly?.length ?? 0,
                ranges: f.diffDeclaredOnly ? fmtRanges(f.diffDeclaredOnly) : [],
              },
              measuredOnly: {
                count: f.diffMeasuredOnly ? countCodepoints(f.diffMeasuredOnly) : 0,
                segmentCount: f.diffMeasuredOnly?.length ?? 0,
                ranges: f.diffMeasuredOnly ? fmtRanges(f.diffMeasuredOnly) : [],
              },
            }
          : null,
        error: f.error,
      })),
    },
    result: {
      feasible: result.feasible,
      solverExact: result.exact,
      objective: Number(result.objective.toFixed(9)),
      nodesExplored: result.nodesExplored,
      graphemeCount: result.clusters.length,
      coveredCount: covered,
      missingCount: missing,
      chain: result.chain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        preference: e.preference + 1,
        assignedClusters: e.assignedClusters,
      })),
      unselectedFonts: result.unselected.map((u) => ({
        font: u.name,
        preference: u.preference + 1,
      })),
      clusters: result.clusters.map((c) => ({
        index: c.index,
        text: c.text,
        codepoints: c.codepoints.map(formatCodepoint),
        requiredCodepoints: c.required.map(formatCodepoint),
        status: c.status,
        assignedFont: fontName(c.assigned),
        candidateFonts: c.candidates.map((i) => validFonts[i].name),
        missingCodepoints: c.missingCodepoints.map(formatCodepoint),
      })),
      missing: result.clusters
        .filter((c) => c.status === 'missing')
        .map((c) => ({
          index: c.index,
          text: c.text,
          codepoints: c.codepoints.map(formatCodepoint),
          missingCodepoints: c.missingCodepoints.map(formatCodepoint),
        })),
    },
    css: `font-family: ${buildFontFamily(result.chain.map((e) => e.name))};`,
  };
}

/** 韧性分析报告的基线（失效前）摘要 */
export interface ResilienceBaseline {
  chain: ChainEntry[];
  graphemeCount: number;
  coveredCount: number;
  missingCount: number;
}

/**
 * 构建「单字体失效韧性分析」JSON 报告。
 * scenarios 中的字体下标均为原始有效字体列表下标，此处统一映射回字体名称。
 */
export function buildResilienceReport(
  input: AuditInput,
  baseline: ResilienceBaseline,
  scenarios: FailureScenario[],
  validFonts: ParsedFont[],
  generatedAt: string,
) {
  const fontName = (i: number) => validFonts[i].name;

  return {
    tool: 'unicode-font-fallback-audit',
    analysis: 'single-font-failure-resilience',
    version: 1,
    generatedAt,
    options: {
      lengthPriority: input.lengthPriority,
      ignoreFormatCodepoints: input.ignoreFormatCodepoints,
      useMeasuredCoverage: input.useMeasuredCoverage,
    },
    baseline: {
      graphemeCount: baseline.graphemeCount,
      coveredCount: baseline.coveredCount,
      missingCount: baseline.missingCount,
      chainLength: baseline.chain.length,
      chain: baseline.chain.map((e, i) => ({
        order: i + 1,
        font: e.name,
        preference: e.preference + 1,
        assignedClusters: e.assignedClusters,
      })),
    },
    /** 已按新增缺失数降序排列 */
    scenarios: scenarios.map((s) => ({
      failedFont: {
        font: fontName(s.fontIndex),
        validFontIndex: s.fontIndex,
        preference: s.preference + 1,
      },
      assignedClustersBefore: s.assignedBefore,
      feasibleAfterFailure: s.feasible,
      solverExact: s.exact,
      chainLengthBefore: baseline.chain.length,
      chainLengthAfter: s.chain.length,
      chainLengthDelta: s.chainLengthDelta,
      replacementChain: s.chain.map((f, i) => ({
        order: i + 1,
        font: fontName(f),
        validFontIndex: f,
        assignedClusters: s.chainAssigned[i],
      })),
      newMissingCount: s.newMissing.length,
      newMissing: s.newMissing.map((c) => ({
        index: c.index,
        text: c.text,
        codepoints: c.codepoints.map(formatCodepoint),
        missingCodepoints: c.missingCodepoints.map(formatCodepoint),
      })),
      reassignedCount: s.reassigned.length,
      reassigned: s.reassigned.map((c) => ({
        index: c.index,
        text: c.text,
        codepoints: c.codepoints.map(formatCodepoint),
        fromFont: fontName(c.fromFont),
        toFont: fontName(c.toFont),
      })),
      stillMissingCount: s.stillMissing,
    })),
  };
}

export async function copyToClipboard(text: string): Promise<boolean> {  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 回退：隐藏 textarea + execCommand（兼容非安全上下文）
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
