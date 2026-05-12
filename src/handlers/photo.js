import { Markup } from 'telegraf';
import { analyzeInvoice, analyzeInvoicePdf } from '../mistral.js';
import {
  appendExpense,
  updateExpense,
  loadReferences,
  addEnseigne,
  addCategorie,
  findDuplicate,
  listExpenses,
} from '../sheets.js';
import { tryHandleAdminText } from './admin.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map();   // key → { userId, data, awaitingTextFor, updatedAt, fromEdit }
const userActive = new Map(); // userId → key

let _keyCounter = 0;
function newKey() {
  _keyCounter = (_keyCounter + 1) % 1000;
  return (Date.now().toString(36) + _keyCounter.toString(36)).slice(-8);
}

function setSession(key, session) {
  session.updatedAt = Date.now();
  sessions.set(key, session);
  userActive.set(session.userId, key);
}

function getActiveSession(userId) {
  const key = userActive.get(userId);
  if (!key) return null;
  const s = sessions.get(key);
  if (!s) {
    userActive.delete(userId);
    return null;
  }
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(key);
    userActive.delete(userId);
    return null;
  }
  return { key, session: s };
}

function clearSession(key) {
  const s = sessions.get(key);
  if (s) userActive.delete(s.userId);
  sessions.delete(key);
}

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

function formatRecap(data) {
  return [
    '📋 <b>Dépense</b>\n',
    `🏷️ Catégorie : ${data.categorie ?? '—'}`,
    `📅 Date      : ${fmtDate(data.date)}`,
    `🏪 Enseigne  : ${data.enseigne ?? '—'}`,
    `📝 Détail    : ${data.designation || '(aucun)'}`,
    `💶 Montant   : ${data.montant ?? '—'} €`,
  ].join('\n');
}

// ─── Handler photo ────────────────────────────────────────────
const _seenMediaGroups = new Set();

export async function handlePhoto(ctx) {
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return ctx.reply('⛔ Accès non autorisé.');

  const mediaGroupId = ctx.message.media_group_id;
  if (mediaGroupId && !_seenMediaGroups.has(mediaGroupId)) {
    _seenMediaGroups.add(mediaGroupId);
    setTimeout(() => _seenMediaGroups.delete(mediaGroupId), 60_000);
    await ctx.reply('📦 Album détecté — chaque photo sera traitée individuellement.');
  }

  const processing = await ctx.reply('⏳ Analyse en cours...');

  try {
    const photos = ctx.message.photo;
    const best = photos[photos.length - 1];
    const file = await ctx.telegram.getFile(best.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const refs = await loadReferences();
    const data = await analyzeInvoice(base64, refs);

    const key = newKey();
    setSession(key, { userId, data, awaitingTextFor: null });

    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});
    await advance(ctx, key);
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});
    console.error('[handlePhoto]', err);
    await ctx.reply(`❌ Erreur analyse : ${err.message}\n\nRéessaie avec une photo plus nette.`);
  }
}

// ─── Handler PDF (document) ───────────────────────────────────
export async function handleDocument(ctx) {
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return ctx.reply('⛔ Accès non autorisé.');

  const doc = ctx.message.document;
  if (!doc) return;
  const mime = doc.mime_type || '';
  const name = doc.file_name || '';

  if (!mime.includes('pdf') && !name.toLowerCase().endsWith('.pdf')) {
    return ctx.reply('📎 Format non supporté. Envoie une <b>photo</b> ou un <b>PDF</b> de facture.', {
      parse_mode: 'HTML',
    });
  }

  const processing = await ctx.reply('⏳ Analyse du PDF en cours...');

  try {
    const file = await ctx.telegram.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());

    const refs = await loadReferences();
    const result = await analyzeInvoicePdf(buffer, refs, name || 'facture.pdf');
    const transactions = result.transactions || [];

    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});

    if (transactions.length === 0) {
      return ctx.reply('ℹ️ Aucune transaction détectée dans ce document.');
    }

    if (transactions.length === 1) {
      // Facture simple → flow habituel
      const key = newKey();
      setSession(key, { userId, data: transactions[0], awaitingTextFor: null });
      return advance(ctx, key);
    }

    // Relevé multi-transactions → questions retraits/virements puis résumé
    return askSpecialTransactions(ctx, userId, transactions, refs);
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});
    console.error('[handleDocument]', err);
    await ctx.reply(`❌ Erreur analyse PDF : ${err.message}`);
  }
}

