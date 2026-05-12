/**
 * src/db.js — Backend Supabase pour ExpenseBot V2 (phase 1).
 *
 * Mirror de l'API de src/sheets.js, mais alimentée par Postgres.
 * Différences clés :
 *   - Les `Expense` ont `id` (uuid) au lieu de `rowIndex` (int)
 *   - `loadReferences()` ne renvoie plus `catToCol` (sans objet sur Supabase)
 *   - Les suppressions catégorie/enseigne sont des soft-deletes (archived_at)
 *
 * `loadGlobalView()` reste dans src/sheets.js (lecture transitoire de
 * l'onglet "Vue globale" jusqu'à la phase 6).
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const REFS_CACHE_TTL_MS = 5 * 60 * 1000;
const EXPENSES_CACHE_TTL_MS = 60 * 1000;

let _client = null;
let _refsCache = null;
let _expensesCache = null;

function getClient() {
  if (_client) return _client;
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl || !key) {
    throw new Error('SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env');
  }
  // Normalisation défensive : retire un éventuel /rest/v1[/] et le slash final
  let url = rawUrl.trim().replace(/\/rest\/v1\/?$/i, '');
  while (url.endsWith('/')) url = url.slice(0, -1);

  _client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: ws },
  });
  return _client;
}

/**
 * Normalisation client-side identique au trigger SQL public.normalize_enseigne_name :
 * lower + unaccent + trim.
 */
function normalize(s) {
  if (!s) return '';
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Convertit une date Supabase (string 'YYYY-MM-DD' ou Date) en objet Date UTC.
 */
function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  // 'YYYY-MM-DD' → ancrage UTC pour rester cohérent avec sheets.js
  return new Date(d + 'T00:00:00Z');
}

// ─── Cache management ───────────────────────────────────────

function invalidateRefs() {
  _refsCache = null;
}
function invalidateExpenses() {
  _expensesCache = null;
}

// ─── Références : catégories + enseignes ────────────────────

/**
 * Charge les références (catégories actives + enseignes actives groupées par catégorie).
 * Cache 5 min.
 * @returns {{ fetchedAt: number, categories: string[], enseignes: Record<string, string[]> }}
 */
export async function loadReferences(force = false) {
  if (!force && _refsCache && Date.now() - _refsCache.fetchedAt < REFS_CACHE_TTL_MS) {
    return _refsCache;
  }
  const client = getClient();

  const { data: cats, error: e1 } = await client
    .from('categories')
    .select('id, name, position')
    .is('archived_at', null)
    .order('position', { ascending: true })
    .order('name', { ascending: true });
  if (e1) throw new Error(`loadReferences/categories : ${e1.message}`);

  const { data: ens, error: e2 } = await client
    .from('enseignes')
    .select('id, name, category_id')
    .is('archived_at', null)
    .order('name', { ascending: true });
  if (e2) throw new Error(`loadReferences/enseignes : ${e2.message}`);

  const catById = new Map(cats.map((c) => [c.id, c.name]));
  const enseignes = {};
  for (const c of cats) enseignes[c.name] = [];
  for (const e of ens) {
    const catName = catById.get(e.category_id);
    if (catName) enseignes[catName].push(e.name);
  }

  _refsCache = {
    fetchedAt: Date.now(),
    categories: cats.map((c) => c.name),
    enseignes,
    // Helpers internes pour les autres fonctions (lookup id par nom)
    _catIdByName: new Map(cats.map((c) => [c.name, c.id])),
    _ensIdByCatAndNorm: new Map(
      ens.map((e) => [`${e.category_id}::${normalize(e.name)}`, e.id])
    ),
  };
  return _refsCache;
}

// ─── Mapping de ligne SQL vers objet Expense (compat sheets.js) ─

function rowToExpense(r) {
  return {
    id: r.id,
    categorie: r.categorie_name || '',
    date: toDate(r.date),
    enseigne: r.enseigne_name || r.enseigne_label || '',
    designation: r.designation || '',
    montant: Number(r.amount) || 0,
  };
}

