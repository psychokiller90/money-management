import { google } from 'googleapis';
import * as db from './db.js';

const DATA_SHEET = 'data';
const DEPENSES_SHEET = 'Dépenses';
const CACHE_TTL_MS = 10 * 60 * 1000;
const DATA_MAX_COL = 'Z'; // jusqu'à 26 catégories possibles

function columnLetter(idx) {
  // 0 → A, 1 → B, ..., 25 → Z, 26 → AA (non supporté ici)
  if (idx < 0 || idx > 25) throw new Error(`Index colonne hors limite : ${idx}`);
  return String.fromCharCode(65 + idx);
}

let _sheets = null;
let _refsCache = null;
let _expensesCache = null;
let _sheetIdsCache = null; // { [sheetTitle]: sheetId }
const EXPENSES_CACHE_TTL_MS = 60 * 1000;

function getSheetsClient() {
  if (_sheets) return _sheets;
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

function spreadsheetId() {
  return process.env.SPREADSHEET_ID;
}

/**
 * Invalide le cache local puis recopie l'état du Sheet dans Neon.
 *
 * Volontairement sans `await` : le miroir ne doit ni ralentir le bot ni le
 * faire échouer. Si Neon est injoignable, le Sheet a déjà été écrit et le
 * prochain miroir rattrapera l'écart (resynchronisation complète).
 */
function invalider(quoi) {
  if (quoi === 'depenses') _expensesCache = null;
  else _refsCache = null;

  if (!db.isEnabled()) return;
  (async () => {
    const [expenses, references] = await Promise.all([listExpenses(), loadReferences()]);
    await db.syncDepuisSheet({ expenses, references, source: `sheet:${quoi}` });
  })().catch((err) => console.error(`⚠️  Miroir Neon (${quoi}) :`, err.message));
}

/**
 * Récupère les sheetId numériques de chaque onglet (pour batchUpdate).
 * Cache illimité (les IDs sont stables pour la durée de vie du process).
 */
async function getSheetIds() {
  if (_sheetIdsCache) return _sheetIdsCache;
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.get({ spreadsheetId: spreadsheetId() });
  const out = {};
  for (const s of data.sheets || []) {
    out[s.properties.title] = s.properties.sheetId;
  }
  _sheetIdsCache = out;
  return out;
}

/**
 * Listes des catégories (col A du Sheet) + enseignes par catégorie.
 * Cache 10 min ; passe `force=true` pour rafraîchir.
 */
export async function loadReferences(force = false) {
  if (!force && _refsCache && Date.now() - _refsCache.fetchedAt < CACHE_TTL_MS) {
    return _refsCache;
  }
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!A1:${DATA_MAX_COL}50`,
    majorDimension: 'COLUMNS',
  });

  const categories = [];
  const enseignes = {};
  const catToCol = {};
  (data.values || []).forEach((col, idx) => {
    if (!col?.length) return;
    const cat = col[0];
    if (!cat) return;
    categories.push(cat);
    enseignes[cat] = col.slice(1).filter((v) => v && String(v).trim());
    catToCol[cat] = columnLetter(idx);
  });
  _refsCache = { fetchedAt: Date.now(), categories, enseignes, catToCol };
  return _refsCache;
}

/**
 * Trouve la lettre de colonne pour une catégorie donnée (ex: "Courses" → "A").
 * Lance une erreur si la catégorie n'existe pas.
 */
async function findCategoryColumn(categorie) {
  const refs = await loadReferences();
  const col = refs.catToCol[categorie];
  if (!col) throw new Error(`Catégorie inconnue : ${categorie}`);
  return col;
}

/**
 * Insère une dépense dans l'onglet Dépenses (5 colonnes A:E).
 * data : { categorie, date: 'YYYY-MM-DD', enseigne, designation?, montant }
 */
export async function appendExpense(d) {
  const sheets = getSheetsClient();
  const [year, month, day] = d.date.split('-').map(Number);
  const dateFormula = `=DATE(${year};${month};${day})`;

  const row = [
    d.categorie,
    dateFormula,
    d.enseigne,
    d.designation || '',
    Number(d.montant),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${DEPENSES_SHEET}'!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  invalider('depenses');
  return row;
}

/**
 * Ajoute une nouvelle enseigne dans la colonne `data` correspondante,
 * pour qu'elle apparaisse dans les listes Sheets futures. Invalide le cache.
 */
export async function addEnseigne(categorie, enseigne) {
  const col = await findCategoryColumn(categorie);

  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}2:${col}50`,
    majorDimension: 'COLUMNS',
  });
  const existing = (data.values?.[0] || []).filter((v) => v && String(v).trim());
  const nextRow = 2 + existing.length;

  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}${nextRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[enseigne]] },
  });
  invalider('references');
}