// ─── Questions pré-batch (retraits / virements) ───────────────

function sumType(transactions, type) {
  return transactions
    .filter((t) => t.transaction_type === type)
    .reduce((s, t) => s + Number(t.montant || 0), 0);
}

/**
 * Avant le résumé principal, demande si on inclut retraits et/ou virements.
 * Stocke tout dans la session et enchaîne les questions.
 */
async function askSpecialTransactions(ctx, userId, transactions, refs) {
  const retraits = transactions.filter((t) => t.transaction_type === 'retrait');
  const virements = transactions.filter((t) => t.transaction_type === 'virement');

  // Stocker l'état dans une session batch temporaire
  const batchKey = newKey();
  setSession(batchKey, {
    userId,
    data: null, // sera rempli après filtrage
    awaitingTextFor: null,
    _batchPending: transactions,  // toutes les transactions
    _batchRefs: refs,
    _includeRetraits: null,       // null = pas encore décidé
    _includeVirements: null,
  });

  if (retraits.length > 0) {
    return askIncludeType(ctx, batchKey, 'retrait', retraits.length, sumType(transactions, 'retrait'));
  }
  if (virements.length > 0) {
    return askIncludeType(ctx, batchKey, 'virement', virements.length, sumType(transactions, 'virement'));
  }
  // Pas de cas spéciaux → résumé direct
  return showBatchSummary(ctx, userId, transactions, refs);
}

