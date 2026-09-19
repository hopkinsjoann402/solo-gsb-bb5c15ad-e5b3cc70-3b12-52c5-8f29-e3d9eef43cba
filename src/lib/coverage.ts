import type { ParsedFont } from '../types';
import type { Grapheme } from './grapheme';
import { isTransparentCodepoint } from './grapheme';

/** 二分查找：码位是否落在已排序合并的范围内 */
export function coversCodepoint(ranges: [number, number][], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = ranges[mid];
    if (cp < s) hi = mid - 1;
    else if (cp > e) lo = mid + 1;
    else return true;
  }
  return false;
}

export interface ClusterCoverage {
  index: number;
  text: string;
  start: number;
  codepoints: number[];
  required: number[];
  /** 可完整覆盖该簇的字体下标（相对传入的 fonts 数组） */
  candidates: number[];
  /** 仅含透明格式字符 */
  free: boolean;
  /** 去重后的需求模式编号；-1 表示 free 簇不参与求解 */
  patternId: number;
}

export interface CoverageAnalysis {
  clusters: ClusterCoverage[];
  /** 唯一需求模式：每个模式是可覆盖该类簇的字体下标列表 */
  patterns: number[][];
  /** 模式 -> 簇下标列表 */
  patternClusters: number[][];
}

/**
 * 逐字素簇计算每种字体能否承接。
 * 规则：簇内每个“需覆盖码位”都落在字体范围内，才认为该字体可承接该簇
 * （ZWJ 序列、组合符簇必须整体可渲染，不能只覆盖一半）。
 */
export function analyzeCoverage(
  graphemes: Grapheme[],
  fonts: ParsedFont[],
  ignoreFormatCodepoints: boolean,
): CoverageAnalysis {
  const patternMap = new Map<string, number>();
  const patterns: number[][] = [];
  const patternClusters: number[][] = [];

  const clusters: ClusterCoverage[] = graphemes.map((g, index) => {
    const required = ignoreFormatCodepoints
      ? g.codepoints.filter((cp) => !isTransparentCodepoint(cp))
      : [...g.codepoints];

    if (required.length === 0) {
      return {
        index,
        text: g.text,
        start: g.start,
        codepoints: g.codepoints,
        required,
        candidates: fonts.map((_, i) => i),
        free: true,
        patternId: -1,
      };
    }

    const candidates: number[] = [];
    for (let i = 0; i < fonts.length; i++) {
      if (required.every((cp) => coversCodepoint(fonts[i].effectiveRanges, cp))) {
        candidates.push(i);
      }
    }

    const key = candidates.join(',');
    let pid = patternMap.get(key);
    if (pid === undefined) {
      pid = patterns.length;
      patternMap.set(key, pid);
      patterns.push(candidates);
      patternClusters.push([]);
    }
    patternClusters[pid].push(index);

    return {
      index,
      text: g.text,
      start: g.start,
      codepoints: g.codepoints,
      required,
      candidates,
      free: false,
      patternId: pid,
    };
  });

  return { clusters, patterns, patternClusters };
}

/** 缺失簇中，具体是哪些码位没有任何字体覆盖 */
export function findMissingCodepoints(required: number[], fonts: ParsedFont[]): number[] {
  return required.filter(
    (cp) => !fonts.some((f) => coversCodepoint(f.effectiveRanges, cp)),
  );
}