/**
 * Liste toutes les dépenses du Sheet (pour détection doublons + stats).
 * Renvoie [{ rowIndex, categorie, date: Date, enseigne, designation, montant }]
 */
export async function listExpenses(force = false) {
  if (!force && _expensesCache && Date.now() - _expensesCache.fetchedAt < EXPENSES_CACHE_TTL_MS) {
    return _expensesCache.expenses;
  }
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `'${DEPENSES_SHEET}'!A2:E`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const rows = data.values || [];
  const expenses = rows
    .map((r, i) => ({
      rowIndex: i + 2,
      categorie: r[0] || '',
      date: serialToDate(r[1]),
      enseigne: r[2] || '',
      designation: r[3] || '',
      montant: Number(r[4]) || 0,
    }))
    .filter((e) => e.categorie && e.date && e.montant);
  _expensesCache = { fetchedAt: Date.now(), expenses };
  return expenses;
}

/**
 * Cherche une dépense déjà enregistrée susceptible d'être un doublon.
 * Critères : même montant (à 0.01€ près), même enseigne (insensible casse),
 * date dans une fenêtre de ±toleranceDays jours.
 * @param {{date: string, montant: number, enseigne: string}} candidate
 * @param {number} toleranceDays
 */
export async function findDuplicate(candidate, toleranceDays = 2) {
  if (!candidate.date || !candidate.montant || !candidate.enseigne) return null;
  const expenses = await listExpenses();
  const target = new Date(candidate.date + 'T00:00:00Z').getTime();
  const tolMs = toleranceDays * 86400 * 1000;
  const enseigneLow = candidate.enseigne.toLowerCase().trim();
  const amount = Number(candidate.montant);

  return expenses.find((e) => {
    if (Math.abs(e.montant - amount) > 0.01) return false;
    if ((e.enseigne || '').toLowerCase().trim() !== enseigneLow) return false;
    if (!e.date) return false;
    return Math.abs(e.date.getTime() - target) <= tolMs;
  }) || null;
}

// Excel/Sheets serial → JS Date (epoch 1899-12-30, 25569 = 1970-01-01)
function serialToDate(serial) {
  if (typeof serial !== 'number') return null;
  return new Date((serial - 25569) * 86400 * 1000);
}

// ─── Vue globale ─────────────────────────────────────────────
const GLOBAL_SHEET = 'Vue globale';
const GLOBAL_LABELS = {
  imprevus: ['imprevus', 'imprevu'],
  totalDepenses: ['totaldepenses', 'totaldepense', 'totaldepensesmois'],
  objectifEpargne: ['objectifepargne', 'objectifepargnes', 'objectifsepargne'],
  soldeRestant: ['solderestant', 'soldedisponible'],
};
const MONTHS_FR = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

function normalizeLabel(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // accents
    .replace(/[^a-z0-9]/g, ''); // emojis, espaces, ponctuation
}

function valueNear(grid, row, col) {
  const right = grid[row]?.[col + 1];
  if (right !== undefined && String(right).trim() !== '') return String(right);
  const below = grid[row + 1]?.[col];
  if (below !== undefined && String(below).trim() !== '') return String(below);
  return null;
}

/**
 * Cherche l'ancrage du mois donné (ex: "Mai", "MAI 2026", "Mai 2026")
 * dans la grille. Renvoie {r, c} ou null.
 */
