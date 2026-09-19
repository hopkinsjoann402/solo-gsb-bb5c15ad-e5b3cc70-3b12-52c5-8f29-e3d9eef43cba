import { useMemo, useState } from 'react';
import type { ClusterAudit, FontFileInfo, FontSpec, ParsedFont } from './types';
import { segmentGraphemes } from './lib/grapheme';
import {
  countCodepoints,
  parseUnicodeRanges,
  subtractRanges,
} from './lib/ranges';
import { analyzeCoverage, findMissingCodepoints } from './lib/coverage';
import { solveFallbackChain } from './lib/solver';
import { analyzeSingleFontFailure } from './lib/resilience';
import type { AuditInput, ChainEntry } from './lib/audit';
import { SAMPLE_TEXT, sampleFonts, uid } from './lib/sample';
import { formatSfntTag, parseSfntFont, SfntParseError } from './lib/sfnt';
import FontEditor from './components/FontEditor';
import ResultsPanel from './components/ResultsPanel';

/** 文件大小上限 20 MB（防止误选超大文件卡死浏览器解析） */
const MAX_FONT_BYTES = 20 * 1024 * 1024;

export default function App() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [fonts, setFonts] = useState<FontSpec[]>(sampleFonts);
  const [lengthPriority, setLengthPriority] = useState(0.7);
  const [ignoreFormat, setIgnoreFormat] = useState(true);
  /** 按实测覆盖求解：已上传字体用 cmap 区间，未上传字体仍用声明范围 */
  const [useMeasured, setUseMeasured] = useState(false);
  /** 正在解析的条目 id 集合（上传后异步读取期间显示忙碌，支持并发上传） */
  const [parsingIds, setParsingIds] = useState<Set<string>>(new Set());
  /** 解析失败信息（与 font.file 解耦：坏文件不会覆盖上次成功结果） */
  const [fileErrors, setFileErrors] = useState<Record<string, string>>({});

  // ---- 字体范围解析（声明范围始终解析；实测范围仅在开关开启时生效） ----
  const parsed: ParsedFont[] = useMemo(
    () =>
      fonts.map((f) => {
        const { ranges, error } = parseUnicodeRanges(f.rangesText);
        const fileError = fileErrors[f.id] ?? null;

        let diffDeclaredOnly: [number, number][] | undefined;
        let diffMeasuredOnly: [number, number][] | undefined;
        if (f.file && !error) {
          diffDeclaredOnly = subtractRanges(ranges, f.file.ranges);
          diffMeasuredOnly = subtractRanges(f.file.ranges, ranges);
        }

        const measuredActive = useMeasured && !!f.file;
        const effectiveRanges = measuredActive ? f.file!.ranges : ranges;

        return {
          ...f,
          ranges,
          error,
          codepointCount: error ? 0 : countCodepoints(ranges),
          fileError,
          effectiveRanges,
          effectiveSource: measuredActive ? ('measured' as const) : ('declared' as const),
          effectiveCount: countCodepoints(effectiveRanges),
          diffDeclaredOnly,
          diffMeasuredOnly,
        };
      }),
    [fonts, useMeasured, fileErrors],
  );

  // 有效字体及其在原始列表中的位次（位次即偏好顺序）。
  // 实测生效时以 cmap 区间为准（文件解析错误已与 file 解耦，不会出现）；
  // 声明模式下声明范围非法/为空的条目不参与分析。
  const validEntries = useMemo(
    () =>
      parsed
        .map((font, order) => ({ font, order }))
        .filter((e) =>
          e.font.effectiveSource === 'measured'
            ? e.font.effectiveRanges.length > 0
            : !e.font.error && e.font.ranges.length > 0,
        ),
    [parsed],
  );
  const validFonts = useMemo(() => validEntries.map((e) => e.font), [validEntries]);

  // ---- 字素簇切分 + 覆盖分析（字体按生效范围参与） ----
  const graphemes = useMemo(() => segmentGraphemes(text), [text]);
  const analysis = useMemo(
    () => analyzeCoverage(graphemes, validFonts, ignoreFormat),
    [graphemes, validFonts, ignoreFormat],
  );

  // ---- 回退链求解 ----
  const solution = useMemo(
    () =>
      solveFallbackChain({
        fontCount: validFonts.length,
        preference: validEntries.map((e) => e.order),
        patterns: analysis.patterns,
        lengthPriority,
      }),
    [validFonts.length, validEntries, analysis.patterns, lengthPriority],
  );

  // ---- 承接分配：每个簇由链中第一种可覆盖字体承接（与浏览器回退语义一致） ----
  const clusters: ClusterAudit[] = useMemo(() => {
    const chainOrder = solution.selected; // 已按偏好排序
    return analysis.clusters.map((c) => {
      if (c.free) {
        return {
          ...c,
          assigned: chainOrder.length > 0 ? chainOrder[0] : null,
          status: 'free' as const,
          missingCodepoints: [],
        };
      }
      const assigned = chainOrder.find((f) => c.candidates.includes(f)) ?? null;
      if (assigned === null) {
        return {
          ...c,
          assigned: null,
          status: 'missing' as const,
          missingCodepoints: findMissingCodepoints(c.required, validFonts),
        };
      }
      return { ...c, assigned, status: 'covered' as const, missingCodepoints: [] };
    });
  }, [analysis.clusters, solution.selected, validFonts]);

  // ---- 链上每种字体承接的簇数 ----
  const chain: ChainEntry[] = useMemo(() => {
    const counts = new Map<number, number>();
    for (const c of clusters) {
      if (c.assigned !== null && c.status !== 'free') {
        counts.set(c.assigned, (counts.get(c.assigned) ?? 0) + 1);
      }
    }
    return solution.selected.map((fontIndex) => ({
      fontIndex,
      name: validFonts[fontIndex].name,
      preference: validEntries[fontIndex].order,
      assignedClusters: counts.get(fontIndex) ?? 0,
    }));
  }, [clusters, solution.selected, validFonts, validEntries]);

  const unselected = useMemo(
    () =>
      validEntries
        .filter((_, i) => !solution.selected.includes(i))
        .map((e) => ({ name: e.font.name, preference: e.order })),
    [validEntries, solution.selected],
  );

  // ---- 单字体失效韧性分析：逐一移除链中字体并重解 ----
  // 求解在过滤后的临时下标空间进行，结果一律映射回原始有效字体下标，
  // 保证卡片与 JSON 中的字体名称始终对应原条目。
  const resilience = useMemo(
    () =>
      solution.selected.length > 0
        ? analyzeSingleFontFailure({
            graphemes,
            validFonts,
            preference: validEntries.map((e) => e.order),
            ignoreFormat,
            lengthPriority,
            baselineClusters: clusters,
            baselineChain: solution.selected,
          })
        : [],
    [
      graphemes,
      validFonts,
      validEntries,
      ignoreFormat,
      lengthPriority,
      clusters,
      solution.selected,
    ],
  );

  const auditInput: AuditInput = useMemo(
    () => ({
      text,
      fonts: parsed,
      validFontOrder: validEntries.map((e) => e.order),
      lengthPriority,
      ignoreFormatCodepoints: ignoreFormat,
      useMeasuredCoverage: useMeasured,
    }),
    [text, parsed, validEntries, lengthPriority, ignoreFormat, useMeasured],
  );

  const hasUploaded = useMemo(() => fonts.some((f) => !!f.file), [fonts]);

  // ---- 字体列表编辑 ----
  const updateFont = (id: string, patch: Partial<FontSpec>) =>
    setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  const moveFont = (id: string, dir: -1 | 1) =>
    setFonts((fs) => {
      const i = fs.findIndex((f) => f.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= fs.length) return fs;
      const next = [...fs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const removeFont = (id: string) =>
    setFonts((fs) => fs.filter((f) => f.id !== id));
  const addFont = () =>
    setFonts((fs) => [...fs, { id: uid(), name: '', rangesText: '', file: null }]);

  // ---- 本地字体文件：浏览器内读取 + 解析 cmap，绝不离开当前页面 ----
  const uploadFontFile = (id: string, file: File) => {
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) {
      setFileErrors((m) => ({ ...m, [id]: '仅支持 .ttf / .otf 字体文件' }));
      return;
    }
    if (file.size > MAX_FONT_BYTES) {
      setFileErrors((m) => ({ ...m, [id]: `文件过大（${file.size} 字节），上限 20 MB` }));
      return;
    }
    setParsingIds((s) => new Set(s).add(id));
    // File 只在本次读取期间存在；ArrayBuffer 解析完即可被 GC，不写入任何存储
    file
      .arrayBuffer()
      .then((buffer) => {
        try {
          const result = parseSfntFont(buffer);
          if (result.ranges.length === 0) {
            throw new SfntParseError('cmap 未映射任何非 0 glyph（实测覆盖为空）');
          }
          const info: FontFileInfo = {
            name: file.name,
            size: file.size,
            ranges: result.ranges,
            codepointCount: result.codepointCount,
            cmapFormats: result.cmap.formats,
            sfntVersion: formatSfntTag(result.sfntVersion),
            parsedAt: new Date().toISOString(),
          };
          setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, file: info } : f)));
          setFileErrors((m) => {
            const rest = { ...m };
            delete rest[id];
            return rest;
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setFileErrors((m) => ({ ...m, [id]: msg }));
        } finally {
          setParsingIds((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setFileErrors((m) => ({ ...m, [id]: `文件读取失败：${msg}` }));
        setParsingIds((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      });
  };

  const clearFontFile = (id: string) => {
    setFonts((fs) => fs.map((f) => (f.id === id ? { ...f, file: null } : f)));
    setFileErrors((m) => {
      const rest = { ...m };
      delete rest[id];
      return rest;
    });
    // 全部清除后自动回到声明范围求解
    const anyLeft = fonts.some((f) => f.id !== id && f.file);
    if (!anyLeft) setUseMeasured(false);
  };

  const codepointCount = useMemo(() => [...text].length, [text]);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Unicode 字体回退链审计台</h1>
          <p className="subtitle">
            按字素簇审计字体覆盖 · 在「顺序偏好」与「最短链」之间求解可行回退链 · 导出 CSS / JSON
          </p>
        </div>
        <span className="badge-soft">无需登录 · 全部本地计算 · 字体文件不上传</span>
      </header>

      <main className="layout">
        <section className="panel">
          <h2>
            <span className="step">1</span> 待渲染文本
          </h2>
          <textarea
            className="text-input mono"
            value={text}
            placeholder="粘贴需要渲染的文本…"
            rows={7}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="row-between">
            <span className="muted small">
              {graphemes.length} 字素簇 · {codepointCount} 码位 · {text.length} UTF-16 单元
            </span>
            <span className="row-actions">
              <button className="btn small ghost" onClick={() => setText(SAMPLE_TEXT)}>
                载入示例
              </button>
              <button className="btn small ghost" onClick={() => setText('')}>
                清空
              </button>
            </span>
          </div>

          <h2>
            <span className="step">2</span> 字体与 Unicode 覆盖范围
          </h2>
          <p className="muted small">
            列表顺序即回退偏好（↑ 更优先）。范围语法：<code>U+0020-007E</code>、<code>U+4E00</code>、
            <code>U+4??</code>，逗号或空白分隔。可上传本地 TTF/OTF，浏览器端解析 cmap（format 4/12）
            得到实测覆盖，文件仅在本机内存中解析。
          </p>
          <FontEditor
            fonts={fonts}
            parsed={parsed}
            parsingIds={parsingIds}
            useMeasured={useMeasured}
            hasUploaded={hasUploaded}
            onUpdate={updateFont}
            onMove={moveFont}
            onRemove={removeFont}
            onAdd={addFont}
            onToggleMeasured={setUseMeasured}
            onUploadFile={uploadFontFile}
            onClearFile={clearFontFile}
          />

          <h2>
            <span className="step">3</span> 求解偏好
          </h2>
          <div className="slider-row">
            <span className="slider-label">顺序优先</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(lengthPriority * 100)}
              onChange={(e) => setLengthPriority(Number(e.target.value) / 100)}
            />
            <span className="slider-label">链长优先</span>
            <span className="slider-value mono">{Math.round(lengthPriority * 100)}%</span>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={ignoreFormat}
              onChange={(e) => setIgnoreFormat(e.target.checked)}
            />
            忽略透明格式字符（ZWJ、变体选择符等，随簇内其它字符渲染）
          </label>
        </section>

        <section className="panel results-panel">
          <ResultsPanel
            clusters={clusters}
            validFonts={validFonts}
            chain={chain}
            unselected={unselected}
            feasible={solution.feasible}
            exact={solution.exact}
            objective={solution.objective}
            nodesExplored={solution.nodesExplored}
            auditInput={auditInput}
            hasText={text.length > 0}
            useMeasured={useMeasured}
            resilience={resilience}
          />
        </section>
      </main>

      <footer className="app-footer">
        字素簇切分基于 Intl.Segmenter · 求解器：唯一候选强制 + 支配约简 + 分支定界（预算内精确，超时退回贪心/局部搜索）
        · 上传字体仅在浏览器内解析 cmap，不发送服务端、不持久化
      </footer>
    </div>
  );
}
