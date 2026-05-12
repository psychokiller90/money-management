import { Markup } from 'telegraf';
import { listExpenses, deleteExpense } from '../db.js';
import { startEditExisting } from './photo.js';

const SESSION_TTL_MS = 15 * 60 * 1000;

// key → { userId, id, expense, updatedAt }
const expenseSessions = new Map();

let _keyCounter = 0;
function newKey() {
  _keyCounter = (_keyCounter + 1) % 1000;
  return ('e' + Date.now().toString(36) + _keyCounter.toString(36)).slice(-9);
}

function setSession(key, sess) {
  sess.updatedAt = Date.now();
  expenseSessions.set(key, sess);
}
function getSession(key) {
  const s = expenseSessions.get(key);
  if (!s) return null;
  if (Date.now() - s.updatedAt > SESSION_TTL_MS) {
    expenseSessions.delete(key);
    return null;
  }
  return s;
}
function clearSession(key) {
  expenseSessions.delete(key);
}

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function fmtAmount(n) {
  return Number(n).toFixed(2).replace('.', ',') + ' €';
}

function fmtDate(d) {
  if (!d) return '—';
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function formatExpenseLine(idx, e) {
  const parts = [
    `<b>${idx}.</b> ${fmtDate(e.date)} — ${e.enseigne} — ${fmtAmount(e.montant)}`,
    `   <i>${e.categorie}${e.designation ? ` · ${e.designation}` : ''}</i>`,
  ];
  return parts.join('\n');
}

// ─── /derniere : 5 dernières dépenses ─────────────────────────
export async function handleDerniere(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    const all = await listExpenses(true);
    if (all.length === 0) return ctx.reply('ℹ️ Aucune dépense enregistrée.');

    const sorted = [...all]
      .filter((e) => e.date)
      .sort((a, b) => b.date.getTime() - a.date.getTime() || (b.id || '').localeCompare(a.id || ''))
      .slice(0, 5);

    const lines = ['🕐 <b>5 dernières dépenses</b>\n'];
    const buttonRows = [];
    sorted.forEach((e, i) => {
      const idx = i + 1;
      lines.push(formatExpenseLine(idx, e));
      lines.push('');
      const key = newKey();
      setSession(key, { userId: ctx.from.id, id: e.id, expense: e });
      buttonRows.push([
        Markup.button.callback(`✏️ #${idx}`, `expmod_${key}`),
        Markup.button.callback(`🗑️ #${idx}`, `expdel_${key}`),
      ]);
    });
    await ctx.reply(lines.join('\n').trim(), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttonRows),
    });
  } catch (err) {
    console.error('[handleDerniere]', err);
    await ctx.reply(`❌ Erreur lecture : ${err.message}`);
  }
}

// ─── /cherche <terme> : recherche texte ──────────────────────
export async function handleCherche(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');

  const text = ctx.message.text || '';
  const query = text.replace(/^\/\S+\s*/, '').trim().toLowerCase();
  if (!query) {
    return ctx.reply(
      'ℹ️ Usage : <code>/cherche &lt;terme&gt;</code>\n\nEx : <code>/cherche carrefour</code>',
      { parse_mode: 'HTML' }
    );
  }

  try {
    const all = await listExpenses(true);
    const matches = all.filter((e) => {
      const blob = `${e.categorie} ${e.enseigne} ${e.designation}`.toLowerCase();
      return blob.includes(query);
    });
    if (matches.length === 0) {
      return ctx.reply(`🔎 Aucune dépense ne correspond à « ${query} ».`);
    }
    const sorted = [...matches]
      .filter((e) => e.date)
      .sort((a, b) => b.date.getTime() - a.date.getTime());

    const total = sorted.reduce((s, e) => s + e.montant, 0);
    const shown = sorted.slice(0, 20);
    const lines = [
      `🔎 <b>« ${query} »</b> — ${matches.length} résultat${matches.length > 1 ? 's' : ''} (${fmtAmount(total)})\n`,
    ];
    shown.forEach((e, i) => {
      lines.push(formatExpenseLine(i + 1, e));
    });
    if (sorted.length > shown.length) {
      lines.push('');
      lines.push(`<i>… ${sorted.length - shown.length} autre${sorted.length - shown.length > 1 ? 's' : ''} dépense${sorted.length - shown.length > 1 ? 's' : ''}.</i>`);
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleCherche]', err);
    await ctx.reply(`❌ Erreur lecture : ${err.message}`);
  }
}