function findMonthAnchor(grid, monthIdx, year) {
  const month = MONTHS_FR[monthIdx];
  const candidates = [
    month,
    `${month}${year}`,
    `${month}${String(year).slice(2)}`, // "mai26"
  ];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const norm = normalizeLabel(row[c]);
      if (!norm) continue;
      if (candidates.includes(norm)) return { r, c };
    }
  }
  return null;
}

function findOccurrences(grid, alts) {
  const out = [];
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const norm = normalizeLabel(row[c]);
      if (norm && alts.some((a) => norm === a)) out.push({ r, c });
    }
  }
  return out;
}

/**
 * Lit la feuille "Vue globale" et renvoie les 4 indicateurs clés
 * pour le mois courant. Gère 3 layouts :
 *  - matrice (mois en en-tête de colonnes, labels en colonne)
 *  - sections verticales (entête mois + labels en-dessous)
 *  - simple (un seul jeu de labels) → fallback scan
 */
export async function loadGlobalView() {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `'${GLOBAL_SHEET}'!A1:Z200`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const grid = data.values || [];

  const now = new Date();
  const monthIdx = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const anchor = findMonthAnchor(grid, monthIdx, year);

  const result = {
    imprevus: null,
    totalDepenses: null,
    objectifEpargne: null,
    soldeRestant: null,
    monthFound: !!anchor,
  };

  for (const [key, alts] of Object.entries(GLOBAL_LABELS)) {
    const occurrences = findOccurrences(grid, alts);
    if (occurrences.length === 0) continue;

    // 1) Matrice : ancre dans une ligne au-dessus du label, à une colonne différente
    if (anchor) {
      let picked = null;
      for (const occ of occurrences) {
        if (anchor.r < occ.r && anchor.c !== occ.c) {
          const v = grid[occ.r]?.[anchor.c];
          if (v !== undefined && String(v).trim() !== '') {
            picked = String(v);
            break;
          }
        }
      }
      if (picked !== null) {
        result[key] = picked;
        continue;
      }

      // 2) Sections : prend l'occurrence située APRÈS l'ancre (la plus proche)
      const after = occurrences
        .filter((o) => o.r >= anchor.r)
        .sort((a, b) => a.r - b.r || a.c - b.c);
      if (after.length > 0) {
        const v = valueNear(grid, after[0].r, after[0].c);
        if (v !== null) {
          result[key] = v;
          continue;
        }
      }
    }

    // 3) Fallback : première occurrence trouvée
    const occ = occurrences[0];
    const v = valueNear(grid, occ.r, occ.c);
    if (v !== null) result[key] = v;
  }
  return result;
}

/**
 * Met à jour une dépense existante (par rowIndex 1-based).
 * data : { categorie, date, enseigne, designation, montant }
 */