const EXPENSE_SELECT =
  'id, date, amount, designation, enseigne_label, transaction_type, source,' +
  ' categories!inner(name), enseignes(name)';

function shapeRow(raw) {
  return {
    id: raw.id,
    date: raw.date,
    amount: raw.amount,
    designation: raw.designation,
    enseigne_label: raw.enseigne_label,
    categorie_name: raw.categories?.name,
    enseigne_name: raw.enseignes?.name,
  };
}

// ─── Lecture transactions ───────────────────────────────────

/**
 * Liste toutes les transactions (type=expense) ordonnées par date desc.
 * Cache 60 s.
 * @returns {Promise<Array<{id, categorie, date: Date, enseigne, designation, montant}>>}
 */
export async function listExpenses(force = false) {
  if (
    !force &&
    _expensesCache &&
    Date.now() - _expensesCache.fetchedAt < EXPENSES_CACHE_TTL_MS
  ) {
    return _expensesCache.expenses;
  }
  const client = getClient();
  const { data, error } = await client
    .from('transactions')
    .select(EXPENSE_SELECT)
    .eq('transaction_type', 'expense')
    .order('date', { ascending: false });
  if (error) throw new Error(`listExpenses : ${error.message}`);

  const expenses = (data || []).map((raw) => rowToExpense(shapeRow(raw)));
  _expensesCache = { fetchedAt: Date.now(), expenses };
  return expenses;
}

// ─── Écriture transactions ──────────────────────────────────

/**
 * Construit un payload d'INSERT/UPDATE pour transactions à partir des données
 * "métier" (categorie, enseigne, etc.). Lance si la catégorie est inconnue.
 */
async function buildTransactionPayload(d, source = 'manual') {
  const refs = await loadReferences();
  const categoryId = refs._catIdByName.get(d.categorie);
  if (!categoryId) throw new Error(`Catégorie inconnue : ${d.categorie}`);

  const enseigneId = d.enseigne
    ? refs._ensIdByCatAndNorm.get(`${categoryId}::${normalize(d.enseigne)}`) || null
    : null;

  return {
    date: d.date, // format ISO 'YYYY-MM-DD' attendu (cohérent avec sheets.js)
    amount: Number(d.montant),
    category_id: categoryId,
    enseigne_id: enseigneId,
    enseigne_label: d.enseigne || null,
    designation: d.designation || null,
    transaction_type: 'expense',
    source,
  };
}

/**
 * Insère une nouvelle transaction. Retourne la ligne au format Expense.
 */
export async function appendExpense(d) {
  const payload = await buildTransactionPayload(d, 'manual');
  const client = getClient();
  const { data, error } = await client
    .from('transactions')
    .insert(payload)
    .select(EXPENSE_SELECT)
    .single();
  if (error) throw new Error(`appendExpense : ${error.message}`);
  invalidateExpenses();
  return rowToExpense(shapeRow(data));
}

/**
 * Met à jour une transaction existante (par id UUID).
 */
export async function updateExpense(id, d) {
  if (!id) throw new Error('updateExpense : id requis');
  const payload = await buildTransactionPayload(d, 'manual');
  // Source d'origine et sheet_row_index ne sont pas écrasés
  delete payload.source;
  delete payload.transaction_type;

  const client = getClient();
  const { data, error } = await client
    .from('transactions')
    .update(payload)
    .eq('id', id)
    .select(EXPENSE_SELECT)
    .single();
  if (error) throw new Error(`updateExpense : ${error.message}`);
  invalidateExpenses();
  return rowToExpense(shapeRow(data));
}

/**
 * Suppression physique d'une transaction par id UUID.
 */
export async function deleteExpense(id) {
  return deleteExpenses([id]);
}

/**
 * Suppression physique de plusieurs transactions par ids UUID.
 */
export async function deleteExpenses(ids) {
  if (!ids?.length) return;
  const uniq = [...new Set(ids)];
  const client = getClient();
  const { error } = await client.from('transactions').delete().in('id', uniq);
  if (error) throw new Error(`deleteExpenses : ${error.message}`);
  invalidateExpenses();
}

