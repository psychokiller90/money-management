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
  return { col, name: trimmed };
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
