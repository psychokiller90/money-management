import { Markup } from 'telegraf';
import { analyzeInvoiceImage, analyzeInvoicePdf, chatWithAssistant } from '../mistral.js';
import {
  appendExpense,
  updateExpense,
  loadReferences,
  addEnseigne,
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
    const result = await analyzeInvoiceImage(base64, refs);
    const transactions = result.transactions || [];

    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});

    if (transactions.length === 0) {
      return ctx.reply('ℹ️ Aucune dépense détectée sur cette image.');
    }

    if (transactions.length === 1) {
      // Ticket / facture simple → flow habituel
      const key = newKey();
      setSession(key, { userId, data: transactions[0], awaitingTextFor: null });
      return advance(ctx, key);
    }

    // Capture multi-transactions (appli bancaire, relevé) → flow batch
    return askSpecialTransactions(ctx, userId, transactions, refs);
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
  // Accepte aussi un objet Date (ex: dup.date renvoyé par listExpenses)
  if (isoDate instanceof Date) {
    return `${String(isoDate.getUTCDate()).padStart(2, '0')}/${String(isoDate.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const [, m, d] = String(isoDate).split('-');
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
export async function handleBatchAll(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Insertion en cours...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  // Préchargement du cache dépenses pour que findDuplicate soit rapide
  await listExpenses(true);

  const all = [s.data, ...(s.pendingQueue || [])];
  let ok = 0;
  const skippedDups = [];
  const errors = [];

  for (const t of all) {
    try {
      if (!t.date || !t.montant || !t.enseigne || !t.categorie) {
        errors.push(`${t.enseigne || '?'} — données incomplètes`);
        continue;
      }
      // Détection doublon
      const dup = await findDuplicate({
        date: t.date,
        montant: t.montant,
        enseigne: t.enseigne,
      });
      if (dup) {
        skippedDups.push(
          `${t.enseigne} — ${t.montant} € (ligne ${dup.rowIndex}, ${fmtDateShort(dup.date)})`
        );
        continue;
      }
      await appendExpense({
        categorie: t.categorie,
        date: t.date,
        enseigne: t.enseigne,
        designation: t.designation || '',
        montant: t.montant,
      });
      ok++;
    } catch (err) {
      errors.push(`${t.enseigne || '?'} — ${err.message}`);
    }
  }
  clearSession(key);

  const lines = [`✅ <b>${ok}/${all.length} transactions insérées</b>`];
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

  // Marque le début de la revue séquentielle (Annuler = ignorer, pas tout arrêter)
  s.seqReview = true;
  setSession(key, s);

  const total = s.batchTotal;
  await ctx.reply(
    `🔎 Révision une par une — <b>${total} transactions</b>\nChaque transaction sera présentée individuellement.\n<i>Annuler = ignorer cette dépense et passer à la suivante.</i>`,
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

  if (!data.date) {
    return askDate(ctx, key);
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
  rows.push([Markup.button.callback('❌ Annuler', `cancel_${key}`)]);

  const s = sessions.get(key);
  const detected = s.data.categorie
    ? `\n\n🤖 IA proposait : <b>${s.data.categorie}</b> (confiance: ${s.data.categorie_confidence})`
    : '';
  await ctx.reply(`🏷️ <b>Choisis la catégorie :</b>${detected}`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows),
  });
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

async function askDate(ctx, key) {
  const s = sessions.get(key);
  if (!s) return;
  s.awaitingTextFor = 'manual_date';
  setSession(key, s);
  const today = new Date().toISOString().slice(0, 10);
  await ctx.reply(
    '📅 <b>Date manquante</b>\n\nSaisis-la au format <code>JJ/MM/AAAA</code> ou clique :',
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(`📅 Aujourd'hui (${fmtDate(today)})`, `ajoutdate_${key}`)],
        [Markup.button.callback('❌ Annuler', `cancel_${key}`)],
      ]),
    }
  );
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

    // ── Mode batch séquentiel : insère puis passe à la suivante ──
    if (s.batchTotal && s.batchTotal > 1 && !s.isExisting) {
      s.batchDone = (s.batchDone || 0) + 1;
      await ctx.reply(`✅ <b>Dépense insérée.</b>`, { parse_mode: 'HTML' });
      return proceedToNextInBatch(ctx, s, key);
    }

    // ── Transaction seule ou édition d'une dépense existante ──────
    const recap = formatRecap(s.data);
    const title = s.isExisting ? 'Dépense mise à jour' : 'Dépense enregistrée';
    clearSession(key);
    await ctx.reply(`✅ <b>${title}</b>\n\n${recap}`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleConfirm]', err);
    await ctx.reply(`❌ Erreur Sheets : ${err.message}`);
  }
}