// ─── Détection doublons ─────────────────────────────────────

/**
 * Cherche une transaction susceptible d'être un doublon.
 * Critères : même montant (±0.01€), enseigne (insensible casse/accents),
 * date dans une fenêtre de ±toleranceDays jours.
 * @param {{date: string, montant: number, enseigne: string}} candidate
 * @param {number} toleranceDays
 * @returns {Promise<Expense|null>}
 */
export async function findDuplicate(candidate, toleranceDays = 2) {
  if (!candidate.date || !candidate.montant || !candidate.enseigne) return null;

  const client = getClient();
  const target = new Date(candidate.date + 'T00:00:00Z');
  const startDate = new Date(target.getTime() - toleranceDays * 86400 * 1000);
  const endDate = new Date(target.getTime() + toleranceDays * 86400 * 1000);
  const isoStart = startDate.toISOString().slice(0, 10);
  const isoEnd = endDate.toISOString().slice(0, 10);
  const amount = Number(candidate.montant);
  const tol = 0.01;
  const enseigneNorm = normalize(candidate.enseigne);

  // Pré-filtre côté DB : montant ±0.01 et date dans la fenêtre.
  // Comparaison enseigne normalisée côté JS (évite RPC custom).
  const { data, error } = await client
    .from('transactions')
    .select(EXPENSE_SELECT)
    .eq('transaction_type', 'expense')
    .gte('date', isoStart)
    .lte('date', isoEnd)
    .gte('amount', amount - tol)
    .lte('amount', amount + tol)
    .limit(50);
  if (error) throw new Error(`findDuplicate : ${error.message}`);

  for (const raw of data || []) {
    const shaped = shapeRow(raw);
    const ens =
      normalize(shaped.enseigne_label) || normalize(shaped.enseigne_name) || '';
    if (ens === enseigneNorm) return rowToExpense(shaped);
  }
  return null;
}

/**
 * Groupes de doublons potentiels — comportement identique à sheets.js.
 * @param {object} opts
 * @param {number} [opts.toleranceDays=0]
 * @param {boolean} [opts.strict=false]
 */
