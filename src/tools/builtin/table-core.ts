import { zipWrite } from '../../shared/zip.ts';

// 表の核。式の見かけの無害化と CSV・xlsx 文を作る純粋な関数

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

// 0 → 'A'、25 → 'Z'、26 → 'AA'、16383 → 'XFD'
export function columnName(index: number): string {
  if (index < 0) throw new Error('columnName: 負のインデックス');
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// XML に入れられない文字（制御文字・U+FFFE・U+FFFF・対になっていないサロゲート）を落としたあと、& < > " を逃す
function isDroppedCodePoint(cp: number): boolean {
  if (cp >= 0xd800 && cp <= 0xdfff) return true;
  if (cp === 0xfffe || cp === 0xffff) return true;
  if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return true;
  return false;
}

export function xmlEscape(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isDroppedCodePoint(cp)) continue;
    if (ch === '&') { out += '&amp;'; continue; }
    if (ch === '<') { out += '&lt;'; continue; }
    if (ch === '>') { out += '&gt;'; continue; }
    if (ch === '"') { out += '&quot;'; continue; }
    out += ch;
  }
  return out;
}

const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
  + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
  + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  + '</Types>';

const ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
  + '</Relationships>';

const WORKBOOK = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
  + '</workbook>';

const WORKBOOK_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
  + '</Relationships>';

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<fonts count="1"><font/></fonts>'
  + '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>'
  + '<borders count="1"><border/></borders>'
  + '<cellXfs count="2">'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" quotePrefix="1"/>'
  + '</cellXfs>'
  + '</styleSheet>';

// 1 シートの最小 xlsx を作る。式の見かけの文字は変えず quotePrefix（s="1"）で無害化する
export function xlsxBytes(rows: ReadonlyArray<ReadonlyArray<Cell>>): { bytes: Buffer; neutralized: number } {
  let neutralized = 0;
  let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    sheet += `<row r="${i + 1}">`;
    for (let j = 0; j < row.length; j++) {
      const cell = row[j]!;
      if (cell === null) continue;
      const ref = columnName(j) + (i + 1);
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) throw new Error('xlsx: 数のセルが有限数ではありません');
        sheet += `<c r="${ref}"><v>${cell}</v></c>`;
      } else {
        const formula = startsLikeFormula(cell);
        if (formula) neutralized++;
        sheet += `<c r="${ref}"${formula ? ' s="1"' : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell)}</t></is></c>`;
      }
    }
    sheet += '</row>';
  }
  sheet += '</sheetData></worksheet>';
  const bytes = zipWrite([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(WORKBOOK, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { name: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet, 'utf8') },
  ]);
  return { bytes, neutralized };
}
