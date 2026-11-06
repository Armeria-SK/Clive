// 表の核。式の見かけの無害化と CSV 文を作る純粋な関数（xlsxBytes は段 3-7）

export type Cell = string | number | null;
export const TABLE_MAX_CELLS = 100_000;
export const TABLE_MAX_CELL_CHARS = 32_767; // Excel の 1 セルの上限

// 式の始まりに見えやすい 1 文字。全角は日本語の Excel で式に化けるかを確かめていないので、安全側で含める
const FORMULA_LEADS = ['=', '+', '-', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20'];

export function startsLikeFormula(text: string): boolean {
  return FORMULA_LEADS.some((lead) => text.startsWith(lead));
}

export function csvText(rows: ReadonlyArray<ReadonlyArray<Cell>>): { text: string; neutralized: number } {
  let neutralized = 0;
  let text = '\uFEFF';
  for (const row of rows) {
    const cells: string[] = [];
    for (const cell of row) {
      let value: string;
      if (cell === null) {
        value = '';
      } else if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) throw new Error('csv: 数のセルが有限数ではありません');
        value = String(cell);
      } else if (startsLikeFormula(cell)) {
        value = "'" + cell;
        neutralized++;
      } else {
        value = cell;
      }
      if (value.includes('"') || value.includes(',') || value.includes('\r') || value.includes('\n')) {
        value = '"' + value.split('"').join('""') + '"';
      }
      cells.push(value);
    }
    text += cells.join(',') + '\r\n';
  }
  return { text, neutralized };
}
