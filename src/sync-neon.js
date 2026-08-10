/**
 * Resynchronisation manuelle du miroir Neon depuis le Google Sheet.
 *
 *   npm run sync-neon
 *
 * Sert à l'import initial de l'historique, et à rattraper le miroir s'il a
 * décroché (Neon injoignable au moment d'une écriture). Ne touche jamais au
 * Sheet : lecture seule côté Google.
 */
import 'dotenv/config';
import { listExpenses, loadReferences } from './sheets.js';
import { syncDepuisSheet, dernierSync, close, isEnabled } from './db.js';

async function main() {
  if (!isEnabled()) {
    console.error('❌ DATABASE_URL non définie.');
    process.exit(1);
  }

  const precedent = await dernierSync();
  console.log(
    precedent
      ? `ℹ️  Dernier miroir : ${new Date(precedent.date).toLocaleString('fr-FR')} (${precedent.nb_depenses} dépenses, source ${precedent.source})`
      : 'ℹ️  Aucun miroir précédent — import initial.'
  );

  console.log('📥 Lecture du Sheet…');
  const [expenses, references] = await Promise.all([listExpenses(true), loadReferences(true)]);
  console.log(`   ${expenses.length} dépenses, ${references.categories.length} catégories`);

  console.log('📤 Écriture dans Neon…');
  const res = await syncDepuisSheet({ expenses, references, source: 'sync-neon' });
  console.log(`✅ ${res.nbDepenses} dépenses, ${res.nbCategories} catégories synchronisées`);

  await close();
}

main().catch(async (err) => {
  console.error('❌ Échec :', err.message);
  await close().catch(() => {});
  process.exit(1);
});