/**
 * Passe à la dépense suivante d'un batch séquentiel (après insertion OU saut).
 * La position est dérivée de pendingQueue, indépendamment du nombre d'insertions.
 */
async function proceedToNextInBatch(ctx, s, key) {
  const batchTotal = s.batchTotal || 0;
  const batchDone = s.batchDone || 0;

  if (s.pendingQueue && s.pendingQueue.length > 0) {
    const nextData = s.pendingQueue.shift();
    const position = batchTotal - s.pendingQueue.length; // index 1-based de nextData
    const nextKey = newKey();
    setSession(nextKey, {
      userId: s.userId,
      data: nextData,
      awaitingTextFor: null,
      pendingQueue: s.pendingQueue,
      batchTotal,
      batchDone,
      seqReview: true,
      duplicateAcknowledged: false,
    });
    clearSession(key);
    await ctx.reply(`➡️ <b>${position}/${batchTotal}</b> :`, { parse_mode: 'HTML' });
    return advance(ctx, nextKey);
  }

  // Plus aucune dépense en attente → fin de la revue
  clearSession(key);
  await ctx.reply(
    `🏁 <b>Revue terminée</b> — ${batchDone}/${batchTotal} dépense(s) insérée(s).`,
    { parse_mode: 'HTML' }
  );
}

