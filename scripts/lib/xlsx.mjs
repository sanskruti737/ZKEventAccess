/**
 * A dependency-free reader for the one spreadsheet format this repo keeps its
 * canonical user record in.
 *
 * WHY THIS EXISTS INSTEAD OF A LIBRARY
 *
 * `users.xlsx` is the source of truth for the onboarded-user record, and the
 * only thing the repository does with it is read three columns out of it. That
 * does not justify taking on `xlsx`/`exceljs` — each brings a large transitive
 * tree and a CVEs-published history, and `verify-users-sheet.mjs` is
 * deliberately runnable with a bare Node and nothing installed. So this reads
 * the two parts of the format that are actually needed: the ZIP container, via
 * `zlib`, and the SpreadsheetML inside it, via string scanning.
 *
 * It is NOT a general-purpose xlsx library and does not try to be. No formulas,
 * no styles, no shared formulas, no multiple sheets, no date serialisation. It
 * refuses loudly on anything it does not understand rather than returning a
 * plausible-looking wrong answer, because a silent misread here would mean
 * publishing the wrong user record.
 */
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

// ── ZIP container ───────────────────────────────────────────────────────────

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} every stored member, keyed by path
 */
const unzip = (buf) => {
  // The end-of-central-directory record sits in the last 64KB, after an
  // optional comment of up to 65535 bytes, so scan backwards for its signature.
  const limit = Math.max(0, buf.length - 0x10000 - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= limit; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const members = new Map();

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== CENTRAL) {
      throw new Error(`corrupt ZIP: expected a central-directory entry at ${offset}`);
    }
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== LOCAL) {
      throw new Error(`corrupt ZIP: ${name} has no local header`);
    }
    // The local header repeats the name/extra lengths, and they are allowed to
    // differ from the central directory's, so they must be re-read here.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);

    if (method === 0) members.set(name, Buffer.from(raw));
    else if (method === 8) members.set(name, inflateRawSync(raw));
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return members;
};

// ── SpreadsheetML ───────────────────────────────────────────────────────────

const colOf = (ref) => {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
};

const decodeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Ampersand last, so "&amp;lt;" decodes to "&lt;" and not to "<".
    .replace(/&amp;/g, '&');

/** All `<si>` entries of sharedStrings.xml, concatenated across rich-text runs. */
const sharedStrings = (xml) => {
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(decodeXml(text));
  }
  return out;
};

/**
 * Reads a single-sheet workbook into rows of plain strings.
 *
 * Cells are addressed by column index, and a cell that is absent from the XML
 * comes back as `''` rather than shifting the row left — sparse rows are normal
 * in SpreadsheetML and treating a gap as "no column" is how columns silently
 * drift apart between two exports.
 *
 * @param {string} path
 * @returns {{ header: string[], rows: string[][] }}
 */
export const readXlsx = (path) => {
  const members = unzip(readFileSync(path));

  const shared = members.has('xl/sharedStrings.xml')
    ? sharedStrings(members.get('xl/sharedStrings.xml').toString('utf8'))
    : [];

  const sheets = [...members.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  if (sheets.length === 0) throw new Error(`${path} contains no worksheets`);
  if (sheets.length > 1) {
    // Silently reading the first of several sheets would produce a record that
    // looks complete and is not.
    throw new Error(`${path} has ${sheets.length} worksheets; this reader only handles one`);
  }

  const xml = members.get(sheets[0]).toString('utf8');
  const grid = [];
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c\b([^>]*)\/?>(?:([\s\S]*?)<\/c>)?/g)) {
      const attrs = c[1];
      const col = colOf(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A');
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      const inner = c[2] ?? '';
      let value = '';
      if (type === 'inlineStr') {
        for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += t[1];
        value = decodeXml(value);
      } else {
        const v = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) {
          // A shared-string cell stores an index into sharedStrings.xml, and an
          // index that is not a valid entry means the file is inconsistent.
          if (type === 's') {
            const i = Number(v);
            if (!Number.isInteger(i) || i < 0 || i >= shared.length) {
              throw new Error(`shared-string index ${v} is out of range (${shared.length} strings)`);
            }
            value = shared[i];
          } else {
            value = decodeXml(v);
          }
        }
      }
      cells[col - 1] = value;
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = '';
    grid.push(cells);
  }

  const [header = [], ...body] = grid;
  // A wholly blank trailing row is a spreadsheet artefact, not a person.
  return { header: header.map((h) => h.trim()), rows: body.filter((r) => r.some((c) => c.trim() !== '')) };
};
