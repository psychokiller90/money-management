import { Markup } from 'telegraf';
import { analyzeInvoice } from '../mistral.js';
import { appendExpense, loadReferences, addEnseigne, findDuplicate } from '../sheets.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map();   // key → { userId, data, awaitingTextFor, updatedAt }
const userActive = new Map(); // userId → key

function newKey() {
  return Date.now().toString(36).slice(-6);
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
export async function handlePhoto(ctx) {
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return ctx.reply('⛔ Accès non autorisé.');

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
  if (s.data.enseigne && !refs.enseignes[cat]?.includes(s.data.enseigne)) {
    s.data.enseigne_in_list = false;
  }
  setSession(key, s);
  await ctx.answerCbQuery(`✓ ${cat}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});
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
  setSession(key, s);
  await ctx.answerCbQuery(`✓ ${enseigne}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});
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

  s.awaitingTextFor = 'edit';
  setSession(key, s);
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply(
    "✏️ Format des corrections (une ligne par champ, seuls ceux à modifier) :\n\n" +
      '<code>categorie: Courses\nenseigne: Leclerc\ndate: 2026-05-04\nmontant: 42.50\ndesignation: ...</code>',
    { parse_mode: 'HTML' }
  );
}

// ─── Texte libre ──────────────────────────────────────────────
export async function handleText(ctx) {
  if (ctx.message.text?.startsWith('/')) return;
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return;

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
      setSession(key, session);
      await ctx.reply(`✅ Enseigne « ${text} » ajoutée à la liste.`);
      return advance(ctx, key);
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

  if (session.awaitingTextFor === 'edit') {
    for (const line of text.split('\n')) {
      const [field, ...rest] = line.split(':');
      if (!field) continue;
      const value = rest.join(':').trim();
      if (!value) continue;
      const k = field.trim().toLowerCase();
      if (k === 'montant') session.data.montant = parseFloat(value);
      else if (['categorie', 'enseigne', 'date', 'designation'].includes(k)) {
        session.data[k] = value;
      }
    }
    session.awaitingTextFor = null;
    setSession(key, session);
    return askConfirm(ctx, key);
  }
}