export async function updateExpense(rowIndex, d) {
  const sheets = getSheetsClient();
  const [year, month, day] = d.date.split('-').map(Number);
  const dateFormula = `=DATE(${year};${month};${day})`;
  const row = [
    d.categorie,
    dateFormula,
    d.enseigne,
    d.designation || '',
    Number(d.montant),
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `'${DEPENSES_SHEET}'!A${rowIndex}:E${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
  invalider('depenses');
  return row;
}

/**
 * Supprime physiquement une ligne de l'onglet Dépenses (par rowIndex 1-based).
 */
export async function deleteExpense(rowIndex) {
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  const sheetId = ids[DEPENSES_SHEET];
  if (sheetId === undefined) throw new Error(`Onglet ${DEPENSES_SHEET} introuvable.`);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1, // 0-indexed exclusive
              endIndex: rowIndex,
            },
          },
        },
      ],
    },
  });
  invalider('depenses');
}

/**
 * Liste les plages nommées du document.
 */
async function listNamedRanges() {
  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.get({
    spreadsheetId: spreadsheetId(),
    fields: 'namedRanges',
  });
  return data.namedRanges || [];
}

/**
 * Crée ou met à jour une plage nommée pointant vers la colonne d'enseignes
 * d'une catégorie (lignes 2..50).
 * @param {string} cat
 * @param {string} colLetter
 */
async function upsertNamedRangeForCategory(cat, colLetter) {
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  const dataSheetId = ids[DATA_SHEET];
  if (dataSheetId === undefined) throw new Error(`Onglet ${DATA_SHEET} introuvable.`);
  const colIdx = colLetter.charCodeAt(0) - 65; // A → 0

  const namedRanges = await listNamedRanges();
  const existing = namedRanges.find((nr) => nr.name === cat);

  const rangeDef = {
    sheetId: dataSheetId,
    startRowIndex: 1, // ligne 2 (0-indexed)
    endRowIndex: 50,
    startColumnIndex: colIdx,
    endColumnIndex: colIdx + 1,
  };

  const requests = [];
  if (existing) {
    requests.push({
      updateNamedRange: {
        namedRange: { namedRangeId: existing.namedRangeId, name: cat, range: rangeDef },
        fields: 'name,range',
      },
    });
  } else {
    requests.push({
      addNamedRange: { namedRange: { name: cat, range: rangeDef } },
    });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests },
  });
}

/**
 * Supprime la plage nommée pour une catégorie (no-op si absente).
 */
async function deleteNamedRangeForCategory(cat) {
  const sheets = getSheetsClient();
  const namedRanges = await listNamedRanges();
  const existing = namedRanges.find((nr) => nr.name === cat);
  if (!existing) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [{ deleteNamedRange: { namedRangeId: existing.namedRangeId } }],
    },
  });
}

/**
 * Renomme une plage nommée existante (no-op si absente).
 */
async function renameNamedRangeForCategory(oldName, newName) {
  const sheets = getSheetsClient();
  const namedRanges = await listNamedRanges();
  const existing = namedRanges.find((nr) => nr.name === oldName);
  if (!existing) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          updateNamedRange: {
            namedRange: { namedRangeId: existing.namedRangeId, name: newName, range: existing.range },
            fields: 'name',
          },
        },
      ],
    },
  });
}

/**
 * Réécrit la colonne `data` d'une catégorie avec la liste fournie
 * (header inchangé en ligne 1, enseignes en lignes 2..N+1, le reste vidé).
 * @param {string} categorie
 * @param {string[]} list
 */
async function rewriteEnseigneColumn(categorie, list) {
  const col = await findCategoryColumn(categorie);

  const sheets = getSheetsClient();
  // 1) Vide la colonne (lignes 2 à 50) pour repartir propre
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}2:${col}50`,
  });
  // 2) Réécrit la liste contiguë
  if (list.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `${DATA_SHEET}!${col}2:${col}${1 + list.length}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: list.map((v) => [v]) },
    });
  }
  invalider('references');
}

/**
 * Supprime une enseigne de la liste data (compaction de la colonne).
 */
export async function delEnseigne(categorie, enseigne) {
  const refs = await loadReferences(true);
  const current = refs.enseignes[categorie] || [];
  const target = enseigne.toLowerCase().trim();
  const next = current.filter((e) => e.toLowerCase().trim() !== target);
  if (next.length === current.length) {
    throw new Error(`Enseigne « ${enseigne} » introuvable pour ${categorie}.`);
  }
  await rewriteEnseigneColumn(categorie, next);
}

/**
 * Ajoute une nouvelle catégorie dans `data` : trouve la première colonne libre
 * (header vide) parmi A:Z et y inscrit le nom. Refuse les doublons.
 */
export async function addCategorie(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Nom de catégorie vide.');

  const refs = await loadReferences(true);
  if (refs.categories.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`La catégorie « ${trimmed} » existe déjà.`);
  }

  const sheets = getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!A1:${DATA_MAX_COL}1`,
  });
  const headers = data.values?.[0] || [];
  // Trouve le premier index où le header est vide
  let freeIdx = -1;
  for (let i = 0; i <= 25; i++) {
    if (!headers[i] || !String(headers[i]).trim()) {
      freeIdx = i;
      break;
    }
  }
  if (freeIdx < 0) {
    throw new Error('Plus de colonne libre dans `data` (max 26).');
  }
  const col = columnLetter(freeIdx);
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[trimmed]] },
  });
  invalider('references');

  // P6 — auto-création de la plage nommée pour la validation INDIRECT
  let namedRangeOk = true;
  try {
    await upsertNamedRangeForCategory(trimmed, col);
  } catch (err) {
    console.error('[upsertNamedRangeForCategory]', err);
    namedRangeOk = false;
  }
  return { col, name: trimmed, namedRangeOk };
}

