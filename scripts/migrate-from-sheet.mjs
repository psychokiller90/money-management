#!/usr/bin/env node
/**
 * scripts/migrate-from-sheet.mjs
 *
 * V2 Phase 0 — Migration de l'historique des dépenses depuis Google Sheets
 * vers Supabase (table transactions).
 *
 * Usage :
 *   node scripts/migrate-from-sheet.mjs --dry-run    # n'écrit rien, affiche le rapport
 *   node scripts/migrate-from-sheet.mjs --commit     # insère réellement
 *
 * Pré-requis : `node scripts/seed-references.mjs` doit avoir été exécuté avant.
 *
 * Le script applique la même logique de filtrage que listExpenses() côté bot :
 *   - skip lignes avec categorie/date/montant manquant
 *   - catégorie inconnue → warning, ligne ignorée
 *   - enseigne inconnue dans la catégorie → enseigne_id=NULL,
 *     enseigne_label = libellé brut (rapprochement fuzzy en phase 4)
 */

import 'dotenv/config';
import { supabase } from './_supabase-client.mjs';
import { listExpenses } from '../src/sheets.js';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isCommit = args.includes('--commit');

if (!isDryRun && !isCommit) {
  console.error('Usage : node scripts/migrate-from-sheet.mjs [--dry-run | --commit]');
  process.exit(1);
}
if (isDryRun && isCommit) {
  console.error('❌ --dry-run et --commit sont mutuellement exclusifs');
  process.exit(1);
}

const BATCH_SIZE = 500;

