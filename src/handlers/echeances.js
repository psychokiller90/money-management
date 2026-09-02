import { listExpenses, loadEcheances, listProductDetails } from '../sheets.js';

function isAuthorized(userId) {
  return String(userId) === String(process.env.TELEGRAM_ADMIN_ID);
}

function fmtAmount(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

function normalizeStr(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function fmtDate(d) {
  if (!d) return '—';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

const MOIS_FR = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre',
];

/**
 * Calcule la progression d'un plan de paiement en plusieurs fois : nombre
 * d'échéances déjà réglées (une dépense correspondante max par mois
 * calendaire, pour ne pas compter un doublon comme 2 échéances), le nombre
 * restant, et la date de la prochaine échéance non payée.
 * @param {{nom:string, montantEcheance:number, nombreFois:number, jourDuMois:number|null, dateDebut:Date}} plan
 * @param {Array} expenses  sortie de listExpenses()
 */
export function computeEcheanceProgress(plan, expenses) {
  const target = normalizeStr(plan.nom);
  const matches = expenses.filter((e) => {
    if (!e.date || e.date < plan.dateDebut) return false;
    if (Math.abs(e.montant - plan.montantEcheance) > 0.01) return false;
    return normalizeStr(e.enseigne) === target;
  });

  const moisVus = new Set(matches.map((e) => `${e.date.getUTCFullYear()}-${e.date.getUTCMonth()}`));
  const payees = Math.min(moisVus.size, plan.nombreFois);
  const restantes = Math.max(plan.nombreFois - payees, 0);

  let prochaine = null;
  if (restantes > 0) {
    prochaine = new Date(Date.UTC(
      plan.dateDebut.getUTCFullYear(),
      plan.dateDebut.getUTCMonth() + payees,
      plan.jourDuMois || plan.dateDebut.getUTCDate()
    ));
  }
  return { payees, restantes, prochaine };
}

/**
 * Construit le message de suivi des paiements en plusieurs fois.
 * Réutilisé par la commande /echeances ET l'assistant (texte/vocal).
 * @param {string} [nomFiltre]  Si fourni, ne renvoie que le plan correspondant
 * @returns {Promise<string>} message HTML prêt à envoyer (sans préfixe 🤖)
 */
export async function buildEcheancesReport(nomFiltre) {
  const [plans, expenses] = await Promise.all([loadEcheances(), listExpenses()]);
  let actifs = plans.filter((p) => p.actif);

  if (actifs.length === 0) {
    return "💳 Aucune échéance active pour le moment.\n\nAjoute un plan de paiement dans l'onglet « Échéances » du Sheet pour le suivre ici.";
  }

  if (nomFiltre) {
    const cible = normalizeStr(nomFiltre);
    const filtres = actifs.filter(
      (p) => normalizeStr(p.nom).includes(cible) || cible.includes(normalizeStr(p.nom))
    );
    if (filtres.length === 0) {
      return `💳 Aucune échéance active ne correspond à « ${nomFiltre} ».\n\nPlans en cours : ${actifs
        .map((p) => p.nom)
        .join(', ')}.`;
    }
    actifs = filtres;
  }

  const lines = ['💳 <b>Paiements en plusieurs fois</b>\n'];
  let totalRestant = 0;
  for (const plan of actifs) {
    const { payees, restantes, prochaine } = computeEcheanceProgress(plan, expenses);
    if (restantes === 0) {
      lines.push(`✅ <b>${plan.nom}</b> — terminé (${plan.nombreFois}/${plan.nombreFois})`);
    } else {
      totalRestant += restantes * plan.montantEcheance;
      lines.push(
        `🔸 <b>${plan.nom}</b> — ${payees}/${plan.nombreFois} payées, ${restantes} restante${restantes > 1 ? 's' : ''}\n` +
          `   ${fmtAmount(plan.montantEcheance)} · prochaine le ${fmtDate(prochaine)}`
      );
    }
  }
  if (totalRestant > 0) {
    lines.push(`\n💶 <b>Reste à payer au total : ${fmtAmount(totalRestant)}</b>`);
  }
  return lines.join('\n');
}

export async function handleEcheances(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    await ctx.reply(await buildEcheancesReport(), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleEcheances]', err);
    await ctx.reply(`❌ <b>Erreur</b>\n\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}

/** « 2 (soit 386 unités) — 1 achat », ou juste « 3 — 2 achats » si le contenu est inconnu. */
function fmtQuantite(item) {
  const achats = `${item.achats} achat${item.achats > 1 ? 's' : ''}`;
  const contenu = item.unites > 0 ? ` (soit ${item.unites} unités)` : '';
  return `<b>${item.quantite}</b>${contenu} — ${achats}`;
}

/**
 * Convertit la période comprise par l'IA en 'YYYY-MM'.
 * Les périodes non mensuelles (semaine, tout) retombent sur le mois courant.
 */
export function periodToMonthArg(period) {
  if (!period) return undefined;
  if (period.kind === 'month' && period.year && period.month) {
    return `${period.year}-${String(period.month).padStart(2, '0')}`;
  }
  if (period.start && /^\d{4}-\d{2}/.test(period.start)) return period.start.slice(0, 7);
  return undefined;
}

/**
 * Construit le rapport des quantités achetées sur un mois.
 * Réutilisé par la commande /quantites ET l'assistant (texte/vocal).
 * @param {string} [produitFiltre]  Ne garder qu'un produit (ex: "couches")
 * @param {string} [monthArg]  'YYYY-MM' (défaut : mois courant)
 * @returns {Promise<string>} message HTML prêt à envoyer (sans préfixe 🤖)
 */
export async function buildQuantitesReport(produitFiltre, monthArg) {
  const items = await listProductDetails(monthArg);

  const now = new Date();
  const [year, month0] = monthArg && /^\d{4}-\d{2}$/.test(monthArg)
    ? [Number(monthArg.slice(0, 4)), Number(monthArg.slice(5, 7)) - 1]
    : [now.getUTCFullYear(), now.getUTCMonth()];
  const title = `${MOIS_FR[month0]} ${year}`;

  if (produitFiltre) {
    const cible = normalizeStr(produitFiltre);
    const retenus = items.filter((i) => {
      const nom = normalizeStr(i.nom);
      return nom.includes(cible) || cible.includes(nom);
    });
    if (retenus.length === 0) {
      const dispo = items.length
        ? `\n\nProduits enregistrés ce mois-ci : ${items.map((i) => i.nom).join(', ')}.`
        : '';
      return `📦 Aucun achat de « ${produitFiltre} » enregistré en ${title}.${dispo}`;
    }
    return [`📦 <b>${title}</b>\n`, ...retenus.map((i) => `• ${i.nom} : ${fmtQuantite(i)}`)].join('\n');
  }

  if (items.length === 0) {
    return `📦 <b>Quantités — ${title}</b>\n\nAucun produit détaillé enregistré ce mois-ci.`;
  }
  return [
    `📦 <b>Quantités — ${title}</b>\n`,
    ...items.map((i) => `• ${i.nom} : ${fmtQuantite(i)}`),
  ].join('\n');
}

export async function handleQuantites(ctx) {
  if (!isAuthorized(ctx.from.id)) return ctx.reply('⛔ Accès non autorisé.');
  try {
    const arg = ctx.message.text.split(' ')[1];
    const monthArg = arg && /^\d{4}-\d{2}$/.test(arg) ? arg : undefined;
    await ctx.reply(await buildQuantitesReport(undefined, monthArg), { parse_mode: 'HTML' });
  } catch (err) {
    console.error('[handleQuantites]', err);
    await ctx.reply(`❌ <b>Erreur</b>\n\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
  }
}