/**
 * Supprime une catégorie : vide entièrement la colonne dans `data`
 * (header + enseignes). Les dépenses déjà saisies ne sont pas modifiées.
 */
export async function delCategorie(name) {
  const refs = await loadReferences(true);
  const cat = refs.categories.find((c) => c === name);
  if (!cat) throw new Error(`Catégorie introuvable : ${name}`);
  const col = refs.catToCol[cat];
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}1:${col}50`,
  });
  invalider('references');

  // P6 — supprime la plage nommée associée
  let namedRangeOk = true;
  try {
    await deleteNamedRangeForCategory(name);
  } catch (err) {
    console.error('[deleteNamedRangeForCategory]', err);
    namedRangeOk = false;
  }
  return { namedRangeOk };
}

/**
 * Renomme une catégorie : met à jour le header de la colonne dans `data`.
 * Les anciennes lignes de l'onglet Dépenses ne sont PAS migrées (gardent l'ancien
 * nom). La validation INDIRECT() côté Sheet peut nécessiter une mise à jour
 * manuelle (named ranges).
 */
export async function renameCategorie(oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Nouveau nom vide.');

  const refs = await loadReferences(true);
  if (!refs.categories.includes(oldName)) {
    throw new Error(`Catégorie introuvable : ${oldName}`);
  }
  if (
    refs.categories.some(
      (c) => c.toLowerCase() === trimmed.toLowerCase() && c !== oldName
    )
  ) {
    throw new Error(`La catégorie « ${trimmed} » existe déjà.`);
  }
  const col = refs.catToCol[oldName];
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `${DATA_SHEET}!${col}1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[trimmed]] },
  });
  invalider('references');

  // P6 — renomme la plage nommée associée
  let namedRangeOk = true;
  try {
    await renameNamedRangeForCategory(oldName, trimmed);
  } catch (err) {
    console.error('[renameNamedRangeForCategory]', err);
    namedRangeOk = false;
  }
  return { namedRangeOk };
}

/**
 * Renomme une enseigne dans la liste data (l'ordre est préservé).
 */
export async function renameEnseigne(categorie, oldName, newName) {
  const refs = await loadReferences(true);
  const current = refs.enseignes[categorie] || [];
  const target = oldName.toLowerCase().trim();
  let found = false;
  const next = current.map((e) => {
    if (e.toLowerCase().trim() === target) {
      found = true;
      return newName;
    }
    return e;
  });
  if (!found) {
    throw new Error(`Enseigne « ${oldName} » introuvable pour ${categorie}.`);
  }
  await rewriteEnseigneColumn(categorie, next);
}

// ─── Échéances (paiements en plusieurs fois) ──────────────────
const ECHEANCES_SHEET = 'Échéances';
let _echeancesCache = null;

/**
 * Charge les plans de paiement en plusieurs fois depuis l'onglet `Échéances`
 * (colonnes : Nom, Catégorie, Montant par échéance, Nombre de fois,
 * Jour du mois, Date 1ère échéance, Actif). Cache 10 min.
 * Renvoie [] si l'onglet n'existe pas encore.
 */