export async function handleCancel(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  await ctx.answerCbQuery('Annulé.');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  // En revue séquentielle : Annuler = ignorer CETTE dépense, continuer la suite
  if (s && s.seqReview) {
    await ctx.reply('⏭️ Dépense ignorée.');
    return proceedToNextInBatch(ctx, s, key);
  }

  // Écran de résumé batch ou dépense seule : annulation complète
  clearSession(key);
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

// ─── Parsing rapide d'une ligne « montant enseigne catégorie [date] » ──
function normalizeStr(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Parse une ligne du type : "38.95 Leclerc Courses 12/05/2026"
 * Ordre : montant (1er), date (dernier si format date — sinon aujourd'hui),
 * catégorie (token qui matche une catégorie connue), enseigne (le reste).
 * @returns {{montant,enseigne,categorie,date} | {error}}
 */
function parseExpenseLine(line, refs) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    return { error: 'format attendu : <code>montant enseigne catégorie [date]</code>' };
  }

  const montant = parseFloat(tokens[0].replace(',', '.'));
  if (!Number.isFinite(montant) || montant <= 0) {
    return { error: `montant invalide « ${tokens[0]} »` };
  }

  let rest = tokens.slice(1);

  // Date = dernier token si format reconnu, sinon aujourd'hui
  let date = parseFrenchDate(rest[rest.length - 1]);
  if (date) {
    rest = rest.slice(0, -1);
  } else {
    date = new Date().toISOString().slice(0, 10);
  }

  if (rest.length < 2) {
    return { error: 'enseigne et catégorie requises' };
  }

  // Catégorie = token qui matche une catégorie connue (insensible casse/accents)
  const catIdx = rest.findIndex((t) =>
    refs.categories.some((c) => normalizeStr(c) === normalizeStr(t))
  );
  if (catIdx < 0) {
    return { error: `catégorie introuvable (attendu : ${refs.categories.join(', ')})` };
  }
  const categorie = refs.categories.find(
    (c) => normalizeStr(c) === normalizeStr(rest[catIdx])
  );
  rest = [...rest.slice(0, catIdx), ...rest.slice(catIdx + 1)];

  const enseigneRaw = rest.join(' ').trim();
  if (!enseigneRaw) return { error: 'enseigne manquante' };

  // Si l'enseigne matche une enseigne connue → utilise le nom canonique
  const known = (refs.enseignes[categorie] || []).find(
    (e) => normalizeStr(e) === normalizeStr(enseigneRaw)
  );

  return {
    montant: Math.round(montant * 100) / 100,
    enseigne: known || enseigneRaw,
    enseigneKnown: Boolean(known),
    categorie,
    date,
  };
}

// Construit l'objet transaction (forme attendue par advance/handleConfirm)
function toTransaction(p) {
  return {
    categorie: p.categorie,
    categorie_confidence: 'high',
    enseigne: p.enseigne,
    enseigne_in_list: p.enseigneKnown,
    enseigne_confidence: p.enseigneKnown ? 'high' : 'low',
    designation: '',
    date: p.date,
    montant: p.montant,
  };
}

// ─── /ajout : saisie manuelle (interactive, une-ligne ou masse) ──
export async function handleAjout(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  const userId = ctx.from.id;

  // Args après /ajout (une ou plusieurs lignes) → parsing rapide
  const raw = (ctx.message.text || '').replace(/^\/ajout(@\w+)?\s*/i, '');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  // Aucun argument → flow interactif classique
  if (lines.length === 0) {
    return startInteractiveAjout(ctx, userId);
  }

  const refs = await loadReferences();
  const valid = [];
  const invalid = [];
  lines.forEach((line, i) => {
    const parsed = parseExpenseLine(line, refs);
    if (parsed.error) invalid.push({ line: i + 1, text: line, error: parsed.error });
    else valid.push(toTransaction(parsed));
  });

  // Cas 1 — une seule ligne, valide : confirmation directe via advance()
  if (lines.length === 1 && valid.length === 1) {
    const key = newKey();
    setSession(key, { userId, data: valid[0], awaitingTextFor: null });
    await listExpenses(true); // précharge le cache pour la détection de doublon
    return advance(ctx, key);
  }

  // Cas 1b — une seule ligne, invalide
  if (lines.length === 1 && valid.length === 0) {
    return ctx.reply(
      `❌ <b>Ligne invalide :</b> ${invalid[0].error}\n\n` +
        'Format : <code>/ajout montant enseigne catégorie [JJ/MM/AAAA]</code>\n' +
        'Ex : <code>/ajout 38.95 Leclerc Courses 12/05/2026</code>\n\n' +
        'Ou utilise <code>/ajout</code> seul pour le mode guidé.',
      { parse_mode: 'HTML' }
    );
  }

  // Cas 2 — saisie en masse : récap groupé
  return showAjoutBatchRecap(ctx, userId, valid, invalid);
}

// Démarre le flow interactif classique (montant → date → catégorie → ...)
async function startInteractiveAjout(ctx, userId) {
  const key = newKey();
  setSession(key, {
    userId,
    data: {
      categorie: null,
      categorie_confidence: 'low',
      enseigne: null,
      enseigne_in_list: false,
      designation: null,
      date: null,
      montant: null,
    },
    awaitingTextFor: 'manual_montant',
  });
  await ctx.reply(
    '➕ <b>Ajout manuel</b>\n\n💶 Saisis le montant en € :\n\n' +
      '<i>💡 Astuce : tu peux aussi tout saisir d\'un coup :\n' +
      '<code>/ajout 38.95 Leclerc Courses 12/05/2026</code>\n' +
      'ou plusieurs lignes à la fois.</i>',
    { parse_mode: 'HTML' }
  );
}

// ─── Saisie en masse : récap + boutons Tout insérer / Revoir ──
async function showAjoutBatchRecap(ctx, userId, valid, invalid) {
  const lines = [];

  if (valid.length > 0) {
    const total = valid.reduce((s, t) => s + t.montant, 0);
    lines.push(
      `📥 <b>${valid.length} dépense${valid.length > 1 ? 's' : ''} valide${valid.length > 1 ? 's' : ''}</b> — ${fmtAmountShort(total)}\n`
    );
    valid.slice(0, 15).forEach((t) => {
      const flag = t.enseigne_in_list ? '' : ' 🆕';
      lines.push(
        `• ${fmtDateShort(t.date)} — ${t.enseigne} — ${fmtAmountShort(t.montant)} <i>(${t.categorie})</i>${flag}`
      );
    });
    if (valid.length > 15) lines.push(`<i>… et ${valid.length - 15} autre(s)</i>`);
  }

  if (invalid.length > 0) {
    lines.push('');
    lines.push(`⚠️ <b>${invalid.length} ligne${invalid.length > 1 ? 's' : ''} invalide${invalid.length > 1 ? 's' : ''} :</b>`);
    invalid.forEach((iv) => lines.push(`• L${iv.line} « ${iv.text} » → ${iv.error}`));
  }

  // Aucune ligne valide → pas de boutons d'insertion
  if (valid.length === 0) {
    lines.push('');
    lines.push('Corrige le format ou utilise <code>/ajout</code> seul pour le mode guidé.');
    return ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  }

  const batchKey = newKey();
  setSession(batchKey, {
    userId,
    data: valid[0],
    awaitingTextFor: null,
    pendingQueue: valid.slice(1),
    batchTotal: valid.length,
    batchDone: 0,
  });

  if (invalid.length > 0) {
    lines.push('');
    lines.push('<i>Les lignes invalides seront ignorées. Tu peux les corriger et renvoyer un /ajout.</i>');
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback(`✅ Tout insérer (${valid.length})`, `batchall_${batchKey}`)],
      [Markup.button.callback('🔎 Revoir une par une', `batchseq_${batchKey}`)],
      [Markup.button.callback('❌ Annuler', `cancel_${batchKey}`)],
    ]),
  });
}