export async function findDuplicateGroups({
  toleranceDays = 0,
  strict = false,
} = {}) {
  const all = await listExpenses(true);
  const items = all.filter((e) => e.date && e.enseigne && e.montant);
  items.sort((a, b) => a.date.getTime() - b.date.getTime());

  const tolMs = toleranceDays * 86400 * 1000;
  const visited = new Set();
  const groups = [];

  for (let i = 0; i < items.length; i++) {
    if (visited.has(i)) continue;
    const seed = items[i];
    const seedEnsNorm = normalize(seed.enseigne);
    const seedDate = seed.date.getTime();
    const seedAmt = seed.montant;
    const seedCat = normalize(seed.categorie);
    const seedDesig = normalize(seed.designation);

    const group = [seed];
    visited.add(i);

    for (let j = i + 1; j < items.length; j++) {
      if (visited.has(j)) continue;
      const e = items[j];
      if (e.date.getTime() - seedDate > tolMs) break;
      if (Math.abs(e.montant - seedAmt) > 0.01) continue;
      if (normalize(e.enseigne) !== seedEnsNorm) continue;
      if (Math.abs(e.date.getTime() - seedDate) > tolMs) continue;
      if (strict) {
        if (normalize(e.categorie) !== seedCat) continue;
        if (normalize(e.designation) !== seedDesig) continue;
      }
      group.push(e);
      visited.add(j);
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}

// ─── CRUD enseignes ─────────────────────────────────────────

export async function addEnseigne(categorie, enseigne) {
  if (!enseigne || !enseigne.trim()) {
    throw new Error('Nom d\'enseigne vide.');
  }
  const refs = await loadReferences(true);
  const categoryId = refs._catIdByName.get(categorie);
  if (!categoryId) throw new Error(`Catégorie inconnue : ${categorie}`);

  const norm = normalize(enseigne);
  if (refs._ensIdByCatAndNorm.has(`${categoryId}::${norm}`)) {
    throw new Error(`L'enseigne « ${enseigne} » existe déjà dans ${categorie}.`);
  }

  const client = getClient();
  const { error } = await client
    .from('enseignes')
    .insert({ category_id: categoryId, name: enseigne.trim() });
  if (error) throw new Error(`addEnseigne : ${error.message}`);
  invalidateRefs();
}

export async function delEnseigne(categorie, enseigne) {
  const refs = await loadReferences(true);
  const categoryId = refs._catIdByName.get(categorie);
  if (!categoryId) throw new Error(`Catégorie inconnue : ${categorie}`);

  const norm = normalize(enseigne);
  const ensId = refs._ensIdByCatAndNorm.get(`${categoryId}::${norm}`);
  if (!ensId) {
    throw new Error(`Enseigne « ${enseigne} » introuvable pour ${categorie}.`);
  }

  const client = getClient();
  const { error } = await client
    .from('enseignes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', ensId);
  if (error) throw new Error(`delEnseigne : ${error.message}`);
  invalidateRefs();
}

export async function renameEnseigne(categorie, oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Nouveau nom vide.');

  const refs = await loadReferences(true);
  const categoryId = refs._catIdByName.get(categorie);
  if (!categoryId) throw new Error(`Catégorie inconnue : ${categorie}`);

  const oldNorm = normalize(oldName);
  const newNorm = normalize(trimmed);
  const ensId = refs._ensIdByCatAndNorm.get(`${categoryId}::${oldNorm}`);
  if (!ensId) {
    throw new Error(`Enseigne « ${oldName} » introuvable pour ${categorie}.`);
  }
  // Conflit avec une autre enseigne active
  const conflictId = refs._ensIdByCatAndNorm.get(`${categoryId}::${newNorm}`);
  if (conflictId && conflictId !== ensId) {
    throw new Error(`L'enseigne « ${trimmed} » existe déjà dans ${categorie}.`);
  }

  const client = getClient();
  const { error } = await client
    .from('enseignes')
    .update({ name: trimmed }) // trigger SQL met à jour name_normalized
    .eq('id', ensId);
  if (error) throw new Error(`renameEnseigne : ${error.message}`);
  invalidateRefs();
}

// ─── CRUD catégories ────────────────────────────────────────

export async function addCategorie(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Nom de catégorie vide.');

  const refs = await loadReferences(true);
  if (refs.categories.some((c) => c.toLowerCase() === trimmed.toLowerCase())) {
    throw new Error(`La catégorie « ${trimmed} » existe déjà.`);
  }

  const client = getClient();
  // position = max(existing) + 1 pour conserver l'ordre d'ajout
  const nextPosition = refs.categories.length;
  const { error } = await client
    .from('categories')
    .insert({ name: trimmed, position: nextPosition });
  if (error) throw new Error(`addCategorie : ${error.message}`);
  invalidateRefs();
  return { name: trimmed };
}

export async function delCategorie(name) {
  const refs = await loadReferences(true);
  const categoryId = refs._catIdByName.get(name);
  if (!categoryId) throw new Error(`Catégorie introuvable : ${name}`);

  const client = getClient();
  const { error } = await client
    .from('categories')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', categoryId);
  if (error) throw new Error(`delCategorie : ${error.message}`);
  invalidateRefs();
  return {};
}

export async function renameCategorie(oldName, newName) {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Nouveau nom vide.');

  const refs = await loadReferences(true);
  const categoryId = refs._catIdByName.get(oldName);
  if (!categoryId) throw new Error(`Catégorie introuvable : ${oldName}`);

  if (
    refs.categories.some(
      (c) => c.toLowerCase() === trimmed.toLowerCase() && c !== oldName
    )
  ) {
    throw new Error(`La catégorie « ${trimmed} » existe déjà.`);
  }

  const client = getClient();
  const { error } = await client
    .from('categories')
    .update({ name: trimmed })
    .eq('id', categoryId);
  if (error) throw new Error(`renameCategorie : ${error.message}`);
  invalidateRefs();
  return {};
}
