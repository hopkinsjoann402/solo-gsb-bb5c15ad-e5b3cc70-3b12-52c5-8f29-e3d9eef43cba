import { useMemo, useRef, useState } from 'react';
import type { ClusterAudit, ParsedFont } from '../types';
import {
  alignClusters,
  buildBaselineCompareReport,
  currentClusterViews,
  parseBaselineAudit,
  type BaselineData,
  type AlignmentRow,
} from '../lib/baseline';
import { downloadText } from '../lib/audit';
import { displayCluster, formatCodepoint } from '../lib/grapheme';

interface BaselineCompareProps {
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
}

const ROW_LIMIT = 300;

const CHANGE_LABEL: Record<string, string> = {
  unchanged: '无变化',
  'new-missing': '新增缺失',
  'fixed-missing': '已修复',
  'font-changed': '字体改接',
};

const CHANGE_BADGE: Record<string, string> = {
  unchanged: 'badge muted-badge',
  'new-missing': 'badge bad',
  'fixed-missing': 'badge ok',
  'font-changed': 'badge warn-badge',
};

function sideText(status: string, font: string | null): string {
  if (status === 'missing') return '缺失';
  if (status === 'free') return '随上下文';
  return font ?? '（未标注字体）';
}

/**
 * 基线对比面板：导入审计 JSON 作为基线，与当前实时结果按字素簇文本序列
 * 保序对齐（重复簇逐次匹配，插入/删除只标记自身、不使索引错位），
 * 汇总新增缺失、已修复缺失、字体改接，支持只看退化项与下载对比 JSON。
 */
