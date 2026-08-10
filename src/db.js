/**
 * Miroir Postgres (Neon) du Google Sheet.
 *
 * Le Sheet reste la source de vérité : ce module ne fait que recopier son état
 * après chaque écriture. Aucune fonction d'ici n'est sur le chemin critique du
 * bot — les erreurs sont journalisées, jamais propagées.
 */
import pg from 'pg';

let _pool = null;

function pool() {
  if (_pool) return _pool;
  _pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  _pool.on('error', (err) => console.error('Erreur pool Postgres:', err.message));
  return _pool;
}

export function isEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

/**
 * Recopie l'état complet du Sheet dans Neon, en une transaction.
 * Le Sheet fait autorité : on remplace, on ne fusionne pas.
 *
 * @param {object} p
 * @param {Array}  p.expenses   sortie de sheets.listExpenses()
 * @param {object} p.references sortie de sheets.loadReferences()
 * @param {string} p.source     ce qui a déclenché le miroir (append, delete, cron…)
 */
export async function syncDepuisSheet({ expenses, references, source = 'manuel' }) {
  const client = await pool().connect();
  try {
    await client.query('begin');

    await client.query('truncate depenses');
    if (expenses.length) {
      const cols = 6;
      const values = [];
      const tuples = expenses.map((e, i) => {
        values.push(
          e.rowIndex,
          e.categorie,
          e.date.toISOString().slice(0, 10),
          e.enseigne || null,
          e.designation || null,
          e.montant
        );
        return `(${Array.from({ length: cols }, (_, j) => `$${i * cols + j + 1}`).join(', ')})`;
      });
      await client.query(
        `insert into depenses (row_index, categorie, date, enseigne, designation, montant)
         values ${tuples.join(', ')}`,
        values
      );
    }

    // Les enseignes ont une FK sur categories : on purge dans cet ordre.
    await client.query('delete from enseignes');
    await client.query('delete from categories');
    for (const cat of references.categories) {
      await client.query(
        'insert into categories (nom, colonne, synced_at) values ($1, $2, now())',
        [cat, references.catToCol?.[cat] || null]
      );
      const liste = references.enseignes?.[cat] || [];
      if (liste.length) {
        await client.query(
          `insert into enseignes (categorie, nom)
           select $1, unnest($2::text[]) on conflict do nothing`,
          [cat, liste]
        );
      }
    }

    await client.query(
      `insert into sync_log (source, nb_depenses, status, details)
       values ($1, $2, 'success', $3)`,
      [
        source,
        expenses.length,
        JSON.stringify({
          categories: references.categories.length,
          enseignes: Object.values(references.enseignes || {}).reduce((a, l) => a + l.length, 0),
        }),
      ]
    );

    await client.query('commit');
    return { nbDepenses: expenses.length, nbCategories: references.categories.length };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    try {
      await pool().query(
        `insert into sync_log (source, nb_depenses, status, details) values ($1, 0, 'failed', $2)`,
        [source, err.message]
      );
    } catch (e) {
      /* la base est injoignable, on ne peut rien tracer */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Dernière synchronisation réussie, ou null. */
export async function dernierSync() {
  try {
    const { rows } = await pool().query(
      `select date, source, nb_depenses, status from sync_log
       where status = 'success' order by date desc limit 1`
    );
    return rows[0] || null;
  } catch (err) {
    console.error('Erreur dernierSync:', err.message);
    return null;
  }
}

export async function close() {
  if (_pool) await _pool.end();
  _pool = null;
}
