import { listExpenses } from '../sheets.js';

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
