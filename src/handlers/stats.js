import { listExpenses } from '../db.js';
import { loadGlobalView } from '../sheets.js'; // transitoire jusqu'à phase 6

const CAT_EMOJI = {
  Courses: '🛒',
  Imprevus: '⚡',
  Factures: '🏠',
  Abonnements: '📱',
  Jumeaux: '👶',
};

const MOIS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function fmtAmount(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function aggregate(expenses) {
  const total = expenses.reduce((s, e) => s + e.montant, 0);
  const byCat = {};
  const byEnseigne = {};
  for (const e of expenses) {
    byCat[e.categorie] = (byCat[e.categorie] || 0) + e.montant;
    if (!byEnseigne[e.enseigne]) byEnseigne[e.enseigne] = { count: 0, total: 0 };
    byEnseigne[e.enseigne].count += 1;
    byEnseigne[e.enseigne].total += e.montant;
  }
  return { total, byCat, byEnseigne };
}

function formatReport(title, expenses) {
  if (expenses.length === 0) {
    return `📊 <b>${title}</b>\n\nAucune dépense sur cette période.`;
  }
  const { total, byCat, byEnseigne } = aggregate(expenses);
  const lines = [
    `📊 <b>${title}</b>\n`,
    `💶 Total : <b>${fmtAmount(total)}</b>`,
    `📦 ${expenses.length} dépense${expenses.length > 1 ? 's' : ''}\n`,
    '<b>Par catégorie :</b>',
  ];
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  for (const [cat, amount] of cats) {
    const pct = ((amount / total) * 100).toFixed(0);
    lines.push(`${CAT_EMOJI[cat] || '•'} ${cat} : ${fmtAmount(amount)} (${pct}%)`);
  }
  lines.push('\n<b>Top 5 enseignes :</b>');
  const top = Object.entries(byEnseigne)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 5);
  for (const [name, { count, total: t }] of top) {
    lines.push(`• ${name} — ${count}× — ${fmtAmount(t)}`);
  }
  return lines.join('\n');
}

function rangeMonth(year, month0) {
  const start = new Date(Date.UTC(year, month0, 1));
  const end = new Date(Date.UTC(year, month0 + 1, 1));
  return { start, end };
}

function filterRange(expenses, start, end) {
  return expenses.filter((e) => e.date && e.date >= start && e.date < end);
}

async function withErrorHandling(ctx, fn) {
  if (!isAuthorized(ctx.from.id)) {
    return ctx.reply('⛔ Accès non autorisé.');
  }
  try {
    await fn();
  } catch (err) {
    console.error('[stats]', err);
    await ctx.reply(
      `❌ <b>Erreur lors de la lecture du Sheet</b>\n\n<code>${err.message}</code>\n\nVérifie que :\n• Le Sheet est partagé avec le service account\n• L'API Google Sheets est activée\n• Le SPREADSHEET_ID est correct`,
      { parse_mode: 'HTML' }
    );
  }
}

export async function handleStats(ctx) {
  await withErrorHandling(ctx, async () => {
    const v = await loadGlobalView();
    const fmt = (x) => (x !== null && x !== undefined && String(x).trim() !== '' ? x : '—');
    const now = new Date();
    const moisAnnee = `${MOIS_FR[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const header = v.monthFound
      ? `📊 <b>Vue globale — ${moisAnnee}</b>`
      : `📊 <b>Vue globale</b>\n<i>(⚠️ "${moisAnnee}" introuvable dans le Sheet, valeurs par défaut)</i>`;
    const lines = [
      header,
      '',
      `⚡ Imprévus           : <b>${fmt(v.imprevus)}</b>`,
      `📊 Total dépenses     : <b>${fmt(v.totalDepenses)}</b>`,
      `🎯 Objectif épargne   : <b>${fmt(v.objectifEpargne)}</b>`,
      `💳 Solde restant      : <b>${fmt(v.soldeRestant)}</b>`,
      '',
      '<i>Pour le détail des dépenses : /mois</i>',
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}

export async function handleSemaine(ctx) {
  await withErrorHandling(ctx, async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400 * 1000);
    const all = await listExpenses();
    const expenses = filterRange(all, start, end);
    await ctx.reply(formatReport('7 derniers jours', expenses), { parse_mode: 'HTML' });
  });
}

export async function handleMois(ctx) {
  await withErrorHandling(ctx, async () => {
    const arg = ctx.message.text.split(' ')[1];
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
    const { start, end } = rangeMonth(year, month0);
    const all = await listExpenses();
    const expenses = filterRange(all, start, end);
    const title = `${MOIS_FR[month0]} ${year}`;
    await ctx.reply(formatReport(title, expenses), { parse_mode: 'HTML' });
  });
}
