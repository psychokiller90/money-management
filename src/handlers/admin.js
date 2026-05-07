import { Markup } from 'telegraf';
import {
  loadReferences,
  addEnseigne,
  delEnseigne,
  renameEnseigne,
} from '../sheets.js';

const SESSION_TTL_MS = 10 * 60 * 1000;

// userId → { mode, step, categorie?, enseigne?, updatedAt }
const adminSessions = new Map();

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function setAdmin(userId, sess) {
  sess.updatedAt = Date.now();
  adminSessions.set(userId, sess);
}

function getAdmin(userId) {
  const s = adminSessions.get(userId);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    adminSessions.delete(userId);
    return null;
  }
  return s;
}

function clearAdmin(userId) {
  adminSessions.delete(userId);
}

function chunkRows(buttons, perRow = 2) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += perRow) {
    rows.push(buttons.slice(i, i + perRow));
  }
  return rows;
}

// ─── /categories : liste catégories + enseignes ──────────────
export async function handleCategories(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    const refs = await loadReferences(true);
    const lines = ['📚 <b>Catégories & Enseignes</b>\n'];
    for (const cat of refs.categories) {
      const list = refs.enseignes[cat] || [];
      lines.push(`<b>${cat}</b> (${list.length})`);
      if (list.length === 0) {
        lines.push('  <i>(vide)</i>');
      } else {
        lines.push(list.map((e) => `  • ${e}`).join('\n'));
      }
      lines.push('');
    }
    lines.push(
      'Commandes : /addenseigne /delenseigne /renameenseigne'
    );
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleCategories]', err);
    await ctx.reply(`❌ Erreur lecture Sheet : ${err.message}`);
  }
}

// ─── /addenseigne : flow interactif ───────────────────────────
export async function handleAddEnseigne(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  const refs = await loadReferences();
  setAdmin(ctx.from.id, { mode: 'add', step: 'cat' });
  await askPickCategory(ctx, refs, 'add');
}

// ─── /delenseigne : flow interactif ───────────────────────────
export async function handleDelEnseigne(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  const refs = await loadReferences();
  setAdmin(ctx.from.id, { mode: 'del', step: 'cat' });
  await askPickCategory(ctx, refs, 'del');
}

// ─── /renameenseigne : flow interactif ────────────────────────
export async function handleRenameEnseigne(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  const refs = await loadReferences();
  setAdmin(ctx.from.id, { mode: 'rename', step: 'cat' });
  await askPickCategory(ctx, refs, 'rename');
}

async function askPickCategory(ctx, refs, mode) {
  const buttons = refs.categories.map((c) =>
    Markup.button.callback(c, `admincat_${mode}_${c}`)
  );
  const rows = chunkRows(buttons, 2);
  rows.push([Markup.button.callback('❌ Annuler', `admincancel`)]);
  await ctx.reply('🏷️ <b>Choisis la catégorie :</b>', {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(rows),
  });
}

// ─── Callback : choix catégorie ───────────────────────────────
export async function handleAdminCat(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const mode = ctx.match[1];
  const cat = ctx.match[2];
  const refs = await loadReferences();
  if (!refs.categories.includes(cat)) {
    return ctx.answerCbQuery('Catégorie introuvable.');
  }

  await ctx.answerCbQuery(`✓ ${cat}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  if (mode === 'add') {
    setAdmin(ctx.from.id, { mode, step: 'enseigne_input', categorie: cat });
    return ctx.reply(
      `✏️ Saisis le nom de la nouvelle enseigne pour <b>${cat}</b> :`,
      { parse_mode: 'HTML' }
    );
  }

  // del / rename → choisir une enseigne existante
  const enseignes = refs.enseignes[cat] || [];
  if (enseignes.length === 0) {
    clearAdmin(ctx.from.id);
    return ctx.reply(`ℹ️ Aucune enseigne dans <b>${cat}</b>.`, { parse_mode: 'HTML' });
  }
  setAdmin(ctx.from.id, { mode, step: 'pick_ens', categorie: cat });
  const buttons = enseignes.map((e, i) =>
    Markup.button.callback(e, `adminens_${mode}_${i}`)
  );
  const rows = chunkRows(buttons, 2);
  rows.push([Markup.button.callback('❌ Annuler', `admincancel`)]);
  await ctx.reply(
    `🏪 <b>${mode === 'del' ? 'Quelle enseigne supprimer' : 'Quelle enseigne renommer'} dans ${cat} ?</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }
  );
}