// ─── Callback supprimer ──────────────────────────────────────
export async function handleExpDel(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply(
    `⚠️ Confirmer la suppression de :\n\n${formatExpenseLine(0, s.expense).replace('<b>0.</b> ', '')}`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ Supprimer', `expdelok_${key}`)],
        [Markup.button.callback('❌ Annuler', `expcancel_${key}`)],
      ]),
    }
  );
}

export async function handleExpDelConfirm(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery('Suppression...');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  try {
    await deleteExpense(s.id);
    clearSession(key);
    const shortId = (s.id || '').slice(0, 8);
    await ctx.reply(`✅ Dépense supprimée (<code>#${shortId}</code>).`, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[deleteExpense]', err);
    await ctx.reply(`❌ Erreur suppression : ${err.message}`);
  }
}

// ─── Callback modifier ───────────────────────────────────────
export async function handleExpMod(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.answerCbQuery('⛔');
  const key = ctx.match[1];
  const s = getSession(key);
  if (!s) return ctx.answerCbQuery('Session expirée.');
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  try {
    await startEditExisting(ctx, ctx.from.id, s.expense);
    clearSession(key);
  } catch (err) {
    console.error('[handleExpMod]', err);
    await ctx.reply(`❌ Erreur édition : ${err.message}`);
  }
}

export async function handleExpCancel(ctx) {
  const key = ctx.match[1];
  clearSession(key);
  await ctx.answerCbQuery('Annulé.');
  await ctx.editMessageReplyMarkup(null).catch(() => {});
  await ctx.reply('🚫 Annulé.');
}

// ─── /graph : camembert mensuel via QuickChart ───────────────
const COLORS = [
  '#4F46E5', '#06B6D4', '#10B981', '#F59E0B', '#EF4444',
  '#EC4899', '#8B5CF6', '#84CC16', '#F97316', '#14B8A6',
];
const MOIS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

export async function handleGraph(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    const arg = (ctx.message.text || '').split(' ')[1];
    let year, month0;
    if (arg && /^\d{4}-\d{2}$/.test(arg)) {
      const [y, m] = arg.split('-').map(Number);
      year = y;
      month0 = m - 1;
    } else {
      const now = new Date();
      year = now.getUTCFullYear();
      month0 = now.getUTCMonth();
    }
    const start = new Date(Date.UTC(year, month0, 1));
    const end = new Date(Date.UTC(year, month0 + 1, 1));
    const all = await listExpenses(true);
    const expenses = all.filter((e) => e.date && e.date >= start && e.date < end);
    if (expenses.length === 0) {
      return ctx.reply(`ℹ️ Aucune dépense pour ${MOIS_FR[month0]} ${year}.`);
    }
    const byCat = {};
    let total = 0;
    for (const e of expenses) {
      byCat[e.categorie] = (byCat[e.categorie] || 0) + e.montant;
      total += e.montant;
    }
    const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
    const labels = entries.map(([c]) => c);
    const data = entries.map(([, v]) => Number(v.toFixed(2)));

    const config = {
      type: 'doughnut',
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: COLORS.slice(0, labels.length),
            borderWidth: 1,
            borderColor: '#fff',
          },
        ],
      },
      options: {
        plugins: {
          title: {
            display: true,
            text: `${MOIS_FR[month0]} ${year} — ${total.toFixed(2).replace('.', ',')} €`,
            font: { size: 16, weight: 'bold' },
          },
          legend: { position: 'right', labels: { font: { size: 12 } } },
          datalabels: {
            color: '#fff',
            font: { weight: 'bold', size: 12 },
            formatter: (value) => `${value.toFixed(0)} €`,
          },
        },
      },
    };

    const url = `https://quickchart.io/chart?bkg=white&w=600&h=400&c=${encodeURIComponent(JSON.stringify(config))}`;
    if (url.length > 2000) {
      // Trop long pour GET → POST
      const res = await fetch('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chart: config, width: 600, height: 400, backgroundColor: 'white' }),
      });
      const json = await res.json();
      if (!json.url) throw new Error('QuickChart: pas d\'URL retournée');
      await ctx.replyWithPhoto({ url: json.url }, {
        caption: `📊 ${MOIS_FR[month0]} ${year} — ${total.toFixed(2).replace('.', ',')} €`,
      });
    } else {
      await ctx.replyWithPhoto({ url }, {
        caption: `📊 ${MOIS_FR[month0]} ${year} — ${total.toFixed(2).replace('.', ',')} €`,
      });
    }
  } catch (err) {
    console.error('[handleGraph]', err);
    await ctx.reply(`❌ Erreur génération graphique : ${err.message}`);
  }
}