export default function BaselineCompare({ clusters, validFonts }: BaselineCompareProps) {
  const [baseline, setBaseline] = useState<BaselineData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regressionOnly, setRegressionOnly] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = useMemo(() => currentClusterViews(clusters, validFonts), [clusters, validFonts]);
  const comparison = useMemo(
    () => (baseline ? alignClusters(baseline.clusters, current) : null),
    [baseline, current],
  );

  const pickFile = () => fileRef.current?.click();

  const onFile = (file: File | null | undefined) => {
    if (!file) return;
    file
      .text()
      .then((text) => {
        const parsed = parseBaselineAudit(text, file.name);
        if (parsed.ok) {
          // 仅在校验通过后替换基线；失败时保留上一次有效基线
          setBaseline(parsed.baseline);
          setError(null);
        } else {
          setError(parsed.error);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setError(`文件读取失败：${msg}`);
      })
      .finally(() => {
        // 允许再次选择同一个文件
        if (fileRef.current) fileRef.current.value = '';
      });
  };

  const clearBaseline = () => {
    setBaseline(null);
    setError(null);
    setRegressionOnly(false);
  };

  const downloadCompare = () => {
    if (!baseline || !comparison) return;
    const report = buildBaselineCompareReport(baseline, comparison, new Date().toISOString());
    downloadText('font-fallback-baseline-comparison.json', JSON.stringify(report, null, 2));
  };

  const rows = comparison?.rows ?? [];
  const visibleRows: AlignmentRow[] = regressionOnly
    ? rows.filter((r) => r.regression)
    : rows;
  const shown = visibleRows.slice(0, ROW_LIMIT);
  const s = comparison?.summary;

  return (
    <>
      <div className="resilience-head">
        <h3>基线对比</h3>
        <span className="export-actions">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="file-input-hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <button className="btn small" onClick={pickFile}>
            导入基线审计 JSON
          </button>
          {baseline && (
            <>
              <button className="btn small primary" onClick={downloadCompare}>
                下载对比 JSON
              </button>
              <button className="btn small ghost" onClick={clearBaseline}>
                移除基线
              </button>
            </>
          )}
        </span>
      </div>
      <p className="muted small">
        导入本工具导出的审计 JSON 作为基线，与当前实时结果按字素簇文本序列保序对齐：
        重复簇逐次匹配，插入/删除只标记自身、不使后续索引错位；对已对齐簇区分覆盖状态变化
        （新增缺失 / 已修复缺失）与承接字体变化（字体改接）。
      </p>

      {error && (
        <div className="alert bad">
          <strong>⚠ 基线导入失败</strong>
          <span className="alert-detail">
            {error}
            {baseline && ' —— 已保留上一次有效基线（' + (baseline.source ?? '未命名基线') + '）。'}
          </span>
        </div>
      )}

      {!baseline && !error && (
        <div className="baseline-empty muted small">
          尚未导入基线。先在某次结果下「下载审计 JSON」留存，之后修改文本或字体覆盖，再回到此处导入即可查看变化。
        </div>
      )}

      {baseline && s && (
        <>
          <div className="baseline-meta muted small">
            基线文件：<code>{baseline.source ?? '(未命名)'}</code>
            {baseline.generatedAt && <> · 导出于 {baseline.generatedAt}</>}
            {' · '}基线 {s.baselineCount} 簇 / 当前 {s.currentCount} 簇
            ，配对 {s.matched} · 插入 {s.inserted} · 删除 {s.deleted}
          </div>

          <div className="stat-grid">
            <div className={`stat${s.newMissing ? ' bad' : ''}`}>
              <div className="stat-value">{s.newMissing}</div>
              <div className="stat-label">新增缺失（退化）</div>
            </div>
            <div className="stat ok">
              <div className="stat-value">{s.fixedMissing}</div>
              <div className="stat-label">已修复缺失</div>
            </div>
            <div className="stat">
              <div className="stat-value baseline-warn">{s.fontChanged}</div>
              <div className="stat-label">字体改接</div>
            </div>
            <div className="stat">
              <div className="stat-value">{s.inserted}</div>
              <div className="stat-label">新增簇（插入）</div>
            </div>
            <div className="stat">
              <div className="stat-value">{s.deleted}</div>
              <div className="stat-label">移除簇（删除）</div>
            </div>
          </div>

          <div className="table-toolbar">
            <label className="check-row">
              <input
                type="checkbox"
                checked={regressionOnly}
                onChange={(e) => setRegressionOnly(e.target.checked)}
              />
              仅看退化项（新增缺失 {s.newMissing} · 字体改接 {s.fontChanged}，共 {s.regressionCount}）
            </label>
            <span className="muted small mono">
              显示 {shown.length}/{visibleRows.length} 行
            </span>
          </div>

          <div className="table-scroll">
            <table className="cluster-table baseline-table">
              <thead>
                <tr>
                  <th>变化</th>
                  <th>字素</th>
                  <th>基线（# / 状态）</th>
                  <th>当前（# / 状态）</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr
                    key={r.order}
                    className={
                      r.change === 'new-missing'
                        ? 'row-bad-change'
                        : r.change === 'fixed-missing'
                          ? 'row-ok-change'
                          : r.change === 'font-changed'
                            ? 'row-warn-change'
                            : r.kind === 'insert'
                              ? 'row-insert'
                              : r.kind === 'delete'
                                ? 'row-delete'
                                : ''
                    }
                  >
                    <td>
                      {r.kind === 'insert' ? (
                        <span className="badge muted-badge">插入</span>
                      ) : r.kind === 'delete' ? (
                        <span className="badge muted-badge">删除</span>
                      ) : (
                        <span className={CHANGE_BADGE[r.change ?? 'unchanged']}>
                          {CHANGE_LABEL[r.change ?? 'unchanged']}
                        </span>
                      )}
                    </td>
                    <td className="glyph-cell" title={r.baseline?.text ?? r.current?.text}>
                      {displayCluster(r.baseline?.text ?? r.current?.text ?? '')}
                    </td>
                    <td className="small">
                      {r.baseline ? (
                        <>
                          <span className="mono muted">#{r.baseline.index + 1}</span>{' '}
                          <span
                            className={
                              r.baseline.status === 'missing'
                                ? 'baseline-side-bad'
                                : 'muted'
                            }
                          >
                            {sideText(r.baseline.status, r.baseline.assignedFont)}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small">
                      {r.current ? (
                        <>
                          <span className="mono muted">#{r.current.index + 1}</span>{' '}
                          <span
                            className={
                              r.current.status === 'missing'
                                ? 'baseline-side-bad'
                                : r.current.status === 'free'
                                  ? 'muted'
                                  : 'baseline-side-ok'
                            }
                          >
                            {sideText(r.current.status, r.current.assignedFont)}
                          </span>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="small note">
                      {r.kind === 'insert' && <>当前文本独有，基线中不存在（不计入覆盖状态变化）。</>}
                      {r.kind === 'delete' && <>基线中有、当前文本已无此簇（不计入覆盖状态变化）。</>}
                      {r.change === 'new-missing' && (
                        <>
                          基线可覆盖，当前无字体覆盖
                          {r.current && r.current.missingCodepoints.length > 0 && (
                            <>：{r.current.missingCodepoints.map(formatCodepoint).join(' ')}</>
                          )}
                        </>
                      )}
                      {r.change === 'fixed-missing' && (
                        <>
                          基线缺失，当前已由
                          {r.current?.assignedFont ? `「${r.current.assignedFont}」` : '字体'}
                          承接。
                        </>
                      )}
                      {r.change === 'font-changed' && (
                        <>
                          承接字体：
                          <span className="risk-from">{r.baseline?.assignedFont ?? '缺失'}</span>
                          <span className="risk-chain-arrow"> → </span>
                          <span className="risk-to">{r.current?.assignedFont ?? '缺失'}</span>
                        </>
                      )}
                      {r.change === 'unchanged' && <>覆盖状态与承接字体均无变化。</>}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-cell">
                      {regressionOnly ? '没有退化项（无新增缺失、无字体改接）。' : '无对齐明细'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {visibleRows.length > ROW_LIMIT && (
            <div className="table-note">仅显示前 {ROW_LIMIT} 条（共 {visibleRows.length} 条），完整对齐明细请下载对比 JSON。</div>
          )}
        </>
      )}
    </>
  );
}