// ─── Callback : choix enseigne pour del/rename ────────────────
export async function handleAdminEns(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const mode = ctx.match[1];
  const idx = Number(ctx.match[2]);
  const sess = getAdmin(ctx.from.id);
  if (!sess) return ctx.answerCbQuery('Session expirée.');

  const refs = await loadReferences();
  const enseigne = refs.enseignes[sess.categorie]?.[idx];
  if (!enseigne) return ctx.answerCbQuery('Enseigne introuvable.');

  await ctx.answerCbQuery(`✓ ${enseigne}`);
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  if (mode === 'del') {
    setAdmin(ctx.from.id, { ...sess, step: 'confirm_del', enseigne });
    return ctx.reply(
      `⚠️ Confirmer la suppression de <b>${enseigne}</b> dans <b>${sess.categorie}</b> ?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🗑️ Supprimer', `admindelconfirm`)],
          [Markup.button.callback('❌ Annuler', `admincancel`)],
        ]),
      }
    );
  }

  // rename
  setAdmin(ctx.from.id, { ...sess, step: 'rename_input', enseigne });
  return ctx.reply(
    `✏️ Saisis le nouveau nom pour <b>${enseigne}</b> :`,
    { parse_mode: 'HTML' }
  );
}

// ─── Callback : confirme suppression ──────────────────────────
export async function handleAdminDelConfirm(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const sess = getAdmin(ctx.from.id);
  if (!sess || sess.step !== 'confirm_del') return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Suppression...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  try {
    await delEnseigne(sess.categorie, sess.enseigne);
    clearAdmin(ctx.from.id);
    await ctx.reply(`✅ <b>${sess.enseigne}</b> supprimée de <b>${sess.categorie}</b>.`, {
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error('[delEnseigne]', err);
    await ctx.reply(`❌ Erreur : ${err.message}`);
  }
}

// ─── Callback : annule un flow admin ──────────────────────────
export async function handleAdminCancel(ctx) {
  clearAdmin(ctx.from.id);
  await ctx.answerCbQuery('Annulé.');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('🚫 Annulé.');
}

// ─── Texte libre (saisie nouvelle enseigne / nouveau nom) ─────
// Renvoie true si le texte a été consommé par un flow admin.
export async function tryHandleAdminText(ctx) {
  if (!isAuthorized(ctx.from.id)) return false;
  const sess = getAdmin(ctx.from.id);
  if (!sess) return false;

  const text = ctx.message.text?.trim();
  if (!text || text.startsWith('/')) return false;

  if (sess.step === 'enseigne_input') {
    try {
      await addEnseigne(sess.categorie, text);
      clearAdmin(ctx.from.id);
      await ctx.reply(`✅ « ${text} » ajoutée à <b>${sess.categorie}</b>.`, {
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.error('[addEnseigne]', err);
      await ctx.reply(`❌ Erreur : ${err.message}`);
    }
    return true;
  }

  if (sess.step === 'rename_input') {
    try {
      await renameEnseigne(sess.categorie, sess.enseigne, text);
      clearAdmin(ctx.from.id);
      await ctx.reply(
        `✅ <b>${sess.enseigne}</b> → <b>${text}</b> dans <b>${sess.categorie}</b>.`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      console.error('[renameEnseigne]', err);
      await ctx.reply(`❌ Erreur : ${err.message}`);
    }
    return true;
  }

  return false;
}
