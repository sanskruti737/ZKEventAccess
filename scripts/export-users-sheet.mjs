#!/usr/bin/env node
/**
 * Regenerates the prepared Google-Sheet upload from `users.xlsx`, the canonical
 * onboarded-user record.
 *
 * Run it with:  node scripts/export-users-sheet.mjs [--check]
 *
 * WHY A GENERATOR
 *
 * `onboarded-users-google-sheet.csv` used to be produced by hand. Nothing tied
 * it to `users.xlsx`, so the file that gets uploaded to the canonical Sheet
 * could drift from the source of truth and no check would notice — the
 * verification script compared the prepared CSV to the live Sheet, so a bad
 * edit made to both would agree with itself. Deriving the file mechanically
 * from the source closes that loop: the prepared CSV is now an output, not an
 * input.
 *
 * THE TWO EMPTY COLUMNS ARE THE POINT, NOT AN OMISSION
 *
 * The Sheet carries `Feedback` and `Transaction Hash` per user. No feedback
 * text and no transaction hash has ever actually been recorded against a user,
 * so they are emitted empty on purpose, and `verify-users-sheet.mjs` fails if
 * either ever becomes non-empty. They exist so that a real response has
 * somewhere to go, and they must only ever be filled from a real response —
 * never from something plausible. If you are tempted to populate them, that is
 * the script working as intended and you should go and collect the data.
 *
 * WHY THE SURVEY COLUMNS ARE NOT CARRIED
 *
 * `users.xlsx` also holds three validation questions ("Did you successfully
 * connect your 1 AM wallet?", "...issue an access credential?", "...verify
 * access?"). They are not exported, and that is a deliberate, reversible
 * decision rather than an oversight:
 *
 *   - the live Sheet's column set is the schema `verify-users-sheet.mjs`
 *     checks, and changing it here would desynchronise the upload from the
 *     Sheet until someone edits the live document by hand;
 *   - every answer is "Yes" for all 50 respondents, so the columns carry no
 *     per-user signal — a person is in this record only because they did all
 *     three.
 *
 * The script prints the source's column set and the answer tally on every run
 * so that the decision stays visible, and it fails if the answers ever stop
 * being uniform, at which point the columns do carry signal and belong in the
 * Sheet. See USERS.md for the record hierarchy.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readXlsx } from './lib/xlsx.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'users.xlsx');
const CSV = join(root, 'onboarded-users-google-sheet.csv');
const TSV = join(root, 'onboarded-users-google-sheet.tsv');

/** Must match EXPECTED_COLUMNS in verify-users-sheet.mjs and the live Sheet. */
const IDENTITY = ['Name', 'Email', 'Wallet Address'];
const RESERVED = ['Feedback', 'Transaction Hash'];
const COLUMNS = [...IDENTITY, ...RESERVED];

const { header, rows } = readXlsx(SOURCE);

const missing = IDENTITY.filter((c) => !header.includes(c));
if (missing.length > 0) {
  console.error(`FAIL  users.xlsx is missing required column(s): ${missing.join(', ')}`);
  console.error(`      found: ${header.join(' | ')}`);
  process.exit(1);
}

const index = Object.fromEntries(IDENTITY.map((c) => [c, header.indexOf(c)]));

// Report the survey columns, and refuse to export once they carry signal.
const survey = header.filter((c) => !IDENTITY.includes(c));
if (survey.length > 0) {
  console.log(`users.xlsx also holds ${survey.length} validation column(s), not exported:`);
  for (const c of survey) {
    const i = header.indexOf(c);
    const tally = new Map();
    for (const r of rows) tally.set(r[i] || '(blank)', (tally.get(r[i] || '(blank)') ?? 0) + 1);
    const uniform = tally.size === 1;
    const summary = [...tally.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    console.log(`  - "${c}" -> ${summary}`);
    if (!uniform) {
      console.error(
        `FAIL  "${c}" is no longer a uniform answer, so it now carries per-user signal and belongs in the Sheet.`,
      );
      console.error('      Re-run after adding it to COLUMNS above AND to the live Sheet.');
      process.exit(1);
    }
  }
  console.log('  (uniform across all respondents, so they add no per-user signal — see the header comment)\n');
}

const records = rows.map((r) => IDENTITY.map((c) => r[index[c]].trim()));

// A duplicated wallet would make one address appear to be two people, which is
// the exact confusion the canonical record exists to prevent.
const wallets = records.map((r) => r[2]);
const dupes = wallets.filter((w, i) => wallets.indexOf(w) !== i);
if (dupes.length > 0) {
  console.error(`FAIL  duplicate wallet address(es) in users.xlsx: ${[...new Set(dupes)].join(', ')}`);
  process.exit(1);
}

const quote = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = [COLUMNS, ...records.map((r) => [...r, '', ''])]
  .map((r) => r.map(quote).join(','))
  .join('\n') + '\n';
const tsv = [COLUMNS, ...records.map((r) => [...r, '', ''])]
  .map((r) => r.join('\t'))
  .join('\n') + '\n';

if (process.argv.includes('--check')) {
  // Fails if the committed files are not exactly what this source produces, so
  // a hand edit to either is caught instead of being uploaded.
  let drift = 0;
  for (const [path, want] of [[CSV, csv], [TSV, tsv]]) {
    let have = '';
    try {
      have = readFileSync(path, 'utf8');
    } catch {
      console.error(`FAIL  ${path.split('/').pop()} is missing — run without --check to generate it`);
      drift += 1;
      continue;
    }
    if (have === want) {
      console.log(`PASS  ${path.split('/').pop()} matches users.xlsx (${records.length} users)`);
    } else {
      console.error(`FAIL  ${path.split('/').pop()} has been hand-edited away from users.xlsx`);
      drift += 1;
    }
  }
  process.exit(drift === 0 ? 0 : 1);
}

writeFileSync(CSV, csv);
writeFileSync(TSV, tsv);
console.log(`Wrote ${records.length} users from users.xlsx to:`);
console.log(`  ${CSV.split('/').pop()}`);
console.log(`  ${TSV.split('/').pop()}`);
console.log(`Columns: ${COLUMNS.join(', ')}  (${RESERVED.join(' and ')} left empty on purpose)`);
