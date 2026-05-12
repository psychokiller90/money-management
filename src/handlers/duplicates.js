import { Markup } from 'telegraf';
import { findDuplicateGroups, deleteExpenses } from '../sheets.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

let _kc = 0;
function newKey() {
  _kc = (_kc + 1) % 1000;
  return ('d' + Date.now().toString(36) + _kc.toString(36)).slice(-9);
}

function setSession(k, s) {
  s.updatedAt = Date.now();
  sessions.set(k, s);
}
function getSession(k) {
  const s = sessions.get(k);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    sessions.delete(k);
    return null;
  }
  return s;
}
function clearSession(k) {
  sessions.delete(k);
}

function isAuthorized(uid) {
  return String(uid) === String(process.env.TELEGRAM_ADMIN_ID);
}

function fmtAmt(n) {
  return Number(n).toFixed(2).replace('.', ',') + ' €';
}
function fmtDate(d) {
  if (!d) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function formatGroup(group) {
  const lines = [];
  group.forEach((e, i) => {
    lines.push(`<b>${i + 1}.</b> ${fmtDate(e.date)} — ${e.enseigne} — ${fmtAmt(e.montant)}`);
    lines.push(`   <i>${e.categorie}${e.designation ? ' · ' + e.designation : ''}</i> [ligne ${e.rowIndex}]`);
  });
  return lines.join('\n');
}

/**
 * Décrémente les rowIndex de toutes les entrées des autres groupes situées
 * APRÈS la ligne supprimée (la suppression physique décale les indices).
 */
function decrementRowIndicesAfter(session, deletedRowIndex) {
  for (const group of session.groups) {
    for (const e of group) {
      if (e.rowIndex > deletedRowIndex) e.rowIndex--;
    }
  }
}

// ─── /doublons [tolérance] : flow interactif ─────────────────
export async function handleDoublons(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  const arg = (ctx.message.text || '').split(' ')[1];
  const tol = arg && /^\d+$/.test(arg) ? Number(arg) : 0;
  if (tol > 30) return ctx.reply('⚠️ Tolérance max : 30 jours.');

  await ctx.reply(`⏳ Recherche en cours (tolérance ±${tol}j)...`);

  try {
    const groups = await findDuplicateGroups({ toleranceDays: tol });
    if (groups.length === 0) {
      return ctx.reply(`✅ Aucun doublon détecté avec une tolérance de ±${tol} jour(s).`);
    }

    const totalDups = groups.reduce((s, g) => s + g.length, 0);
    const key = newKey();
    setSession(key, {
      userId: ctx.from.id,
      groups,
      currentIdx: 0,
      tolerance: tol,
      stats: { kept: 0, deleted: 0, skipped: 0 },
    });

    await ctx.reply(
      `🔁 <b>${groups.length} groupe(s) de doublons</b> — ${totalDups} entrées concernées (tolérance ±${tol}j)\n\nRevue une par une.`,
      { parse_mode: 'HTML' }
    );
    return showGroup(ctx, key);
  } catch (err) {
    console.error('[handleDoublons]', err);
    return ctx.reply(`❌ ${err.message}`);
  }
}

async function showGroup(ctx, key) {
  const s = getSession(key);
  if (!s) return ctx.reply('Session expirée.');

  if (s.currentIdx >= s.groups.length) {
    clearSession(key);
    const { kept, deleted, skipped } = s.stats;
    return ctx.reply(
      `✅ <b>Revue terminée</b>\n\n` +
        `• 🗑️ ${deleted} supprimée(s)\n` +
        `• ✅ ${kept} conservée(s)\n` +
        `• ⏭️ ${skipped} ignorée(s)`,
      { parse_mode: 'HTML' }
    );
  }

  const group = s.groups[s.currentIdx];
  const text =
    `🔁 <b>Groupe ${s.currentIdx + 1}/${s.groups.length}</b>\n\n${formatGroup(group)}\n\n` +
    `Que faire ?`;

  const buttons = group.map((e, i) => [
    Markup.button.callback(`🗑️ Supprimer #${i + 1} (ligne ${e.rowIndex})`, `dupdel_${key}_${i}`),
  ]);
  buttons.push([
    Markup.button.callback('✅ Garder tout', `dupkeep_${key}`),
    Markup.button.callback('⏭️ Ignorer', `dupskip_${key}`),
  ]);
  buttons.push([Markup.button.callback('🛑 Arrêter', `dupstop_${key}`)]);

  await ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
}

export async function handleDupDel(ctx) {
  const key = ctx.match[1];
  const idx = Number(ctx.match[2]);
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');

  const group = s.groups[s.currentIdx];
  const target = group?.[idx];
  if (!target) return ctx.answerCbQuery('Introuvable.');

  await ctx.answerCbQuery('Suppression...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});

  try {
    await deleteExpenses([target.rowIndex]);
    s.stats.deleted++;
    decrementRowIndicesAfter(s, target.rowIndex);

    // Retire l'entrée du groupe en cours
    group.splice(idx, 1);

    if (group.length >= 2) {
      // Il reste encore des candidats dans ce groupe → on rejoue la sélection
      await ctx.reply(`✅ Ligne ${target.rowIndex} supprimée. ${group.length} entrées restent dans ce groupe.`);
      setSession(key, s);
      return showGroup(ctx, key);
    }

    // Une seule entrée restante → groupe résolu, on passe au suivant
    if (group.length === 1) s.stats.kept++;
    s.currentIdx++;
    setSession(key, s);
    return showGroup(ctx, key);
  } catch (err) {
    console.error('[handleDupDel]', err);
    return ctx.reply(`❌ ${err.message}`);
  }
}

export async function handleDupKeep(ctx) {
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Conservés');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  s.stats.kept += s.groups[s.currentIdx]?.length || 0;
  s.currentIdx++;
  setSession(key, s);
  return showGroup(ctx, key);
}

export async function handleDupSkip(ctx) {
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Ignoré');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  s.stats.skipped += s.groups[s.currentIdx]?.length || 0;
  s.currentIdx++;
  setSession(key, s);
  return showGroup(ctx, key);
}

export async function handleDupStop(ctx) {
  const key = ctx.match[1];
  const s = getSession(key);
  await ctx.answerCbQuery('Arrêté');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  if (s) {
    const { kept, deleted, skipped } = s.stats;
    await ctx.reply(
      `🛑 <b>Revue interrompue</b>\n\n` +
        `• 🗑️ ${deleted} supprimée(s)\n` +
        `• ✅ ${kept} conservée(s)\n` +
        `• ⏭️ ${skipped} ignorée(s)`,
      { parse_mode: 'HTML' }
    );
  }
  clearSession(key);
}

// ─── /dedupe : auto-suppression stricte ─────────────────────
export async function handleDedupe(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  await ctx.reply('⏳ Recherche de doublons stricts (date + enseigne + montant + catégorie + désignation)...');

  try {
    const groups = await findDuplicateGroups({ toleranceDays: 0, strict: true });
    if (groups.length === 0) {
      return ctx.reply('✅ Aucun doublon strict trouvé.');
    }

    const toDelete = [];
    const previewLines = [];
    for (const group of groups) {
      const sortedGroup = [...group].sort((a, b) => a.rowIndex - b.rowIndex);
      const kept = sortedGroup[0];
      const removes = sortedGroup.slice(1);
      previewLines.push(
        `• ${fmtDate(kept.date)} — ${kept.enseigne} — ${fmtAmt(kept.montant)} (×${group.length}, garde ligne ${kept.rowIndex})`
      );
      removes.forEach((r) => toDelete.push(r.rowIndex));
    }

    const shown = previewLines.slice(0, 15).join('\n');
    const more = previewLines.length > 15 ? `\n<i>… et ${previewLines.length - 15} autre(s) groupe(s)</i>` : '';

    const key = newKey();
    setSession(key, { userId: ctx.from.id, toDelete });

    await ctx.reply(
      `🔁 <b>${groups.length} groupe(s) de doublons stricts</b>\n` +
        `${toDelete.length} ligne(s) à supprimer (la 1ère occurrence est conservée).\n\n${shown}${more}\n\nConfirmer ?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback(`🗑️ Supprimer ${toDelete.length} ligne(s)`, `dedupok_${key}`)],
          [Markup.button.callback('❌ Annuler', `dedupcancel_${key}`)],
        ]),
      }
    );
  } catch (err) {
    console.error('[handleDedupe]', err);
    return ctx.reply(`❌ ${err.message}`);
  }
}

export async function handleDedupOk(ctx) {
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Suppression...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  try {
    await deleteExpenses(s.toDelete);
    const n = s.toDelete.length;
    clearSession(key);
    await ctx.reply(`✅ ${n} doublon(s) supprimé(s).`);
  } catch (err) {
    console.error('[handleDedupOk]', err);
    return ctx.reply(`❌ ${err.message}`);
  }
}

export async function handleDedupCancel(ctx) {
  const key = ctx.match[1];
  clearSession(key);
  await ctx.answerCbQuery('Annulé.');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('🚫 Annulé.');
}
