import type { BulkAnalysis, BulkAssignment, BulkProduct } from "./library-types";

const XML_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XML_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type ZipFiles = Record<string, Uint8Array>;
type SheetPart = { name: string; path: string };
function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("This workbook contains an unreadable Excel sheet.");
  return doc;
}

function elements(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

function firstElement(root: Document | Element, name: string): Element | null {
  return elements(root, name)[0] || null;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function xmlText(element: Element | null): string {
  return element?.textContent || "";
}

let fflatePromise: Promise<typeof import("fflate")> | undefined;
async function requireFflate(): Promise<typeof import("fflate")> {
  fflatePromise ||= import("fflate");
  return fflatePromise;
}

function normalizeTarget(target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function listSheetParts(files: ZipFiles): SheetPart[] {
  const workbookBytes = files["xl/workbook.xml"];
  const relsBytes = files["xl/_rels/workbook.xml.rels"];
  if (!workbookBytes || !relsBytes) throw new Error("This file is not a readable .xlsx workbook.");
  const workbook = parseXml(decode(workbookBytes));
  const relationships = parseXml(decode(relsBytes));
  const targets = new Map<string, string>();
  for (const relation of elements(relationships, "Relationship")) {
    if (relation.getAttribute("TargetMode") === "External") continue;
    targets.set(relation.getAttribute("Id") || "", normalizeTarget(relation.getAttribute("Target") || ""));
  }
  return elements(workbook, "sheet").flatMap(sheet => {
    const relationId = sheet.getAttributeNS(XML_REL, "id") || sheet.getAttribute("r:id") || "";
    const path = targets.get(relationId);
    return path && files[path] ? [{ name: sheet.getAttribute("name") || "Sheet", path }] : [];
  });
}

function sharedStringTable(files: ZipFiles): string[] {
  const bytes = files["xl/sharedStrings.xml"];
  if (!bytes) return [];
  return elements(parseXml(decode(bytes)), "si").map(item => elements(item, "t").map(xmlText).join(""));
}

function zeroMasks(files: ZipFiles): Map<number, number> {
  const bytes = files["xl/styles.xml"];
  const result = new Map<number, number>();
  if (!bytes) return result;
  const doc = parseXml(decode(bytes));
  const formats = new Map<number, string>();
  for (const format of elements(doc, "numFmt")) formats.set(Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") || "");
  const styleList = firstElement(doc, "cellXfs");
  if (!styleList) return result;
  const styles = Array.from(styleList.children);
  styles.forEach((style, index) => {
    const format = formats.get(Number(style.getAttribute("numFmtId")));
    const zeros = format && /^0+$/.test(format) ? format.length : 0;
    if (zeros) result.set(index, zeros);
  });
  return result;
}

function cellAddress(cell: Element): { column: string; row: number } | null {
  const ref = cell.getAttribute("r") || "";
  const match = /^([A-Z]+)(\d+)$/i.exec(ref);
  return match ? { column: match[1].toUpperCase(), row: Number(match[2]) } : null;
}

function cellValue(cell: Element | undefined, sharedStrings: string[], masks: Map<number, number>): string {
  if (!cell) return "";
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return elements(cell, "t").map(xmlText).join("");
  const value = xmlText(firstElement(cell, "v"));
  if (type === "s") return sharedStrings[Number(value)] || "";
  if (type === "b") return value === "1" ? "TRUE" : value === "0" ? "FALSE" : value;
  if (type === "str" || type === "e") return value;
  const style = Number(cell.getAttribute("s") || 0);
  const zeros = masks.get(style) || 0;
  return zeros && /^\d+$/.test(value) ? value.padStart(zeros, "0") : value;
}

function rowCells(row: Element): Map<string, Element> {
  const result = new Map<string, Element>();
  for (const cell of elements(row, "c")) {
    const address = cellAddress(cell);
    if (address) result.set(address.column, cell);
  }
  return result;
}

function rowHasContent(cells: Map<string, Element>, strings: string[], masks: Map<number, number>): boolean {
  for (const cell of cells.values()) {
    if (cellValue(cell, strings, masks) !== "" || firstElement(cell, "f")) return true;
  }
  return false;
}

function headerRowNumber(doc: Document, strings: string[], masks: Map<number, number>): number {
  const rows = elements(doc, "row");
  for (const row of rows) {
    const number = Number(row.getAttribute("r"));
    if (!number || number > 20) continue;
    const cells = rowCells(row);
    if (cellValue(cells.get("N"), strings, masks).trim().toLowerCase() === "plu" &&
        cellValue(cells.get("S"), strings, masks).trim().toLowerCase() === "image url") return number;
  }
  return 0;
}

function makeAnalysis(files: ZipFiles): BulkAnalysis {
  const parts = listSheetParts(files);
  const strings = sharedStringTable(files);
  const masks = zeroMasks(files);
  const products = new Map<string, BulkProduct>();
  const matchedSheets: string[] = [];
  let ignoredBlankPluRows = 0;
  let preservedUrlRows = 0;
  let matchedWorkbookRows = 0;

  for (const part of parts) {
    const doc = parseXml(decode(files[part.path]));
    const header = headerRowNumber(doc, strings, masks);
    if (!header) continue;
    matchedSheets.push(part.name);
    for (const row of elements(doc, "row")) {
      const rowNumber = Number(row.getAttribute("r"));
      if (rowNumber <= header) continue;
      const cells = rowCells(row);
      if (!rowHasContent(cells, strings, masks)) continue;
      const plu = cellValue(cells.get("N"), strings, masks).trim();
      if (!plu) { ignoredBlankPluRows++; continue; }
      if (cellValue(cells.get("S"), strings, masks).trim()) { preservedUrlRows++; continue; }
      matchedWorkbookRows++;

      const name = cellValue(cells.get("B"), strings, masks).trim();
      const shortName = cellValue(cells.get("C"), strings, masks).trim();
      const displayName = name || shortName || `PLU ${plu}`;
      const description = name.slice(0, 1000);
      const key = `${plu.toLocaleUpperCase()}\u0000${displayName.trim().toLocaleLowerCase()}`;
      const current = products.get(key);
      const reference = { sheetName: part.name, rowNumber };
      if (current) {
        current.rows.push(reference);
        current.canGenerate ||= Boolean(name);
        if (!current.description && description) current.description = description;
      } else {
        products.set(key, {
          id: `product-${products.size + 1}`,
          plu,
          name: displayName.slice(0, 80),
          canGenerate: Boolean(name),
          description,
          rows: [reference]
        });
      }
    }
  }
  if (!matchedSheets.length) throw new Error("Could not find a sheet with PLU in column N and Image URL in column S in the first 20 rows.");
  return { products: [...products.values()], sheets: matchedSheets, ignoredBlankPluRows, preservedUrlRows, matchedWorkbookRows };
}

function createContext(files: ZipFiles): { parts: Map<string, string>; strings: string[]; masks: Map<number, number> } {
  const parts = new Map(listSheetParts(files).map(part => [part.name, part.path]));
  if (!parts.size) throw new Error("This file is not a readable .xlsx workbook.");
  return { parts, strings: sharedStringTable(files), masks: zeroMasks(files) };
}

function hasCellValue(cell: Element, strings: string[], masks: Map<number, number>): boolean {
  return Boolean(firstElement(cell, "f")) || cellValue(cell, strings, masks) !== "";
}

function columnNumber(letters: string): number {
  return [...letters].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
}

function writeInlineString(doc: Document, row: Element, existing: Element | undefined, rowNumber: number, url: string): void {
  const namespace = row.namespaceURI || XML_MAIN;
  const cell = existing || doc.createElementNS(namespace, "c");
  cell.setAttribute("r", `S${rowNumber}`);
  cell.setAttribute("t", "inlineStr");
  while (cell.firstChild) cell.removeChild(cell.firstChild);
  const inline = doc.createElementNS(namespace, "is");
  const text = doc.createElementNS(namespace, "t");
  text.textContent = url;
  inline.appendChild(text);
  cell.appendChild(inline);
  if (!existing) {
    const next = Array.from(row.children).find(child => {
      if (child.localName !== "c") return false;
      const address = cellAddress(child);
      return Boolean(address && columnNumber(address.column) > 19);
    });
    row.insertBefore(cell, next || null);
  }
}

export async function inspectBulkWorkbook(file: File): Promise<BulkAnalysis> {
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw new Error("Choose an Excel .xlsx workbook.");
  if (file.size < 1 || file.size > MAX_FILE_BYTES) throw new Error("The workbook must be smaller than 20 MB.");
  const { unzipSync } = await requireFflate();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  return makeAnalysis(files);
}

export async function fillBulkWorkbook(file: File, products: BulkProduct[], assignments: BulkAssignment[]): Promise<Blob> {
  const { unzipSync, zipSync } = await requireFflate();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const context = createContext(files);
  const assignmentMap = new Map(assignments.map(assignment => [assignment.productId, assignment.url]));
  const changed = new Set<string>();
  const documents = new Map<string, Document>();

  for (const product of products) {
    const url = assignmentMap.get(product.id);
    if (!url) continue;
    for (const reference of product.rows) {
      const path = context.parts.get(reference.sheetName);
      if (!path || !files[path]) continue;
      let doc = documents.get(path);
      if (!doc) { doc = parseXml(decode(files[path])); documents.set(path, doc); }
      const row = elements(doc, "row").find(item => Number(item.getAttribute("r")) === reference.rowNumber);
      if (!row) continue;
      const cells = rowCells(row);
      const cell = cells.get("S");
      if (cell && hasCellValue(cell, context.strings, context.masks)) continue;
      writeInlineString(doc, row, cell, reference.rowNumber, url);
      changed.add(path);
    }
  }
  const encoder = new TextEncoder();
  for (const path of changed) {
    const doc = documents.get(path);
    if (doc) files[path] = encoder.encode(new XMLSerializer().serializeToString(doc));
  }
  const output = zipSync(files, { level: 6 });
  return new Blob([output], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
