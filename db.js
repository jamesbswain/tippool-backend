import 'dotenv/config';
import fs from 'fs';
import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import { parse } from 'csv-parse/sync';

const db = new Database('tippool.db');

export function runMigrations() {
  const schema = fs.readFileSync('./schema.sql', 'utf8');
  db.exec(schema);
  console.log('DB ready ✅');
}

export function upsertValet({ name, email, stripe_account_id }) {
  const stmt = db.prepare(`
    INSERT INTO valets (name, email, stripe_account_id)
    VALUES (@name, @email, @stripe_account_id)
    ON CONFLICT(email) DO UPDATE SET
      name=excluded.name,
      stripe_account_id=COALESCE(excluded.stripe_account_id, valets.stripe_account_id)
  `);
  stmt.run({ name, email, stripe_account_id });
}

export function createCut({ cut_code, shift_id, date, start_time, roster_text, notes }) {
  const stmt = db.prepare(`
    INSERT INTO cuts (cut_code, shift_id, date, start_time, roster_text, status, notes)
    VALUES (@cut_code, @shift_id, @date, @start_time, @roster_text, 'open', @notes)
  `);
  const info = stmt.run({ cut_code, shift_id, date, start_time, roster_text, notes });
  return info.lastInsertRowid;
}

export function closeCut({ cut_code, end_time, tips_cents }) {
  const cut = db.prepare(`SELECT * FROM cuts WHERE cut_code=?`).get(cut_code);
  if (!cut) throw new Error('Cut not found');
  const names = (cut.roster_text || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const people_count = names.length;
  const per_person_cents = people_count ? Math.round(tips_cents / people_count) : 0;

  db.prepare(`
    UPDATE cuts SET end_time=@end_time, tips_cents=@tips_cents,
      people_count=@people_count, per_person_cents=@per_person_cents, status='closed'
    WHERE id=@id
  `).run({ id: cut.id, end_time, tips_cents, people_count, per_person_cents });

  const insertAlloc = db.prepare(`
    INSERT INTO allocations (cut_id, valet_name, stripe_account_id, payout_cents, payout_status)
    VALUES (@cut_id, @valet_name, @stripe_account_id, @payout_cents, 'pending')
  `);
  const findValet = db.prepare(`SELECT * FROM valets WHERE name = ? OR email = ? OR stripe_account_id = ?`);
  names.forEach(name => {
    const valet = findValet.get(name, null, null);
    insertAlloc.run({
      cut_id: cut.id,
      valet_name: name,
      stripe_account_id: valet?.stripe_account_id || null,
      payout_cents: per_person_cents
    });
  });

  return { ...cut, end_time, tips_cents, people_count, per_person_cents };
}

export function getCutByCode(cut_code) {
  return db.prepare(`SELECT * FROM cuts WHERE cut_code=?`).get(cut_code);
}

export function listAllocations(cut_id) {
  return db.prepare(`SELECT * FROM allocations WHERE cut_id=?`).all(cut_id);
}

export function markAllocationStatus(id, status) {
  db.prepare(`UPDATE allocations SET payout_status=? WHERE id=?`).run(status, id);
}

async function importCsv(url) {
  const res = await fetch(url);
  const text = await res.text();
  return parse(text, { columns: true, skip_empty_lines: true });
}

// CLI: node db.js init | import
const cmd = process.argv[2];
if (cmd === 'init') {
  runMigrations();
} else if (cmd === 'import') {
  runMigrations();
  const { SHEET_CUTS_CSV_URL } = process.env;
  if (!SHEET_CUTS_CSV_URL) {
    console.error('Set SHEET_CUTS_CSV_URL in .env (CSV published URL of your Cuts sheet)');
    process.exit(1);
  }
  const cuts = await importCsv(SHEET_CUTS_CSV_URL);
  const upsertCut = db.prepare(`
    INSERT INTO cuts (cut_code, shift_id, date, start_time, end_time, roster_text, tips_cents, people_count, per_person_cents, status, notes)
    VALUES (@cut_code, @shift_id, @date, @start_time, @end_time, @roster_text, @tips_cents, @people_count, @per_person_cents, @status, @notes)
    ON CONFLICT(cut_code) DO UPDATE SET
      end_time=excluded.end_time,
      roster_text=excluded.roster_text,
      tips_cents=excluded.tips_cents,
      people_count=excluded.people_count,
      per_person_cents=excluded.per_person_cents,
      status=excluded.status,
      notes=excluded.notes
  `);
  cuts.forEach(row => {
    const tipsCents = Math.round(parseFloat(row['Stripe Tips in this Cut ($)'] || '0') * 100);
    const names = (row['Roster (comma-separated)'] || '').split(',').map(s=>s.trim()).filter(Boolean);
    const perPersonCents = names.length ? Math.round(tipsCents / names.length) : 0;
    upsertCut.run({
      cut_code: row['CutID'],
      shift_id: row['ShiftID'],
      date: row['Date'],
      start_time: row['StartTime'],
      end_time: row['EndTime'],
      roster_text: row['Roster (comma-separated)'],
      tips_cents: tipsCents,
      people_count: names.length,
      per_person_cents: perPersonCents,
      status: row['EndTime'] ? 'closed' : 'open',
      notes: row['Notes'] || null
    });
  });
  console.log('Imported Cuts from CSV ✅');
}