async function askIncludeType(ctx, batchKey, type, count, total) {
  const label = type === 'retrait' ? 'retrait(s) d\'espèces' : 'virement(s)';
  const emoji = type === 'retrait' ? '💵' : '🔁';
  await ctx.reply(
    `${emoji} <b>${count} ${label} détecté(s)</b> — ${fmtAmountShort(total)}\n\nLes inclure dans l'insertion ?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Oui, inclure', `batchincl_${batchKey}_${type}_yes`),
          Markup.button.callback('❌ Non, ignorer', `batchincl_${batchKey}_${type}_no`),
        ],
      ]),
    }
  );
}

export async function handleBatchInclude(ctx) {
  const key = ctx.match[1];
  const type = ctx.match[2];       // 'retrait' ou 'virement'
  const choice = ctx.match[3];     // 'yes' ou 'no'
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  await ctx.answerCbQuery(choice === 'yes' ? 'Inclus ✅' : 'Ignorés ❌');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  if (type === 'retrait') s._includeRetraits = choice === 'yes';
  if (type === 'virement') s._includeVirements = choice === 'yes';
  setSession(key, s);

  const transactions = s._batchPending;
  const refs = s._batchRefs;

  // Question suivante si nécessaire
  if (type === 'retrait' && s._includeVirements === null) {
    const virements = transactions.filter((t) => t.transaction_type === 'virement');
    if (virements.length > 0) {
      return askIncludeType(ctx, key, 'virement', virements.length, sumType(transactions, 'virement'));
    }
    s._includeVirements = true; // pas de virements → sans objet
    setSession(key, s);
  }

  // Toutes les questions répondues → filtrer et afficher le résumé
  const filtered = transactions.filter((t) => {
    if (t.transaction_type === 'retrait') return s._includeRetraits !== false;
    if (t.transaction_type === 'virement') return s._includeVirements !== false;
    return true;
  });

  const excluded = transactions.length - filtered.length;
  if (excluded > 0) {
    await ctx.reply(`ℹ️ ${excluded} transaction(s) exclue(s).`);
  }

  if (filtered.length === 0) {
    clearSession(key);
    return ctx.reply('ℹ️ Aucune transaction à insérer après filtrage.');
  }
  if (filtered.length === 1) {
    s.data = filtered[0];
    s._batchPending = null;
    s._batchRefs = null;
    s.pendingQueue = [];
    s.batchTotal = 1;
    s.batchDone = 0;
    setSession(key, s);
    return advance(ctx, key);
  }

  // Passer au résumé batch — remplace la session en place
  clearSession(key);
  return showBatchSummary(ctx, s.userId, filtered, refs);
}

// ─── Résumé batch ─────────────────────────────────────────────
function fmtDateShort(isoDate) {
  if (!isoDate) return '—';
  const [, m, d] = isoDate.split('-');
  return `${d}/${m}`;
}

function fmtAmountShort(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
}

async function showBatchSummary(ctx, userId, transactions, refs) {
  const total = transactions.reduce((s, t) => s + Number(t.montant || 0), 0);
  const needsReview = transactions.filter(
    (t) =>
      !t.categorie ||
      t.categorie_confidence === 'low' ||
      !refs.categories.includes(t.categorie) ||
      t.enseigne_in_list === false
  ).length;

  const lines = [
    `📄 <b>${transactions.length} transactions détectées</b>`,
    `💶 Total : <b>${fmtAmountShort(total)}</b>`,
    needsReview > 0
      ? `⚠️ <b>${needsReview}</b> nécessitent une vérification (catégorie incertaine ou enseigne hors liste)`
      : '✅ Toutes les transactions sont identifiées',
    '',
    '<b>Aperçu :</b>',
  ];

  const shown = transactions.slice(0, 10);
  for (const t of shown) {
    const flag =
      !t.categorie || t.categorie_confidence === 'low' || t.enseigne_in_list === false
        ? ' ⚠️'
        : '';
    lines.push(
      `• ${fmtDateShort(t.date)} — ${t.enseigne || '?'} — ${fmtAmountShort(t.montant)}${flag}`
    );
  }
  if (transactions.length > 10) {
    lines.push(`<i>… et ${transactions.length - 10} autre(s)</i>`);
  }

  const batchKey = newKey();
  setSession(batchKey, {
    userId,
    data: transactions[0],
    awaitingTextFor: null,
    pendingQueue: transactions.slice(1),
    batchTotal: transactions.length,
    batchDone: 0,
  });

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Tout insérer', `batchall_${batchKey}`)],
      [Markup.button.callback('🔎 Un par un', `batchseq_${batchKey}`)],
      [Markup.button.callback('❌ Annuler', `cancel_${batchKey}`)],
    ]),
  });
}

// ─── Batch : tout insérer ─────────────────────────────────────
const FALLBACK_CATEGORY = 'Imprevus';

export async function handleBatchAll(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Insertion en cours...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  // Chargement initial — on construit une liste locale pour éviter N allers-retours API
  const existingExpenses = await listExpenses(true);
  const refs = await loadReferences();
  const fallbackCat = refs.categories.includes(FALLBACK_CATEGORY)
    ? FALLBACK_CATEGORY
    : refs.categories[0];

  const all = [s.data, ...(s.pendingQueue || [])];
  let ok = 0;
  let forcedFallback = 0;
  const skippedDups = [];
  const errors = [];

  // Snapshot local augmenté au fur et à mesure des insertions (évite N rechargements)
  const localExpenses = [...existingExpenses];

  function findDupLocal(candidate) {
    if (!candidate.date || !candidate.montant || !candidate.enseigne) return null;
    const target = new Date(candidate.date + 'T00:00:00Z').getTime();
    const tolMs = 2 * 86400 * 1000;
    const ensLow = candidate.enseigne.toLowerCase().trim();
    const amount = Number(candidate.montant);
    return localExpenses.find((e) => {
      if (Math.abs(e.montant - amount) > 0.01) return false;
      if ((e.enseigne || '').toLowerCase().trim() !== ensLow) return false;
      if (!e.date) return false;
      return Math.abs(e.date.getTime() - target) <= tolMs;
    }) || null;
  }

  for (const t of all) {
    try {
      if (!t.date || !t.montant || !t.enseigne) {
        errors.push(`${t.enseigne || '?'} — données incomplètes`);
        continue;
      }

      let categorie = t.categorie;
      const needsFallback =
        !categorie ||
        t.categorie_confidence === 'low' ||
        !refs.categories.includes(categorie) ||
        t.enseigne_in_list === false;
      if (needsFallback) {
        categorie = fallbackCat;
        forcedFallback++;
      }

      // Détection doublon sur snapshot local (pas d'appel API supplémentaire)
      const dup = findDupLocal({ date: t.date, montant: t.montant, enseigne: t.enseigne });
      if (dup) {
        skippedDups.push(
          `${t.enseigne} — ${fmtAmountShort(t.montant)} (${fmtDateShort(dup.date?.toISOString?.()?.slice(0,10) ?? '')})`
        );
        continue;
      }

      await appendExpense({
        categorie,
        date: t.date,
        enseigne: t.enseigne,
        designation: t.designation || '',
        montant: t.montant,
      });

      // Ajoute au snapshot local pour détecter les doublons intra-batch
      localExpenses.push({
        rowIndex: -1,
        categorie,
        date: new Date(t.date + 'T00:00:00Z'),
        enseigne: t.enseigne,
        designation: t.designation || '',
        montant: Number(t.montant),
      });
      ok++;
    } catch (err) {
      errors.push(`${t.enseigne || '?'} — ${err.message}`);
    }
  }
  clearSession(key);

  const lines = [`✅ <b>${ok}/${all.length} transactions insérées</b>`];
  if (forcedFallback > 0) {
    lines.push(`📂 <b>${forcedFallback}</b> classée(s) en <b>${fallbackCat}</b> (vérification suggérée)`);
  }
  if (skippedDups.length > 0) {
    lines.push('');
    lines.push(`🔁 <b>${skippedDups.length} doublon(s) ignoré(s) :</b>`);
    skippedDups.forEach((d) => lines.push(`• ${d}`));
  }
  if (errors.length > 0) {
    lines.push('');
    lines.push('⚠️ Erreurs :');
    errors.forEach((e) => lines.push(`• ${e}`));
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
}

// ─── Batch : un par un (démarre la séquence) ──────────────────
export async function handleBatchSeq(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  const total = s.batchTotal;
  await ctx.reply(
    `🔎 Révision une par une — <b>${total} transactions</b>\nChaque transaction sera présentée individuellement.`,
    { parse_mode: 'HTML' }
  );
  await ctx.reply(`<b>1/${total}</b>`, { parse_mode: 'HTML' });
  await advance(ctx, key);
}

// ─── Orchestration ────────────────────────────────────────────
async function advance(ctx, key) {
  const s = sessions.get(key);
  if (!s) return ctx.reply('Session expirée, renvoie la photo.');

  const refs = await loadReferences();
  const { data } = s;

  if (
    !data.categorie ||
    data.categorie_confidence === 'low' ||
    !refs.categories.includes(data.categorie)
  ) {
    return askCategory(ctx, key, refs);
  }

  const enseignes = refs.enseignes[data.categorie] || [];
  if (
    !data.enseigne ||
    data.enseigne_in_list === false ||
    !enseignes.includes(data.enseigne)
  ) {
    return askEnseigne(ctx, key, refs);
  }

  if (data.designation === null || data.designation === undefined) {
    return askDesignation(ctx, key);
  }

  // Détection de doublon (skippée si l'utilisateur a déjà forcé)
  if (!s.duplicateAcknowledged) {
    const dup = await findDuplicate({
      date: data.date,
      montant: data.montant,
      enseigne: data.enseigne,
    });
    if (dup) {
      return warnDuplicate(ctx, key, dup);
    }
  }

  return askConfirm(ctx, key);
}

async function warnDuplicate(ctx, key, dup) {
  const dateFr = dup.date
    ? `${String(dup.date.getUTCDate()).padStart(2, '0')}/${String(dup.date.getUTCMonth() + 1).padStart(2, '0')}/${dup.date.getUTCFullYear()}`
    : '—';
  const text =
    '⚠️ <b>Doublon potentiel détecté</b>\n\n' +
    'Une dépense très similaire existe déjà :\n' +
    `• ${dateFr} — ${dup.enseigne} — ${dup.montant} € (${dup.categorie})\n` +
    `${dup.designation ? `• Détail : ${dup.designation}\n` : ''}` +
    `\nLigne ${dup.rowIndex} dans ton Sheet.\n\nQue veux-tu faire ?`;

  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Insérer quand même', `force_${key}`)],
      [Markup.button.callback('❌ Annuler', `cancel_${key}`)],
    ]),
  });
}

function chunkRows(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

async function askCategory(ctx, key, refs) {
  const buttons = refs.categories.map((c) =>
    Markup.button.callback(c, `cat_${key}_${c}`)
  );
  const rows = chunkRows(buttons, 2);
  rows.push([
    Markup.button.callback('✨ Nouvelle', `catnew_${key}`),
    Markup.button.callback('❌ Annuler', `cancel_${key}`),
  ]);

  const s = sessions.get(key);
  const detected = s.data.categorie
    ? `\n\n🤖 IA proposait : <b>${s.data.categorie}</b> (confiance: ${s.data.categorie_confidence})`
    : '';
  await ctx.reply(`🏷️ <b>Choisis la catégorie :</b>${detected}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows),
  });
}