export async function loadEcheances(force = false) {
  if (!force && _echeancesCache && Date.now() - _echeancesCache.fetchedAt < CACHE_TTL_MS) {
    return _echeancesCache.plans;
  }
  const sheets = getSheetsClient();
  let rows = [];
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `'${ECHEANCES_SHEET}'!A2:G`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    rows = data.values || [];
  } catch (err) {
    if (!String(err.message).includes(ECHEANCES_SHEET)) throw err;
    // Onglet pas encore créé
  }

  const plans = rows
    .map((r) => ({
      nom: (r[0] || '').toString().trim(),
      categorie: r[1] || '',
      montantEcheance: Number(r[2]) || 0,
      nombreFois: Number(r[3]) || 0,
      jourDuMois: Number(r[4]) || null,
      dateDebut: parseFlexibleDate(r[5]),
      actif: String(r[6] || '').trim().toLowerCase() === 'oui',
    }))
    .filter((p) => p.nom && p.montantEcheance > 0 && p.nombreFois > 0 && p.dateDebut);
  _echeancesCache = { fetchedAt: Date.now(), plans };
  return plans;
}

/**
 * Parse une date de cellule Sheets qui peut être un serial number
 * (cellule au format Date) ou une chaîne "YYYY-MM-DD" (saisie en texte).
 */
function parseFlexibleDate(v) {
  if (typeof v === 'number') return serialToDate(v);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) {
    return new Date(v.trim() + 'T00:00:00Z');
  }
  return null;
}

// ─── Produits (suivi des quantités) ───────────────────────────
const PRODUITS_SHEET = 'Produits';

const PRODUITS_HEADER = ['Date', 'Catégorie', 'Enseigne', 'Produit', 'Quantité'];

/**
 * Crée l'onglet `Produits` avec son en-tête s'il n'existe pas encore.
 */
