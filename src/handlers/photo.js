import { Markup } from 'telegraf';
import { analyzeInvoice, analyzeInvoicePdf } from '../mistral.js';
import { appendExpense, loadReferences, addEnseigne, findDuplicate } from '../sheets.js';
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
    const data = await analyzeInvoicePdf(buffer, refs, name || 'facture.pdf');

    const key = newKey();
    setSession(key, { userId, data, awaitingTextFor: null });

    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});
    await advance(ctx, key);
  } catch (err) {
    await ctx.telegram.deleteMessage(ctx.chat.id, processing.message_id).catch(() => {});
    console.error('[handleDocument]', err);
    await ctx.reply(`❌ Erreur analyse PDF : ${err.message}`);
  }
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

  await ctx.answerCbQuery('Insertion...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  try {
    await appendExpense({
      categorie: s.data.categorie,
      date: s.data.date,
      enseigne: s.data.enseigne,
      designation: s.data.designation || '',
      montant: s.data.montant,
    });
    const recap = formatRecap(s.data);
    clearSession(key);
    await ctx.reply(`✅ <b>Dépense enregistrée</b>\n\n${recap}`, { parse_mode: 'HTML' });
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