export async function handleCategoryNew(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.awaitingTextFor = 'new_categorie';
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('✏️ Saisis le nom de la nouvelle catégorie :');
}

async function askEnseigne(ctx, key, refs) {
  const s = sessions.get(key);
  const cat = s.data.categorie;
  const enseignes = refs.enseignes[cat] || [];

  const buttons = enseignes.map((e, i) =>
    Markup.button.callback(e, `ens_${key}_${i}`)
  );
  const rows = chunkRows(buttons, 2);
  rows.push([
    Markup.button.callback('✏️ Nouvelle', `ensnew_${key}`),
    Markup.button.callback('❌ Annuler', `cancel_${key}`),
  ]);

  const proposed = s.data.enseigne
    ? `\n\n🤖 IA proposait : <b>${s.data.enseigne}</b>${
        s.data.enseigne_in_list === false ? ' — hors liste' : ''
      }`
    : '';
  await ctx.reply(`🏪 <b>Choisis l'enseigne pour ${cat} :</b>${proposed}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows),
  });
}

async function askDesignation(ctx, key) {
  await ctx.reply('📝 <b>Désignation manquante.</b>\n\nVeux-tu en saisir une ?', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Aucune', `desigskip_${key}`)],
      [Markup.button.callback('✏️ Saisir', `desiginput_${key}`)],
      [Markup.button.callback('❌ Annuler', `cancel_${key}`)],
    ]),
  });
}

async function askConfirm(ctx, key) {
  const s = sessions.get(key);
  await ctx.reply(formatRecap(s.data) + "\n\nConfirmer l'insertion ?", {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Confirmer', `confirm_${key}`)],
      [Markup.button.callback('✏️ Modifier', `edit_${key}`)],
      [Markup.button.callback('❌ Annuler', `cancel_${key}`)],
    ]),
  });
}

// ─── Callbacks ────────────────────────────────────────────────
export async function handleCategory(ctx) {
  const key = ctx.match[1];
  const cat = ctx.match[2];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.data.categorie = cat;
  s.data.categorie_confidence = 'high';

  const refs = await loadReferences();
  const wasFromEdit = s.fromEdit;
  if (s.data.enseigne && !refs.enseignes[cat]?.includes(s.data.enseigne)) {
    s.data.enseigne_in_list = false;
  }
  setSession(key, s);
  await ctx.answerCbQuery(`✓ ${cat}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  // Si on vient de l'édition et que l'enseigne reste valide → retour direct au confirm
  if (wasFromEdit && s.data.enseigne && refs.enseignes[cat]?.includes(s.data.enseigne)) {
    s.fromEdit = false;
    setSession(key, s);
    return askConfirm(ctx, key);
  }
  await advance(ctx, key);
}

export async function handleEnseigne(ctx) {
  const key = ctx.match[1];
  const idx = Number(ctx.match[2]);
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  const refs = await loadReferences();
  const enseigne = refs.enseignes[s.data.categorie]?.[idx];
  if (!enseigne) return ctx.answerCbQuery('Enseigne introuvable.');

  s.data.enseigne = enseigne;
  s.data.enseigne_in_list = true;
  s.data.enseigne_confidence = 'high';
  const wasFromEdit = s.fromEdit;
  if (wasFromEdit) s.fromEdit = false;
  setSession(key, s);
  await ctx.answerCbQuery(`✓ ${enseigne}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  if (wasFromEdit) return askConfirm(ctx, key);
  await advance(ctx, key);
}

export async function handleEnseigneNew(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.awaitingTextFor = 'enseigne';
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply(
    `✏️ Saisis le nom de la nouvelle enseigne pour <b>${s.data.categorie}</b> :`,
    { parse_mode: 'HTML' }
  );
}

export async function handleDesignationSkip(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.data.designation = '';
  setSession(key, s);
  await ctx.answerCbQuery('✓ Aucune');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await advance(ctx, key);
}

export async function handleDesignationInput(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.awaitingTextFor = 'designation';
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('✏️ Saisis la désignation (1 ligne) :');
}

export async function handleForceDuplicate(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.duplicateAcknowledged = true;
  setSession(key, s);
  await ctx.answerCbQuery('Doublon ignoré');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await advance(ctx, key);
}

export async function handleConfirm(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  await ctx.answerCbQuery(s.isExisting ? 'Mise à jour...' : 'Insertion...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  try {
    const payload = {
      categorie: s.data.categorie,
      date: s.data.date,
      enseigne: s.data.enseigne,
      designation: s.data.designation || '',
      montant: s.data.montant,
    };
    if (s.isExisting && s.rowIndex) {
      await updateExpense(s.rowIndex, payload);
    } else {
      await appendExpense(payload);
    }

    // ── Mode batch séquentiel : passe à la transaction suivante ──
    if (s.pendingQueue && s.pendingQueue.length > 0) {
      const nextData = s.pendingQueue.shift();
      const batchDone = (s.batchDone || 0) + 1;
      const batchTotal = s.batchTotal || batchDone + s.pendingQueue.length + 1;
      const nextKey = newKey();
      setSession(nextKey, {
        userId: s.userId,
        data: nextData,
        awaitingTextFor: null,
        pendingQueue: s.pendingQueue,
        batchTotal,
        batchDone,
        duplicateAcknowledged: false,
      });
      clearSession(key);
      await ctx.reply(
        `✅ <b>${batchDone}/${batchTotal}</b> insérée.\n\n➡️ <b>${batchDone + 1}/${batchTotal}</b> :`,
        { parse_mode: 'HTML' }
      );
      return advance(ctx, nextKey);
    }

    // ── Transaction seule ou dernière de la séquence ──────────────
    const recap = formatRecap(s.data);
    const wasBatch = s.batchTotal && s.batchTotal > 1;
    const batchDone = (s.batchDone || 0) + 1;
    const title = s.isExisting
      ? 'Dépense mise à jour'
      : wasBatch
      ? `✅ ${batchDone}/${s.batchTotal} — Toutes insérées`
      : 'Dépense enregistrée';
    clearSession(key);
    await ctx.reply(`✅ <b>${title}</b>\n\n${recap}`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleConfirm]', err);
    await ctx.reply(`❌ Erreur Sheets : ${err.message}`);
  }
}

export async function handleCancel(ctx) {
  const key = ctx.match[1];
  clearSession(key);
  await ctx.answerCbQuery('Annulé.');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('🚫 Annulé.');
}

export async function handleEdit(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await showEditMenu(ctx, key);
}

/**
 * Démarre un flow d'édition pour une dépense déjà inscrite dans le Sheet.
 * Appelé par /derniere (handlers/expense.js).
 */
export async function startEditExisting(ctx, userId, expense) {
  const key = newKey();
  const isoDate = expense.date
    ? expense.date.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const data = {
    categorie: expense.categorie,
    date: isoDate,
    enseigne: expense.enseigne,
    designation: expense.designation || '',
    montant: expense.montant,
  };
  setSession(key, {
    userId,
    data,
    awaitingTextFor: null,
    isExisting: true,
    rowIndex: expense.rowIndex,
  });
  await ctx.reply(formatRecap(data), { parse_mode: 'HTML' });
  await showEditMenu(ctx, key);
}

async function showEditMenu(ctx, key) {
  const s = sessions.get(key);
  if (!s) return;
  await ctx.reply('✏️ <b>Que veux-tu modifier ?</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🏷️ Catégorie', `editfield_${key}_categorie`)],
      [Markup.button.callback('🏪 Enseigne', `editfield_${key}_enseigne`)],
      [Markup.button.callback('📝 Désignation', `editfield_${key}_designation`)],
      [Markup.button.callback('💶 Montant', `editfield_${key}_montant`)],
      [Markup.button.callback('📅 Date', `editfield_${key}_date`)],
      [Markup.button.callback('↩️ Retour confirmation', `editfield_${key}_back`)],
      [Markup.button.callback('❌ Annuler', `cancel_${key}`)],
    ]),
  });
}

export async function handleEditField(ctx) {
  const key = ctx.match[1];
  const field = ctx.match[2];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  s.fromEdit = true;
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  const refs = await loadReferences();

  if (field === 'back') {
    return askConfirm(ctx, key);
  }
  if (field === 'categorie') {
    return askCategory(ctx, key, refs);
  }
  if (field === 'enseigne') {
    return askEnseigne(ctx, key, refs);
  }
  if (field === 'designation') {
    s.awaitingTextFor = 'edit_designation';
    setSession(key, s);
    return ctx.reply('✏️ Saisis la nouvelle désignation (ou « . » pour vider) :');
  }
  if (field === 'montant') {
    s.awaitingTextFor = 'edit_montant';
    setSession(key, s);
    return ctx.reply('💶 Saisis le nouveau montant en € (ex: <code>42.50</code> ou <code>42,50</code>) :', {
      parse_mode: 'HTML',
    });
  }
  if (field === 'date') {
    s.awaitingTextFor = 'edit_date';
    setSession(key, s);
    return ctx.reply(
      '📅 Saisis la nouvelle date au format <code>JJ/MM/AAAA</code> ou <code>AAAA-MM-JJ</code> :',
      { parse_mode: 'HTML' }
    );
  }
}

function parseFrenchDate(text) {
  const t = text.trim();
  // YYYY-MM-DD
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // JJ/MM/AAAA ou JJ-MM-AAAA ou JJ.MM.AAAA
  m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

// ─── Texte libre ──────────────────────────────────────────────
export async function handleText(ctx) {
  if (ctx.message.text?.startsWith('/')) return;
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return;

  // Les flows admin (/addenseigne, /renameenseigne) ont priorité
  if (await tryHandleAdminText(ctx)) return;

  const active = getActiveSession(userId);
  if (!active?.session.awaitingTextFor) return;

  const { key, session } = active;
  const text = ctx.message.text.trim();

  if (session.awaitingTextFor === 'new_categorie') {
    try {
      const { name } = await addCategorie(text);
      session.data.categorie = name;
      session.data.categorie_confidence = 'high';
      // Force la sélection d'enseigne (la nouvelle catégorie est vide)
      session.data.enseigne_in_list = false;
      session.awaitingTextFor = null;
      setSession(key, session);
      await ctx.reply(`✅ Catégorie « ${name} » créée.`);
      return advance(ctx, key);
    } catch (err) {
      console.error('[handleCategoryNew text]', err);
      return ctx.reply(`❌ ${err.message}\nSaisis un autre nom :`);
    }
  }

  if (session.awaitingTextFor === 'enseigne') {
    try {
      await addEnseigne(session.data.categorie, text);
      session.data.enseigne = text;
      session.data.enseigne_in_list = true;
      session.data.enseigne_confidence = 'high';
      session.awaitingTextFor = null;
      const wasFromEdit = session.fromEdit;
      if (wasFromEdit) session.fromEdit = false;
      setSession(key, session);
      await ctx.reply(`✅ Enseigne « ${text} » ajoutée à la liste.`);
      return wasFromEdit ? askConfirm(ctx, key) : advance(ctx, key);
    } catch (err) {
      console.error('[addEnseigne]', err);
      return ctx.reply(`❌ Erreur ajout enseigne : ${err.message}`);
    }
  }

  if (session.awaitingTextFor === 'designation') {
    session.data.designation = text;
    session.awaitingTextFor = null;
    setSession(key, session);
    return advance(ctx, key);
  }

  if (session.awaitingTextFor === 'edit_designation') {
    session.data.designation = text === '.' ? '' : text;
    session.awaitingTextFor = null;
    session.fromEdit = false;
    setSession(key, session);
    return askConfirm(ctx, key);
  }

  if (session.awaitingTextFor === 'edit_montant') {
    const n = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      return ctx.reply('❌ Montant invalide. Réessaie (ex: <code>42.50</code>) :', {
        parse_mode: 'HTML',
      });
    }
    session.data.montant = Math.round(n * 100) / 100;
    session.awaitingTextFor = null;
    session.fromEdit = false;
    setSession(key, session);
    return askConfirm(ctx, key);
  }

  if (session.awaitingTextFor === 'edit_date') {
    const iso = parseFrenchDate(text);
    if (!iso) {
      return ctx.reply(
        '❌ Date invalide. Format attendu : <code>JJ/MM/AAAA</code> ou <code>AAAA-MM-JJ</code>.',
        { parse_mode: 'HTML' }
      );
    }
    session.data.date = iso;
    session.awaitingTextFor = null;
    session.fromEdit = false;
    setSession(key, session);
    return askConfirm(ctx, key);
  }
}
