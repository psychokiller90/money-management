#!/usr/bin/env node
/**
 * scripts/seed-references.mjs
 *
 * V2 Phase 0 — Seed des catégories + enseignes depuis le Google Sheet
 * vers Supabase.
 *
 * Pattern : select-then-insert (idempotent, robuste).
 *
 * Usage :
 *   node scripts/seed-references.mjs
 */

import 'dotenv/config';
import { supabase } from './_supabase-client.mjs';
import { loadReferences } from '../src/sheets.js';

async function main() {
  console.log('📚 Lecture du référentiel depuis Google Sheets...');
  const refs = await loadReferences(true);
  console.log(`   ${refs.categories.length} catégorie(s) trouvée(s)`);

  // ── 1. Catégories ────────────────────────────────────────
  console.log('\n📂 Synchronisation des catégories...');
  const { data: existingCats, error: e1 } = await supabase
    .from('categories')
    .select('id, name')
    .is('archived_at', null);
  if (e1) {
    console.error('❌ SELECT categories :', e1);
    process.exit(1);
  }

  const existingCatNames = new Set(existingCats.map((c) => c.name));
  const newCats = refs.categories
    .map((name, position) => ({ name, position }))
    .filter((c) => !existingCatNames.has(c.name));

  if (newCats.length > 0) {
    const { error: e2 } = await supabase.from('categories').insert(newCats);
    if (e2) {
      console.error('❌ INSERT categories :', e2);
      process.exit(1);
    }
    console.log(`   ✅ ${newCats.length} nouvelle(s) catégorie(s) ajoutée(s)`);
    newCats.forEach((c) => console.log(`      + ${c.name}`));
  } else {
    console.log('   ✓ Aucune nouvelle catégorie à ajouter');
  }

  // Re-fetch pour récupérer les UUIDs
  const { data: allCats, error: e3 } = await supabase
    .from('categories')
    .select('id, name')
    .is('archived_at', null);
  if (e3) {
    console.error('❌ SELECT categories (refetch) :', e3);
    process.exit(1);
  }
  const catByName = new Map(allCats.map((c) => [c.name, c.id]));
  console.log(`   ✅ ${allCats.length} catégorie(s) en base au total`);

  // ── 2. Enseignes ─────────────────────────────────────────
  console.log('\n🏪 Synchronisation des enseignes...');

  const { data: existingEns, error: e4 } = await supabase
    .from('enseignes')
    .select('category_id, name_normalized')
    .is('archived_at', null);
  if (e4) {
    console.error('❌ SELECT enseignes :', e4);
    process.exit(1);
  }
  const existingEnsKeys = new Set(
    existingEns.map((e) => `${e.category_id}::${e.name_normalized}`)
  );

  // Normalisation identique au trigger SQL (lower + unaccent + trim)
  const normalize = (s) =>
    s ? s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim() : '';

  let totalFromSheet = 0;
  const warnings = [];
  const perCatSummary = [];

  for (const cat of refs.categories) {
    const categoryId = catByName.get(cat);
    if (!categoryId) {
      warnings.push(`Catégorie introuvable en base : ${cat}`);
      continue;
    }
    const enseignes = refs.enseignes[cat] || [];
    totalFromSheet += enseignes.length;

    const newOnes = enseignes.filter(
      (name) => !existingEnsKeys.has(`${categoryId}::${normalize(name)}`)
    );

    if (newOnes.length === 0) {
      perCatSummary.push(`   ✓ ${cat.padEnd(15)} ${enseignes.length} fournie(s), 0 nouvelle(s)`);
      continue;
    }

    const rows = newOnes.map((name) => ({ category_id: categoryId, name }));
    const { error: e5 } = await supabase.from('enseignes').insert(rows);
    if (e5) {
      warnings.push(`${cat} : ${e5.message}`);
      perCatSummary.push(`   ❌ ${cat.padEnd(15)} ${e5.message}`);
      continue;
    }
    // Mémorise les nouvelles pour éviter doublons si le Sheet en a (paranoia)
    newOnes.forEach((n) =>
      existingEnsKeys.add(`${categoryId}::${normalize(n)}`)
    );
    perCatSummary.push(
      `   ✅ ${cat.padEnd(15)} ${enseignes.length} fournie(s), ${newOnes.length} nouvelle(s)`
    );
  }
  perCatSummary.forEach((l) => console.log(l));

  // ── 3. Récap ─────────────────────────────────────────────
  const { count: finalCount, error: e6 } = await supabase
    .from('enseignes')
    .select('id', { count: 'exact', head: true })
    .is('archived_at', null);

  console.log('\n📊 Récapitulatif :');
  console.log(`   • Catégories en base : ${allCats.length}`);
  console.log(`   • Enseignes fournies par le Sheet : ${totalFromSheet}`);
  if (!e6) console.log(`   • Enseignes en base : ${finalCount}`);

  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings :');
    warnings.forEach((w) => console.log(`   • ${w}`));
  }

  console.log('\n✅ Seed terminé.');
}

main().catch((err) => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});