async function ensureProduitsSheet() {
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  let sheetId = ids[PRODUITS_SHEET];

  if (sheetId === undefined) {
    const { data } = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: [{ addSheet: { properties: { title: PRODUITS_SHEET } } }],
      },
    });
    sheetId = data.replies[0].addSheet.properties.sheetId;
    await sheets.spreadsheets.values.update({
      spreadsheetId: spreadsheetId(),
      range: `'${PRODUITS_SHEET}'!A1:E1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [PRODUITS_HEADER] },
    });
    // Colonne A (Date) affichée en date, pas en numéro de série brut
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheetId(),
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
              fields: 'userEnteredFormat.numberFormat',
            },
          },
        ],
      },
    });
    _sheetIdsCache = null;
  }
}

/**
 * Produits « bébé » suivis mois après mois. Quelle que soit la marque lue sur
 * le ticket (Guigoz, Gallia…), on enregistre un libellé unique et la catégorie
 * Jumeaux, pour que /quantites agrège toutes les boîtes sous une seule ligne.
 * Ajouter un produit = ajouter une entrée ici.
 */
const PRODUITS_SUIVIS = [
  {
    libelle: 'Lait',
    categorie: 'Jumeaux',
    motifs: [
      /\blait\b/, /guigoz/, /gallia/, /nidal/, /novalac/, /bledi/, /modilac/,
      /physiolac/, /enfamil/, /biostime/, /premibio/, /\bage\b/,
    ],
  },
  {
    libelle: 'Couches',
    categorie: 'Jumeaux',
    motifs: [/couche/, /pampers/, /lotus baby/, /joone/, /love ?& ?green/],
  },
  {
    libelle: 'Sérum physiologique',
    categorie: 'Jumeaux',
    motifs: [/serum physio/, /physiodose/, /physiologica/, /dosette/],
  },
];

/** Libellés des produits suivis, pour les proposer à l'IA et à l'assistant. */
export function getProduitsSuivis() {
  return PRODUITS_SUIVIS.map((p) => p.libelle);
}

/** Minuscules sans accents, espaces conservés (pour tester les motifs ci-dessus). */
function normalizeProduitNom(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Remplace le nom brut lu sur le ticket par le libellé suivi correspondant
 * (et sa catégorie). Retourne le produit inchangé s'il n'est pas suivi.
 */
function normaliserProduit(nom, categorieParDefaut) {
  const n = normalizeProduitNom(nom);
  const suivi = PRODUITS_SUIVIS.find((p) => p.motifs.some((m) => m.test(n)));
  return suivi
    ? { nom: suivi.libelle, categorie: suivi.categorie }
    : { nom, categorie: categorieParDefaut };
}

/**
 * Journalise les produits détectés par l'IA sur une dépense (une ligne par
 * produit). Best-effort : à appeler après l'insertion de la dépense elle-même,
 * ne doit jamais bloquer le flow principal en cas d'échec.
 * @param {string} date  'YYYY-MM-DD'
 * @param {string} categorie
 * @param {string} enseigne
 * @param {{nom: string, quantite: number}[]} produits
 */
export async function appendProductDetails(date, categorie, enseigne, produits) {
  const [year, month, day] = date.split('-').map(Number);
  const dateFormula = `=DATE(${year};${month};${day})`;

  // Deux marques de lait sur le même ticket deviennent une seule ligne « Lait »,
  // pour que le compteur d'achats de /quantites reste par ticket.
  const cumul = new Map();
  for (const p of produits || []) {
    if (!p?.nom || !(Number(p.quantite) > 0)) continue;
    const { nom, categorie: cat } = normaliserProduit(p.nom, categorie);
    const cle = `${cat}|${nom.toLowerCase()}`;
    const dejaVu = cumul.get(cle);
    if (dejaVu) dejaVu.quantite += Number(p.quantite);
    else cumul.set(cle, { nom, categorie: cat, quantite: Number(p.quantite) });
  }

  const rows = [...cumul.values()].map((p) => [
    dateFormula,
    p.categorie,
    enseigne,
    p.nom,
    p.quantite,
  ]);
  if (rows.length === 0) return;

  await ensureProduitsSheet();
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${PRODUITS_SHEET}'!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * Agrège les quantités de produits pour un mois donné (défaut : mois courant).
 * @param {string} [monthArg]  'YYYY-MM'
 * @returns {Promise<{nom: string, quantite: number, achats: number, dates: Date[]}[]>}
 */
export async function listProductDetails(monthArg) {
  const sheets = getSheetsClient();
  let values = [];
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `'${PRODUITS_SHEET}'!A2:E`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    values = data.values || [];
  } catch (err) {
    if (!String(err.message).includes(PRODUITS_SHEET)) throw err;
    // Onglet pas encore créé → aucun produit détecté jusqu'ici
  }

  const now = new Date();
  let year = now.getUTCFullYear();
  let month0 = now.getUTCMonth();
  if (monthArg && /^\d{4}-\d{2}$/.test(monthArg)) {
    const [y, m] = monthArg.split('-').map(Number);
    year = y;
    month0 = m - 1;
  }
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 1));

  // 1er passage : ne garder que les lignes du mois, et compter combien de
  // produits distincts composent chaque ticket (date + enseigne).
  const duMois = [];
  const produitsParTicket = {};
  for (const r of values) {
    const date = serialToDate(r[0]);
    if (!date || date < start || date >= end) continue;
    const nom = (r[3] || '').toString().trim();
    const qte = Number(r[4]) || 0;
    if (!nom || qte <= 0) continue;
    const enseigne = (r[2] || '').toString().trim();
    const ticket = `${date.toISOString().slice(0, 10)}|${enseigne.toLowerCase()}`;
    produitsParTicket[ticket] = (produitsParTicket[ticket] || 0) + 1;
    duMois.push({ date, enseigne, nom, qte, ticket });
  }

  // 2e passage : agrégation par produit, en conservant les tickets d'origine
  // (le montant vit dans l'onglet Dépenses, pas ici — cf. buildQuantitesReport).
  const byProduit = {};
  for (const l of duMois) {
    const key = l.nom.toLowerCase();
    if (!byProduit[key]) byProduit[key] = { nom: l.nom, quantite: 0, achats: 0, tickets: [] };
    byProduit[key].quantite += l.qte;
    byProduit[key].achats += 1;
    byProduit[key].tickets.push({
      date: l.date,
      enseigne: l.enseigne,
      seulProduitDuTicket: produitsParTicket[l.ticket] === 1,
    });
  }
  return Object.values(byProduit).sort((a, b) => b.quantite - a.quantite);
}

// ─── Notes (retours sur le bot) ───────────────────────────────
const NOTES_SHEET = 'Notes';
const NOTES_HEADER = ['ID', 'Date', 'Statut', 'Note'];

/**
 * Crée l'onglet `Notes` avec son en-tête s'il n'existe pas encore.
 */
async function ensureNotesSheet() {
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  if (ids[NOTES_SHEET] !== undefined) return;

  const { data } = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests: [{ addSheet: { properties: { title: NOTES_SHEET } } }] },
  });
  const sheetId = data.replies[0].addSheet.properties.sheetId;
  await sheets.spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range: `'${NOTES_SHEET}'!A1:D1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [NOTES_HEADER] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
            cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'dd/mm/yyyy' } } },
            fields: 'userEnteredFormat.numberFormat',
          },
        },
      ],
    },
  });
  _sheetIdsCache = null;
}

