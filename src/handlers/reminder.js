import { listExpenses, loadEcheances } from '../sheets.js';
import { computeEcheanceProgress } from './echeances.js';

const DAY_MS = 86400 * 1000;

/**
 * Vérifie si l'utilisateur n'a rien scanné depuis N jours et envoie un rappel le cas échéant.
 * Appelé par un cron externe (cron-job.org, GitHub Actions...) sur l'endpoint /cron/reminder?secret=...
 */
export async function checkAndRemind(bot) {
  const seuilJours = Number(process.env.REMINDER_DAYS || 3);
  const adminId = process.env.TELEGRAM_ADMIN_ID;
  if (!adminId) return { sent: false, reason: 'no_admin_id' };

  const expenses = await listExpenses();
  if (expenses.length === 0) {
    await bot.telegram.sendMessage(
      adminId,
      `📸 Tu n'as encore enregistré aucune dépense via le bot. Envoie-moi une photo de facture quand tu veux !`
    );
    return { sent: true, reason: 'empty' };
  }

  const lastDate = expenses
    .map((e) => e.date?.getTime())
    .filter(Boolean)
    .reduce((a, b) => Math.max(a, b), 0);

  const ageJours = Math.floor((Date.now() - lastDate) / DAY_MS);

  if (ageJours >= seuilJours) {
    await bot.telegram.sendMessage(
      adminId,
      `📸 <b>Pense à scanner tes factures !</b>\n\nTa dernière dépense enregistrée date d'il y a <b>${ageJours} jours</b>.`,
      { parse_mode: 'HTML' }
    );
    return { sent: true, ageJours };
  }
  return { sent: false, ageJours };
}

/**
 * Vérifie les plans de paiement en plusieurs fois (onglet `Échéances`) et
 * envoie un rappel Telegram pour chaque échéance non payée dans les 3 jours
 * (J-3 à J inclus). Appelé par le même cron externe que checkAndRemind.
 */
export async function checkEcheances(bot) {
  const adminId = process.env.TELEGRAM_ADMIN_ID;
  if (!adminId) return { sent: false, reason: 'no_admin_id' };

  const [plans, expenses] = await Promise.all([loadEcheances(), listExpenses()]);
  const today = new Date();
  const todayUTC = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const dues = [];
  for (const plan of plans.filter((p) => p.actif)) {
    const { payees, restantes, prochaine } = computeEcheanceProgress(plan, expenses);
    if (restantes === 0 || !prochaine) continue;
    const joursRestants = Math.round((prochaine.getTime() - todayUTC.getTime()) / DAY_MS);
    if (joursRestants >= 0 && joursRestants <= 3) {
      dues.push({ plan, numero: payees + 1, joursRestants });
    }
  }

  for (const { plan, numero, joursRestants } of dues) {
    const delaiTxt = joursRestants === 0 ? "aujourd'hui" : `dans ${joursRestants} jour${joursRestants > 1 ? 's' : ''}`;
    await bot.telegram.sendMessage(
      adminId,
      `💳 <b>Échéance ${numero}/${plan.nombreFois} — ${plan.nom}</b>\n\n` +
        `${plan.montantEcheance.toFixed(2).replace('.', ',')} € à payer ${delaiTxt}.`,
      { parse_mode: 'HTML' }
    );
  }

  return { sent: dues.length > 0, count: dues.length };
}
