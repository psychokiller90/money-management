import { Markup } from 'telegraf';
import { appendNote, listNotes, updateNoteById, deleteNoteById } from '../sheets.js';

const CAPTURE_TTL_MS = 30 * 60 * 1000;

// userId → { attend: 'creation' | 'edition', id?: string, depuis: number }
const captures = new Map();

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function setCapture(userId, capture) {
  captures.set(userId, { ...capture, depuis: Date.now() });
}

function getCapture(userId) {
  const c = captures.get(userId);
  if (!c) return null;
  if (Date.now() - c.depuis > CAPTURE_TTL_MS) {
    captures.delete(userId);
    return null;
  }
  return c;
}

function clearCapture(userId) {
  captures.delete(userId);
}

/** Une capture de note est-elle en attente ? (consulté par handleVoice) */
export function isAwaitingNote(userId) {
  return getCapture(userId) !== null;
}

function fmtDate(d) {
  if (!d) return '—';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

const STATUT_EMOJI = { nouvelle: '🆕', 'en cours': '⏳' };

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Confirmation d'enregistrement, avec un bouton pour corriger la formulation. */
async function confirmerNote(ctx, note) {
  await ctx.reply(
    `🗒️ <b>Note ${note.id} enregistrée</b>\n\n${escapeHtml(note.note)}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Corriger', `noteedit_${note.id}`)],
      ]),
    }
  );
}

/**
 * Enregistre un texte comme nouvelle note, ou remplace une note existante
 * si une édition était en cours. Partagé par la saisie texte et le vocal.
 */
export async function captureNote(ctx, texte) {
  const userId = ctx.from.id;
  const capture = getCapture(userId);
  clearCapture(userId);

  const propre = (texte || '').trim();
  if (!propre) return ctx.reply('🗒️ Note vide, rien enregistré.');

  if (capture?.attend === 'edition' && capture.id) {
    const note = await updateNoteById(capture.id, { note: propre });
    return ctx.reply(
      `✏️ <b>Note ${note.id} mise à jour</b>\n\n${escapeHtml(propre)}`,
      { parse_mode: 'HTML' }
    );
  }

  const note = await appendNote(propre);
  return confirmerNote(ctx, note);
}

// ─── /note : créer une note ───────────────────────────────────
export async function handleNote(ctx) {
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return ctx.reply('⛔ Accès non autorisé.');

  const texte = (ctx.message.text || '').replace(/^\/\S+\s*/, '').trim();
  try {
    if (texte) return await captureNote(ctx, texte);

    setCapture(userId, { attend: 'creation' });
    await ctx.reply(
      '🗒️ <b>Nouvelle note</b>\n\nÉcris-la, ou envoie un vocal — je la transcris et je l\'enregistre.',
      { parse_mode: 'HTML' }
    );
  } catch (err) {
    console.error('[handleNote]', err);
    await ctx.reply(`❌ Erreur : ${err.message}`);
  }
}

// ─── /notes : consulter et agir ───────────────────────────────
export async function handleNotes(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    const notes = await listNotes();
    if (notes.length === 0) {
      return ctx.reply(
        '🗒️ Aucune note pour le moment.\n\nUtilise <code>/note</code> pour en créer une.',
        { parse_mode: 'HTML' }
      );
    }

    const lines = [`🗒️ <b>${notes.length} note${notes.length > 1 ? 's' : ''}</b>\n`];
    const buttonRows = [];
    for (const n of notes) {
      lines.push(
        `${STATUT_EMOJI[n.statut] || '•'} <b>${n.id}</b> · ${fmtDate(n.date)}\n${escapeHtml(n.note)}`
      );
      lines.push('');
      const row = [
        Markup.button.callback(`✏️ ${n.id}`, `noteedit_${n.id}`),
        Markup.button.callback('✅ Traitée', `notedel_${n.id}`),
      ];
      if (n.statut !== 'en cours') {
        row.splice(1, 0, Markup.button.callback('⏳', `notecours_${n.id}`));
      }
      buttonRows.push(row);
    }

    await ctx.reply(lines.join('\n').trim(), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttonRows),
    });
  } catch (err) {
    console.error('[handleNotes]', err);
    await ctx.reply(`❌ Erreur : ${err.message}`);
  }
}

// ─── Callbacks ────────────────────────────────────────────────
export async function handleNoteEdit(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  setCapture(ctx.from.id, { attend: 'edition', id });
  await ctx.answerCbQuery();
  await ctx.reply(
    `✏️ Envoie le nouveau texte de la note <b>${id}</b> (écrit ou vocal).`,
    { parse_mode: 'HTML' }
  );
}

export async function handleNoteEnCours(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  try {
    await updateNoteById(id, { statut: 'en cours' });
    await ctx.answerCbQuery(`⏳ ${id} en cours`);
    await ctx.reply(`⏳ Note <b>${id}</b> marquée « en cours ».`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleNoteEnCours]', err);
    await ctx.answerCbQuery('Erreur');
    await ctx.reply(`❌ ${err.message}`);
  }
}

/** ✅ Traitée → demande confirmation, car la suppression est définitive. */
export async function handleNoteDelete(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(
    `🗑️ Supprimer définitivement la note <b>${id}</b> ?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Oui, supprimer', `notedelok_${id}`),
          Markup.button.callback('❌ Annuler', 'notecancel'),
        ],
      ]),
    }
  );
}

export async function handleNoteDeleteConfirm(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const id = ctx.match[1];
  try {
    await deleteNoteById(id);
    await ctx.answerCbQuery('Supprimée');
    await ctx.editMessageReplyMarkup(null).catch(() => {});
    await ctx.reply(`✅ Note <b>${id}</b> traitée et supprimée.`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleNoteDeleteConfirm]', err);
    await ctx.answerCbQuery('Erreur');
    await ctx.reply(`❌ ${err.message}`);
  }
}

export async function handleNoteCancel(ctx) {
  await ctx.answerCbQuery('Annulé');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
}

/**
 * Intercepte le texte libre quand une note est en attente de saisie.
 * À appeler en tête de handleText, avant l'assistant financier.
 * @returns {Promise<boolean>} true si le message a été consommé
 */
export async function tryHandleNoteText(ctx) {
  const userId = ctx.from.id;
  if (!isAuthorized(userId)) return false;
  if (!getCapture(userId)) return false;

  try {
    await captureNote(ctx, ctx.message.text);
  } catch (err) {
    console.error('[tryHandleNoteText]', err);
    clearCapture(userId);
    await ctx.reply(`❌ Erreur d'enregistrement : ${err.message}`);
  }
  return true;
}
