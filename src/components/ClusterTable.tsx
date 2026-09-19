import type { ClusterAudit, ParsedFont } from '../types';
import { displayCluster, formatCodepoint } from '../lib/grapheme';

const ROW_LIMIT = 300;

export type ClusterFilter = 'all' | 'missing' | `font:${number}`;

interface ClusterTableProps {
  clusters: ClusterAudit[];
  validFonts: ParsedFont[];
  filter: ClusterFilter;
  onFilterChange: (f: ClusterFilter) => void;
}

/** 字素簇明细表：每个簇由链中哪种字体承接、缺失原因 */
export default function ClusterTable({ clusters, validFonts, filter, onFilterChange }: ClusterTableProps) {
  const filtered = clusters.filter((c) => {
    if (filter === 'all') return true;
    if (filter === 'missing') return c.status === 'missing';
    const idx = Number(filter.slice(5));
    return c.assigned === idx;
  });
  const shown = filtered.slice(0, ROW_LIMIT);

  return (
    <div className="cluster-table-wrap">
      <div className="table-toolbar">
        <h3>字素簇明细</h3>
        <select
          className="filter-select"
          value={filter}
          onChange={(e) => onFilterChange(e.target.value as ClusterFilter)}
        >
          <option value="all">全部（{clusters.length}）</option>
          <option value="missing">
            仅缺失（{clusters.filter((c) => c.status === 'missing').length}）
          </option>
          {validFonts.map((f, i) => (
            <option key={f.id} value={`font:${i}`}>
              由「{f.name || '(未命名)'}」承接（{clusters.filter((c) => c.assigned === i).length}）
            </option>
          ))}
        </select>
      </div>
      <div className="table-scroll">
        <table className="cluster-table">
          <thead>
            <tr>
              <th>#</th>
              <th>字素</th>
              <th>码位</th>
              <th>承接字体</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.index} className={`row-${c.status}`}>
                <td className="mono muted">{c.index + 1}</td>
                <td className="glyph-cell" title={c.text}>
                  {displayCluster(c.text)}
                </td>
                <td className="mono small">
                  {c.codepoints.map(formatCodepoint).join(' ')}
                </td>
                <td>
                  {c.status === 'missing' ? (
                    <span className="badge bad">缺失</span>
                  ) : c.assigned !== null ? (
                    <span className="badge ok">{validFonts[c.assigned].name || '(未命名)'}</span>
                  ) : (
                    <span className="badge muted-badge">—</span>
                  )}
                </td>
                <td className="small note">
                  {c.status === 'missing' && (
                    <>无字体覆盖 {c.missingCodepoints.map(formatCodepoint).join(' ')}</>
                  )}
                  {c.status === 'covered' && (
                    <>链中首个可覆盖字体（共 {c.candidates.length} 种候选）</>
                  )}
                  {c.status === 'free' && <>仅含格式字符，随上下文渲染</>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-cell">
                  无匹配的字素簇
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > ROW_LIMIT && (
        <div className="table-note">仅显示前 {ROW_LIMIT} 条（共 {filtered.length} 条），完整数据请导出 JSON。</div>
      )}
    </div>
  );
}
