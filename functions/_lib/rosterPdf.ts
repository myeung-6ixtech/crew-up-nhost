import { getDocumentProxy } from 'unpdf';
import { RosterImportError } from './rosterErrors.js';

type PositionedText = { str: string; x: number; y: number };

/** Items within this many PDF units vertically are treated as one printed row. */
const ROW_TOLERANCE = 2;

/**
 * Rebuilds printed rows from positioned text so table rows stay on one line.
 * Redaction is line-based, so row boundaries matter.
 */
function itemsToLines(items: PositionedText[]): string[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PositionedText[][] = [];

  for (const item of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - item.y) <= ROW_TOLERANCE) {
      row.push(item);
    } else {
      rows.push([item]);
    }
  }

  return rows
    .map((row) =>
      row
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

export async function extractPdfText(
  bytes: Buffer,
  maxPages: number,
): Promise<{ text: string; pages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));

  if (pdf.numPages > maxPages) {
    throw new RosterImportError('ROSTER_FILE_TOO_LARGE', `PDF has ${pdf.numPages} pages`, 413);
  }

  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const items: PositionedText[] = [];
    for (const item of content.items) {
      if (!('str' in item) || !item.str.trim()) continue;
      items.push({ str: item.str, x: item.transform[4], y: item.transform[5] });
    }
    pages.push(itemsToLines(items).join('\n'));
  }

  return { text: pages.join('\n\n'), pages: pdf.numPages };
}
