#!/usr/bin/env node
/**
 * Verifies the canonical onboarded-user record against the data prepared from
 * `users.xlsx`, and re-checks the live Google Sheet.
 *
 * Run it with:  node scripts/verify-users-sheet.mjs
 *
 * WHAT IT ASSERTS
 *
 *  1. The prepared CSV still matches `users.xlsx` row-for-row on name, email
 *     and wallet address — i.e. `users.xlsx` really is the source the Sheet was
 *     built from, and no row was quietly added, dropped or edited.
 *  2. The live Google Sheet still matches the prepared CSV, so the canonical
 *     record and the repo agree.
 *  3. Every wallet address is a well-formed Preprod address.
 *  4. The Sheet's `Feedback` and `Transaction Hash` columns are still EMPTY.
 *
 * Point 4 is the important one. Those two columns exist in the Sheet and are
 * deliberately blank, because no feedback text or transaction hash has actually
 * been recorded against a user. This check exists so that "the columns are
 * empty" cannot quietly stop being true — filling them in is legitimate ONLY
 * from real responses, and this script failing is the signal that someone
 * filled them with something invented.
 *
 * It is intentionally NOT part of CI: it needs network access to Google, which
 * would make the pipeline depend on a third party being up.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readXlsx } from './lib/xlsx.mjs';

const SHEET_ID = '1CfUq8dCAGiFZ81ChCBPGZsLS5xVqSwLZEoSM-HdF3DY';
const SHEET_CSV = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const EXPECTED_COLUMNS = ['Name', 'Email', 'Wallet Address', 'Feedback', 'Transaction Hash'];
const EXPECTED_USERS = 50;
const PREPROD_ADDRESS = /^mn_addr_preprod1[0-9a-z]+$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal RFC4180 parser: handles quoted fields and embedded commas/newlines. */
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else { field += c; }
    } else if (c === '"') { quoted = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
};

const toObjects = (rows) => {
  const [header, ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
};

/** The three identity columns are what the Sheet and users.xlsx must agree on. */
const identity = (users) =>
  users.map((u) => `${u.Name}|${u.Email}|${u['Wallet Address']}`).sort();

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};

// ── 0. the canonical source itself ───────────────────────────────────────────
/**
 * `users.xlsx` is the canonical record, so it is read here directly rather than
 * taken on trust. This block used to be missing entirely, even though the header
 * comment claimed check 1 compared the prepared CSV against `users.xlsx` row for
 * row -- it did not, so nothing tied the uploaded file to the source of truth.
 */
let canonical = null;
try {
  const { header, rows } = readXlsx(join(root, 'users.xlsx'));
  const i = Object.fromEntries(['Name', 'Email', 'Wallet Address'].map((c) => [c, header.indexOf(c)]));
  canonical = rows.map((r) => `${(r[i.Name] ?? '').trim()}|${(r[i.Email] ?? '').trim()}|${(r[i['Wallet Address']] ?? '').trim()}`);
  check(true, `users.xlsx read: ${rows.length} users, columns [${header.join(' | ')}]`);
} catch (err) {
  check(false, `users.xlsx could not be read: ${err.message}`);
}

// ── 1. the prepared CSV, which was generated from users.xlsx ────────────────
const prepared = toObjects(parseCsv(readFileSync(join(root, 'onboarded-users-google-sheet.csv'), 'utf8')));
check(
  JSON.stringify(Object.keys(prepared[0] ?? {})) === JSON.stringify(EXPECTED_COLUMNS),
  `prepared CSV has the expected columns [${EXPECTED_COLUMNS.join(', ')}]`,
);
check(prepared.length === EXPECTED_USERS, `prepared CSV holds ${EXPECTED_USERS} users (found ${prepared.length})`);
check(
  prepared.every((u) => PREPROD_ADDRESS.test(u['Wallet Address'])),
  'every prepared wallet address is a well-formed mn_addr_preprod1… address',
);
check(
  prepared.every((u) => u.Email.includes('@')),
  'every prepared row has an email address',
);
check(
  new Set(prepared.map((u) => u['Wallet Address'])).size === prepared.length,
  'no duplicate wallet addresses — one row is one distinct person\'s wallet',
);
if (canonical) {
  check(
    JSON.stringify(identity(prepared)) === JSON.stringify([...canonical].sort()),
    `prepared CSV matches users.xlsx row for row (${canonical.length} users, compared on name, email and wallet address)`,
  );
}

/**
 * Duplicate emails are REPORTED, not treated as a failure.
 *
 * users.xlsx legitimately contains a shared address: rows 7 and 12 are
 * "Somnath chavan" and "Sanskar chavan", two different people with two
 * different Preprod wallets who share one Gmail address. That is a property of
 * the source data, not a preparation bug, and this script must not "fix" it —
 * guessing which row is wrong would corrupt the canonical record.
 *
 * What it can do is make sure the situation stays visible instead of hiding in
 * a spreadsheet.
 */
{
  const byEmail = new Map();
  for (const u of prepared) {
    const key = u.Email.toLowerCase();
    byEmail.set(key, [...(byEmail.get(key) ?? []), u]);
  }
  const dupes = [...byEmail.entries()].filter(([, rows]) => rows.length > 1);
  if (dupes.length === 0) {
    console.log('WARN  no duplicate emails in the prepared CSV');
  } else {
    console.log(
      `WARN  ${dupes.length} email(s) shared by more than one person — inherited from users.xlsx, left as-is:`,
    );
    for (const [email, rows] of dupes) {
      console.log(`        ${email}`);
      for (const r of rows) console.log(`          - ${r.Name} (${r['Wallet Address']})`);
    }
  }
}

// ── 2. the live Sheet ───────────────────────────────────────────────────────
let live = null;
try {
  const response = await fetch(SHEET_CSV);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  live = toObjects(parseCsv(await response.text()));
  check(true, `live Google Sheet fetched (${live.length} rows)`);
} catch (err) {
  check(false, `live Google Sheet could not be read: ${err.message}`);
}

if (live) {
  check(
    JSON.stringify(Object.keys(live[0] ?? {})) === JSON.stringify(EXPECTED_COLUMNS),
    'live Sheet has the expected columns',
  );
  check(live.length === EXPECTED_USERS, `live Sheet holds ${EXPECTED_USERS} users (found ${live.length})`);
  check(
    JSON.stringify(identity(live)) === JSON.stringify(identity(prepared)),
    'live Sheet matches the prepared CSV on name, email and wallet address',
  );

  // The check that keeps invented data out.
  const withFeedback = live.filter((u) => u.Feedback);
  const withHash = live.filter((u) => u['Transaction Hash']);
  check(
    withFeedback.length === 0 && withHash.length === 0,
    `Feedback and Transaction Hash are empty (feedback: ${withFeedback.length}, hash: ${withHash.length}) — ` +
      'fill these only from real responses',
  );
}

console.log('');
if (failures.length === 0) {
  console.log(`All checks passed. Canonical record: ${EXPECTED_USERS} users, matching users.xlsx.`);
  process.exit(0);
}
console.error(`${failures.length} check(s) failed:`);
for (const f of failures) console.error(`  - ${f}`);
process.exit(1);