function toIsoDate(d) {
  // listExpenses retourne un objet Date construit via serialToDate()
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function loadSupabaseRefs() {
  const [{ data: cats, error: e1 }, { data: ens, error: e2 }] = await Promise.all([
    supabase.from('categories').select('id, name').is('archived_at', null),
    supabase
      .from('enseignes')
      .select('id, name, name_normalized, category_id')
      .is('archived_at', null),
  ]);
  if (e1) throw new Error(`SELECT categories : ${e1.message}`);
  if (e2) throw new Error(`SELECT enseignes : ${e2.message}`);

  const catByName = new Map(cats.map((c) => [c.name, c.id]));
  // Map composite : `${category_id}::${normalized}` → enseigne_id
  const ensByCatAndNormalized = new Map();
  for (const e of ens) {
    ensByCatAndNormalized.set(`${e.category_id}::${e.name_normalized}`, e.id);
  }
  return { catByName, ensByCatAndNormalized };
}

// Normalisation côté client identique au trigger SQL.
// Le trigger utilise lower + unaccent + trim. unaccent côté Node ≈ NFD + suppression diacritiques.
function normalize(name) {
  if (!name) return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

async function main() {
  console.log(`🚀 Migration ${isDryRun ? 'DRY-RUN' : 'COMMIT'}\n`);

  console.log('📚 Chargement des référentiels Supabase...');
  const { catByName, ensByCatAndNormalized } = await loadSupabaseRefs();
  console.log(`   ${catByName.size} catégorie(s), ${ensByCatAndNormalized.size} enseigne(s)\n`);

  if (catByName.size === 0) {
    console.error('❌ Aucune catégorie en base. Lance d\'abord : node scripts/seed-references.mjs');
    process.exit(1);
  }

  console.log('📄 Lecture de l\'onglet Dépenses depuis Google Sheets...');
  const expenses = await listExpenses(true);
  console.log(`   ${expenses.length} ligne(s) candidate(s)\n`);

  const stats = {
    total: expenses.length,
    ok: 0,
    skippedIncomplete: 0,
    skippedUnknownCategory: 0,
    warnUnknownEnseigne: 0,
  };
  const warnings = [];
  const payloads = [];
  const perCategory = new Map(); // categoryName → count

  for (const e of expenses) {
    // Cohérent avec listExpenses() qui filtre déjà mais on revérifie
    if (!e.categorie || !e.date || !e.montant) {
      stats.skippedIncomplete++;
      continue;
    }
    const categoryId = catByName.get(e.categorie);
    if (!categoryId) {
      stats.skippedUnknownCategory++;
      warnings.push(
        `Ligne ${e.rowIndex} : catégorie "${e.categorie}" introuvable en base — ignorée`
      );
      continue;
    }

    const ensNorm = normalize(e.enseigne);
    const enseigneId = ensNorm
      ? ensByCatAndNormalized.get(`${categoryId}::${ensNorm}`) || null
      : null;
    if (e.enseigne && !enseigneId) {
      stats.warnUnknownEnseigne++;
      warnings.push(
        `Ligne ${e.rowIndex} : enseigne "${e.enseigne}" inconnue dans ${e.categorie} — insérée avec enseigne_label brut`
      );
    }

    const isoDate = toIsoDate(e.date);
    if (!isoDate) {
      stats.skippedIncomplete++;
      warnings.push(`Ligne ${e.rowIndex} : date invalide — ignorée`);
      continue;
    }

    payloads.push({
      date: isoDate,
      amount: Number(e.montant),
      category_id: categoryId,
      enseigne_id: enseigneId,
      enseigne_label: e.enseigne || null,
      designation: e.designation || null,
      transaction_type: 'expense',
      source: 'migration',
      sheet_row_index: e.rowIndex,
    });

    perCategory.set(e.categorie, (perCategory.get(e.categorie) || 0) + 1);
    stats.ok++;
  }

  // ── Rapport ──────────────────────────────────────────────
  console.log('📊 Rapport de transformation :');
  console.log(`   • Total lu                       : ${stats.total}`);
  console.log(`   • Prêts à insérer                : ${stats.ok}`);
  console.log(`   • Ignorés (incomplets/dates KO)  : ${stats.skippedIncomplete}`);
  console.log(`   • Ignorés (catégorie inconnue)   : ${stats.skippedUnknownCategory}`);
  console.log(`   • Warnings enseigne inconnue     : ${stats.warnUnknownEnseigne}`);
  console.log('\n📂 Répartition par catégorie :');
  for (const [cat, n] of [...perCategory.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   • ${cat.padEnd(15)} ${n}`);
  }

  const totalAmount = payloads.reduce((s, p) => s + p.amount, 0);
  console.log(`\n💶 Somme des montants à insérer : ${totalAmount.toFixed(2)} €`);

  if (warnings.length > 0 && warnings.length <= 20) {
    console.log('\n⚠️  Warnings détaillés :');
    warnings.forEach((w) => console.log(`   • ${w}`));
  } else if (warnings.length > 20) {
    console.log(`\n⚠️  ${warnings.length} warnings (20 premiers affichés) :`);
    warnings.slice(0, 20).forEach((w) => console.log(`   • ${w}`));
    console.log(`   • ... +${warnings.length - 20} autres`);
  }

  // ── Insert ───────────────────────────────────────────────
  if (isDryRun) {
    console.log('\n🔍 Mode --dry-run : aucune insertion réalisée.');
    console.log('   Pour insérer vraiment : node scripts/migrate-from-sheet.mjs --commit');
    return;
  }

  console.log(`\n💾 Insertion par batches de ${BATCH_SIZE}...`);
  let inserted = 0;
  for (let i = 0; i < payloads.length; i += BATCH_SIZE) {
    const batch = payloads.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('transactions').insert(batch);
    if (error) {
      console.error(`❌ Erreur batch ${i / BATCH_SIZE + 1} : ${error.message}`);
      console.error('   Tu peux re-rejouer après TRUNCATE public.transactions RESTART IDENTITY;');
      process.exit(1);
    }
    inserted += batch.length;
    process.stdout.write(`   ${inserted}/${payloads.length}\r`);
  }
  console.log(`\n\n✅ ${inserted} transaction(s) insérée(s) avec succès.`);
}

main().catch((err) => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});
