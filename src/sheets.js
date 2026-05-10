import { google } from 'googleapis';

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
  _expensesCache = null;
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
  _refsCache = null;
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
  _expensesCache = null;
  return row;
}

/**
 * Supprime physiquement une ligne de l'onglet Dépenses (par rowIndex 1-based).
 */
export async function deleteExpense(rowIndex) {
  return deleteExpenses([rowIndex]);
}

/**
 * Supprime plusieurs lignes en un seul batchUpdate.
 * Trie en ordre décroissant pour que les suppressions ne décalent pas les indices.
 * @param {number[]} rowIndices  rowIndex 1-based
 */
export async function deleteExpenses(rowIndices) {
  if (!rowIndices?.length) return;
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  const sheetId = ids[DEPENSES_SHEET];
  if (sheetId === undefined) throw new Error(`Onglet ${DEPENSES_SHEET} introuvable.`);

  const sorted = [...new Set(rowIndices)].sort((a, b) => b - a);
  const requests = sorted.map((rowIndex) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS',
        startIndex: rowIndex - 1,
        endIndex: rowIndex,
      },
    },
  }));
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: { requests },
  });
  _expensesCache = null;
}

/**
 * Recherche les groupes de doublons potentiels dans toute la Sheet.
 *
 * @param {object} opts
 * @param {number} [opts.toleranceDays=0]  écart de date toléré pour grouper
 * @param {boolean} [opts.strict=false]    si true : exige aussi catégorie + désignation identiques
 * @returns {Promise<Array<Array<Expense>>>}  liste de groupes (taille >= 2)
 */
export async function findDuplicateGroups({ toleranceDays = 0, strict = false } = {}) {
  const all = await listExpenses(true);
  const items = all.filter((e) => e.date && e.enseigne && e.montant);
  // Tri stable par date asc → l'élément "gardé" sera le plus ancien (rowIndex le plus bas en cas d'égalité)
  items.sort((a, b) => a.date.getTime() - b.date.getTime() || a.rowIndex - b.rowIndex);

  const tolMs = toleranceDays * 86400 * 1000;
  const visited = new Set();
  const groups = [];

  for (let i = 0; i < items.length; i++) {
    if (visited.has(i)) continue;
    const seed = items[i];
    const seedEns = seed.enseigne.toLowerCase().trim();
    const seedDate = seed.date.getTime();
    const seedAmt = seed.montant;
    const seedCat = (seed.categorie || '').toLowerCase().trim();
    const seedDesig = (seed.designation || '').toLowerCase().trim();

    const group = [seed];
    visited.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (visited.has(j)) continue;
      const e = items[j];
      // Optim : items triés par date — si on dépasse la fenêtre, on peut break
      if (e.date.getTime() - seedDate > tolMs) break;
      if (Math.abs(e.montant - seedAmt) > 0.01) continue;
      if ((e.enseigne || '').toLowerCase().trim() !== seedEns) continue;
      if (Math.abs(e.date.getTime() - seedDate) > tolMs) continue;
      if (strict) {
        if ((e.categorie || '').toLowerCase().trim() !== seedCat) continue;
        if ((e.designation || '').toLowerCase().trim() !== seedDesig) continue;
      }
      group.push(e);
      visited.add(j);
    }

    if (group.length > 1) groups.push(group);
  }
  return groups;
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
  _refsCache = null;
}

/**
 * Met à jour la validation de données de la colonne A (Catégorie) dans l'onglet Dépenses.
 * Appelé automatiquement après ajout/suppression/renommage d'une catégorie.
 * @param {string[]} categories
 */
async function updateCategoryValidation(categories) {
  if (!categories || categories.length === 0) return;
  const sheets = getSheetsClient();
  const ids = await getSheetIds();
  const sheetId = ids[DEPENSES_SHEET];
  if (sheetId === undefined) {
    console.warn('[updateCategoryValidation] Onglet Dépenses introuvable — validation ignorée.');
    return;
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: spreadsheetId(),
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,    // ligne 2 (0-indexed)
              endRowIndex: 1000,
              startColumnIndex: 0, // col A
              endColumnIndex: 1,
            },
            rule: {
              condition: {
                type: 'ONE_OF_LIST',
                values: categories.map((v) => ({ userEnteredValue: v })),
              },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ],
    },
  });
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
  _refsCache = null;

  // P6 — auto-création de la plage nommée pour la validation INDIRECT
  let namedRangeOk = true;
  try {
    await upsertNamedRangeForCategory(trimmed, col);
  } catch (err) {
    console.error('[upsertNamedRangeForCategory]', err);
    namedRangeOk = false;
  }

  // Auto-mise à jour de la validation col A (liste catégories)
  let validationOk = true;
  try {
    const updatedCategories = [...refs.categories, trimmed];
    await updateCategoryValidation(updatedCategories);
  } catch (err) {
    console.error('[updateCategoryValidation/add]', err);
    validationOk = false;
  }
  return { col, name: trimmed, namedRangeOk, validationOk };
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
  _refsCache = null;

  // P6 — supprime la plage nommée associée
  let namedRangeOk = true;
  try {
    await deleteNamedRangeForCategory(name);
  } catch (err) {
    console.error('[deleteNamedRangeForCategory]', err);
    namedRangeOk = false;
  }

  // Auto-mise à jour de la validation col A
  let validationOk = true;
  try {
    const updatedCategories = refs.categories.filter((c) => c !== name);
    await updateCategoryValidation(updatedCategories);
  } catch (err) {
    console.error('[updateCategoryValidation/del]', err);
    validationOk = false;
  }
  return { namedRangeOk, validationOk };
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
  _refsCache = null;

  // P6 — renomme la plage nommée associée
  let namedRangeOk = true;
  try {
    await renameNamedRangeForCategory(oldName, trimmed);
  } catch (err) {
    console.error('[renameNamedRangeForCategory]', err);
    namedRangeOk = false;
  }

  // Auto-mise à jour de la validation col A
  let validationOk = true;
  try {
    const updatedCategories = refs.categories.map((c) => (c === oldName ? trimmed : c));
    await updateCategoryValidation(updatedCategories);
  } catch (err) {
    console.error('[updateCategoryValidation/rename]', err);
    validationOk = false;
  }
  return { namedRangeOk, validationOk };
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
