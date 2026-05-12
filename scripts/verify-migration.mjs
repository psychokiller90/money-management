#!/usr/bin/env node
/**
 * scripts/verify-migration.mjs
 *
 * V2 Phase 0 — Vérification de la migration Sheets → Supabase.
 *
 * Compare :
 *   • COUNT(*) entre Sheet et Supabase
 *   • SUM(amount) entre Sheet et Supabase (tolérance < 0.01€)
 *   • Spot-check de 5 transactions (plus ancienne, plus récente, montant max,
 *     montant min, échantillon aléatoire)
 *
 * Usage :
 *   node scripts/verify-migration.mjs
 */

import 'dotenv/config';
import { supabase } from './_supabase-client.mjs';
import { listExpenses } from '../src/sheets.js';

function fmtDate(d) {
  if (!(d instanceof Date)) d = new Date(d);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function main() {
  console.log('🔍 Vérification de la migration\n');

  // ── 1. Données Sheet (filtrées comme à la migration) ─────
  console.log('📄 Lecture Sheet...');
  const sheetExpenses = (await listExpenses(true)).filter(
    (e) => e.categorie && e.date && e.montant
  );
  const sheetCount = sheetExpenses.length;
  const sheetSum = sheetExpenses.reduce((s, e) => s + Number(e.montant), 0);

  // ── 2. Données Supabase ──────────────────────────────────
  console.log('💾 Lecture Supabase (source=migration)...');
  const { count: dbCount, error: countErr } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'migration');
  if (countErr) throw new Error(`COUNT : ${countErr.message}`);

  const { data: sumRow, error: sumErr } = await supabase
    .rpc('compute_migration_sum')
    .single();
  let dbSum = null;
  if (sumErr) {
    // RPC absente — fallback : récupère toutes les transactions et somme côté Node
    const { data: rows, error: e2 } = await supabase
      .from('transactions')
      .select('amount')
      .eq('source', 'migration');
    if (e2) throw new Error(`SELECT amount : ${e2.message}`);
    dbSum = rows.reduce((s, r) => s + Number(r.amount), 0);
  } else {
    dbSum = Number(sumRow.sum);
  }

  // ── 3. Comparaison ───────────────────────────────────────
  console.log('\n📊 Résultats :');
  console.log(`   • Lignes Sheet (filtrées) : ${sheetCount}`);
  console.log(`   • Lignes Supabase         : ${dbCount}`);
  console.log(
    `   • Delta count             : ${dbCount - sheetCount} ${
      dbCount === sheetCount ? '✅' : '⚠️'
    }`
  );
  console.log(`   • Somme Sheet             : ${sheetSum.toFixed(2)} €`);
  console.log(`   • Somme Supabase          : ${dbSum.toFixed(2)} €`);
  const deltaSum = Math.abs(dbSum - sheetSum);
  console.log(
    `   • Delta sum               : ${deltaSum.toFixed(2)} € ${
      deltaSum < 0.01 ? '✅' : '⚠️'
    }`
  );

  // ── 4. Spot-check 5 lignes ───────────────────────────────
  console.log('\n🎯 Spot-check (5 lignes) :');
  const valid = sheetExpenses.slice();
  valid.sort((a, b) => a.date.getTime() - b.date.getTime());
  const oldest = valid[0];
  const newest = valid[valid.length - 1];
  const byAmount = [...valid].sort((a, b) => b.montant - a.montant);
  const maxAmt = byAmount[0];
  const minAmt = byAmount[byAmount.length - 1];
  const random = valid[Math.floor(Math.random() * valid.length)];

  const samples = [
    { label: 'Plus ancienne', e: oldest },
    { label: 'Plus récente', e: newest },
    { label: 'Montant max', e: maxAmt },
    { label: 'Montant min', e: minAmt },
    { label: 'Aléatoire', e: random },
  ];

  for (const { label, e } of samples) {
    const { data, error } = await supabase
      .from('transactions')
      .select('date, amount, category_id, enseigne_label, designation, sheet_row_index, categories(name)')
      .eq('sheet_row_index', e.rowIndex)
      .eq('source', 'migration')
      .maybeSingle();

    if (error || !data) {
      console.log(`   ❌ ${label.padEnd(15)} ligne ${e.rowIndex} : introuvable en base`);
      continue;
    }

    const sheetD = fmtDate(e.date);
    const sheetAmt = Number(e.montant).toFixed(2);
    const dbAmt = Number(data.amount).toFixed(2);
    const ok = sheetD === data.date && sheetAmt === dbAmt;
    console.log(
      `   ${ok ? '✅' : '⚠️'} ${label.padEnd(15)} ${sheetD} | ${sheetAmt}€ | ${e.enseigne || '—'} | ${e.categorie}`
    );
    if (!ok) {
      console.log(`        DB → ${data.date} | ${dbAmt}€ | ${data.enseigne_label || '—'} | ${data.categories?.name}`);
    }
  }

  console.log(
    `\n${
      dbCount === sheetCount && deltaSum < 0.01
        ? '✅ Migration validée'
        : '⚠️ Écart détecté — examine les sorties ci-dessus'
    }`
  );
}

main().catch((err) => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});