/**
 * Liste les notes actives, de la plus récente à la plus ancienne.
 * @returns {Promise<{rowIndex:number, id:string, date:Date|null, statut:string, note:string}[]>}
 */
export async function listNotes() {
  const sheets = getSheetsClient();
  let values = [];
  try {
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId(),
      range: `'${NOTES_SHEET}'!A2:D`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    values = data.values || [];
  } catch (err) {
    if (!String(err.message).includes(NOTES_SHEET)) throw err;
    // Onglet pas encore créé → aucune note
  }
  return values
    .map((r, i) => ({
      rowIndex: i + 2,
      id: (r[0] || '').toString().trim(),
      date: serialToDate(r[1]),
      statut: (r[2] || 'nouvelle').toString().trim(),
      note: (r[3] || '').toString().trim(),
    }))
    .filter((n) => n.id && n.note)
    .sort((a, b) => b.rowIndex - a.rowIndex);
}

/**
 * Retrouve une note par son ID. Le rowIndex est résolu à chaque appel :
 * il bouge dès qu'une note est supprimée, donc on ne le met jamais en cache.
 */
async function findNoteById(id) {
  const cible = String(id).toLowerCase();
  const notes = await listNotes();
  return notes.find((n) => n.id.toLowerCase() === cible) || null;
}

/**
 * Enregistre une nouvelle note. L'ID suit le max existant : un ID supprimé
 * n'est jamais réattribué, pour qu'une référence reste sans ambiguïté.
 * @param {string} texte
 */
export async function appendNote(texte) {
  await ensureNotesSheet();
  const notes = await listNotes();
  const maxNum = notes.reduce((max, n) => {
    const m = n.id.match(/^N(\d+)$/i);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  const id = `N${String(maxNum + 1).padStart(3, '0')}`;

  const now = new Date();
  const dateFormula = `=DATE(${now.getFullYear()};${now.getMonth() + 1};${now.getDate()})`;

  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range: `'${NOTES_SHEET}'!A:D`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[id, dateFormula, 'nouvelle', texte]] },
  });
  return { id, note: texte, statut: 'nouvelle' };
}

/**
 * Met à jour le texte et/ou le statut d'une note.
 * @param {string} id
 * @param {{note?: string, statut?: string}} patch
 */
export async function updateNoteById(id, patch) {
  const note = await findNoteById(id);
  if (!note) throw new Error(`Note ${id} introuvable.`);

  const sheets = getSheetsClient();
  const data = [];
  if (patch.statut !== undefined) {
    data.push({ range: `'${NOTES_SHEET}'!C${note.rowIndex}`, values: [[patch.statut]] });
  }
  if (patch.note !== undefined) {
    data.push({ range: `'${NOTES_SHEET}'!D${note.rowIndex}`, values: [[patch.note]] });
  }
  if (data.length === 0) return note;

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  return { ...note, ...patch };
}

/**
 * Supprime définitivement une note (elle a été traitée).
 * @param {string} id
 */
export async function deleteNoteById(id) {
  const note = await findNoteById(id);
  if (!note) throw new Error(`Note ${id} introuvable.`);

  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  const sheetId = ids[NOTES_SHEET];
  if (sheetId === undefined) throw new Error(`Onglet ${NOTES_SHEET} introuvable.`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: note.rowIndex - 1, endIndex: note.rowIndex },
          },
        },
      ],
    },
  });
  return note;
}