export async function handleAjoutDate(ctx) {
  const key = ctx.match[1];
  const s = sessions.get(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  const today = new Date().toISOString().slice(0, 10);
  s.data.date = today;
  s.awaitingTextFor = null;
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  return advance(ctx, key);
}

// ─── Assistant conversationnel ────────────────────────────────
// Construit un contexte texte compact : agrégats par mois/catégorie + détail.
function buildExpenseContext(expenses) {
  const today = new Date();
  const valid = expenses.filter((e) => e.date);
  const lines = [
    `Date du jour : ${today.toISOString().slice(0, 10)}`,
    `Nombre total de dépenses enregistrées : ${valid.length}`,
  ];

  const byMonthCat = {};
  let grand = 0;
  for (const e of valid) {
    const ym = `${e.date.getUTCFullYear()}-${String(e.date.getUTCMonth() + 1).padStart(2, '0')}`;
    byMonthCat[ym] = byMonthCat[ym] || {};
    byMonthCat[ym][e.categorie] = (byMonthCat[ym][e.categorie] || 0) + e.montant;
    grand += e.montant;
  }
  lines.push(`Total cumulé toutes périodes : ${grand.toFixed(2)} €`);

  lines.push('\nTotaux par mois et catégorie :');
  for (const ym of Object.keys(byMonthCat).sort().reverse()) {
    const tot = Object.values(byMonthCat[ym]).reduce((s, v) => s + v, 0);
    const cats = Object.entries(byMonthCat[ym])
      .sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${c} ${v.toFixed(2)}€`)
      .join(', ');
    lines.push(`- ${ym} (total ${tot.toFixed(2)}€) : ${cats}`);
  }

  lines.push('\nDétail (date | catégorie | enseigne | désignation | montant) :');
  const sorted = [...valid].sort((a, b) => b.date.getTime() - a.date.getTime());
  for (const e of sorted) {
    const d = `${String(e.date.getUTCDate()).padStart(2, '0')}/${String(e.date.getUTCMonth() + 1).padStart(2, '0')}/${e.date.getUTCFullYear()}`;
    lines.push(`${d} | ${e.categorie} | ${e.enseigne} | ${e.designation || '—'} | ${e.montant.toFixed(2)}€`);
  }
  return lines.join('\n');
}

async function handleChatQuery(ctx, question) {
  const thinking = await ctx.reply('🤖 Je consulte tes dépenses…');
  try {
    const expenses = await listExpenses();
    const context = buildExpenseContext(expenses);
    const answer = await chatWithAssistant(question, context);
    await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id).catch(() => {});
    await ctx.reply(`🤖 ${answer}`);
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, thinking.message_id).catch(() => {});
    console.error('[handleChatQuery]', err);
    await ctx.reply(`❌ Désolé, je n'ai pas pu traiter ta question : ${err.message}`);
  }
}

// ─── Texte libre ──────────────────────────────────────────────
export async function handleText(ctx) {
  if (ctx.message.text?.startsWith('/')) return;
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return;

  // Les flows admin (/addenseigne, /renameenseigne) ont priorité
  if (await tryHandleAdminText(ctx)) return;

  const active = getActiveSession(userId);
  // Aucun flow texte en cours → question libre à l'assistant financier
  if (!active?.session.awaitingTextFor) {
    return handleChatQuery(ctx, ctx.message.text.trim());
  }

  const { key, session } = active;
  const text = ctx.message.text.trim();

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

  if (session.awaitingTextFor === 'manual_montant') {
    const n = parseFloat(text.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      return ctx.reply('❌ Montant invalide. Réessaie (ex: <code>42.50</code>) :', {
        parse_mode: 'HTML',
      });
    }
    session.data.montant = Math.round(n * 100) / 100;
    session.awaitingTextFor = 'manual_date';
    setSession(key, session);
    const today = new Date().toISOString().slice(0, 10);
    return ctx.reply(
      '📅 Saisis la date (<code>JJ/MM/AAAA</code>) ou clique :',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback(`📅 Aujourd'hui (${fmtDate(today)})`, `ajoutdate_${key}`),
        ]]),
      }
    );
  }

  if (session.awaitingTextFor === 'manual_date') {
    const iso = parseFrenchDate(text);
    if (!iso) {
      return ctx.reply('❌ Date invalide. Format : <code>JJ/MM/AAAA</code>.', {
        parse_mode: 'HTML',
      });
    }
    session.data.date = iso;
    session.awaitingTextFor = null;
    setSession(key, session);
    return advance(ctx, key);
  }
}
