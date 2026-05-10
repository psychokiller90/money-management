import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import {
  handlePhoto,
  handleDocument,
  handleCategory,
  handleCategoryNew,
  handleEnseigne,
  handleEnseigneNew,
  handleDesignationSkip,
  handleDesignationInput,
  handleForceDuplicate,
  handleConfirm,
  handleCancel,
  handleEdit,
  handleEditField,
  handleBatchAll,
  handleBatchSeq,
  handleBatchInclude,
  handleText,
} from './handlers/photo.js';
import { handleStats, handleSemaine, handleMois } from './handlers/stats.js';
import {
  handleDerniere,
  handleCherche,
  handleGraph,
  handleExpDel,
  handleExpDelConfirm,
  handleExpMod,
  handleExpCancel,
} from './handlers/expense.js';
import {
  handleCategories,
  handleAddEnseigne,
  handleDelEnseigne,
  handleRenameEnseigne,
  handleAddCategorie,
  handleDelCategorie,
  handleRenameCategorie,
  handleAdminCat,
  handleAdminEns,
  handleAdminDelConfirm,
  handleAdminCatPick,
  handleAdminDelCatConfirm,
  handleAdminCancel,
} from './handlers/admin.js';
import {
  handleDoublons,
  handleDedupe,
  handleDupDel,
  handleDupKeep,
  handleDupSkip,
  handleDupStop,
  handleDedupOk,
  handleDedupCancel,
} from './handlers/duplicates.js';
import { checkAndRemind } from './handlers/reminder.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Commandes ──────────────────────────────────────────────
bot.start((ctx) =>
  ctx.reply(
    '👋 <b>ExpenseBot</b>\n\n' +
      'Envoie-moi une photo de ta facture ou ticket de caisse.\n' +
      "Je l'analyse et l'insère dans ton Google Sheets.\n\n" +
      'Commandes : /stats /semaine /mois /help',
    { parse_mode: 'HTML' }
  )
);

bot.help((ctx) =>
  ctx.reply(
    '📖 <b>Guide complet</b>\n\n' +
      '<b>📸 Saisie de dépense</b>\n' +
      '• Envoie une <b>photo</b> ou un <b>PDF</b> de facture\n' +
      '• L\'IA détecte catégorie, enseigne, date, montant, désignation\n' +
      '• Si l\'IA hésite → tu choisis via boutons (option « Nouvelle » dispo)\n' +
      '• Détection automatique des doublons (±2 jours)\n' +
      '• Avant insertion : ✏️ Modifier ouvre un menu par champ\n' +
      '• Album de photos → traité individuellement, une carte par facture\n\n' +
      '<b>📊 Statistiques</b>\n' +
      '• /stats — vue globale du mois (imprévus, total, objectif, solde) lue depuis l\'onglet « Vue globale »\n' +
      '• /semaine — résumé des 7 derniers jours (par catégorie + top enseignes)\n' +
      '• /mois — résumé détaillé du mois en cours\n' +
      '• /mois <code>YYYY-MM</code> — résumé d\'un mois précis (ex: <code>/mois 2026-04</code>)\n' +
      '• /graph — camembert des dépenses du mois en cours\n' +
      '• /graph <code>YYYY-MM</code> — camembert d\'un mois précis\n\n' +
      '<b>🔎 Recherche & édition</b>\n' +
      '• /derniere — 5 dernières dépenses avec boutons ✏️ / 🗑️\n' +
      '• /cherche <code>terme</code> — recherche dans enseigne/catégorie/désignation\n\n' +
      '<b>🔁 Doublons (historique)</b>\n' +
      '• /doublons — revue interactive des doublons (date stricte)\n' +
      '• /doublons <code>N</code> — tolérance ±N jours (ex: <code>/doublons 2</code>)\n' +
      '• /dedupe — auto-suppression des doublons stricts (date+enseigne+montant+catégorie+désignation, garde la 1ère occurrence)\n\n' +
      '<b>🏷️ Gestion des listes</b>\n' +
      '• /categories — affiche toutes les catégories et leurs enseignes\n' +
      '• /addcategorie — crée une nouvelle catégorie (+ plage nommée auto)\n' +
      '• /delcategorie — supprime une catégorie (+ plage nommée)\n' +
      '• /renamecategorie — renomme une catégorie\n' +
      '• /addenseigne — ajoute une enseigne dans une catégorie\n' +
      '• /delenseigne — supprime une enseigne\n' +
      '• /renameenseigne — renomme une enseigne\n\n' +
      '<b>ℹ️ Sheet</b>\n' +
      'Colonnes : Catégorie | Date | Type/Enseigne | Désignation | Montant',
    { parse_mode: 'HTML' }
  )
);

bot.command('stats', handleStats);
bot.command('semaine', handleSemaine);
bot.command('mois', handleMois);

// ── Recherche / édition / graph ─────────────────────────────
bot.command('derniere', handleDerniere);
bot.command('cherche', handleCherche);
bot.command('graph', handleGraph);

// ── Doublons ────────────────────────────────────────────────
bot.command('doublons', handleDoublons);
bot.command('dedupe', handleDedupe);

// ── Admin (P4) ──────────────────────────────────────────────
bot.command('categories', handleCategories);
bot.command('addenseigne', handleAddEnseigne);
bot.command('delenseigne', handleDelEnseigne);
bot.command('renameenseigne', handleRenameEnseigne);
bot.command('addcategorie', handleAddCategorie);
bot.command('delcategorie', handleDelCategorie);
bot.command('renamecategorie', handleRenameCategorie);

// ── Handlers photo + PDF + callbacks ────────────────────────
bot.on('photo', handlePhoto);
bot.on('document', handleDocument);

bot.action(/^cat_([a-z0-9]+)_(.+)$/, handleCategory);
bot.action(/^catnew_([a-z0-9]+)$/, handleCategoryNew);
bot.action(/^ensnew_([a-z0-9]+)$/, handleEnseigneNew);
bot.action(/^ens_([a-z0-9]+)_(\d+)$/, handleEnseigne);
bot.action(/^desigskip_([a-z0-9]+)$/, handleDesignationSkip);
bot.action(/^desiginput_([a-z0-9]+)$/, handleDesignationInput);
bot.action(/^force_([a-z0-9]+)$/, handleForceDuplicate);
bot.action(/^confirm_([a-z0-9]+)$/, handleConfirm);
bot.action(/^cancel_([a-z0-9]+)$/, handleCancel);
bot.action(/^edit_([a-z0-9]+)$/, handleEdit);
bot.action(/^editfield_([a-z0-9]+)_([a-z]+)$/, handleEditField);
bot.action(/^batchall_([a-z0-9]+)$/, handleBatchAll);
bot.action(/^batchseq_([a-z0-9]+)$/, handleBatchSeq);
bot.action(/^batchincl_([a-z0-9]+)_(retrait|virement)_(yes|no)$/, handleBatchInclude);

// Expense callbacks (P4 — /derniere)
bot.action(/^expmod_([a-z0-9]+)$/, handleExpMod);
bot.action(/^expdel_([a-z0-9]+)$/, handleExpDel);
bot.action(/^expdelok_([a-z0-9]+)$/, handleExpDelConfirm);
bot.action(/^expcancel_([a-z0-9]+)$/, handleExpCancel);

// Doublons callbacks
bot.action(/^dupdel_([a-z0-9]+)_(\d+)$/, handleDupDel);
bot.action(/^dupkeep_([a-z0-9]+)$/, handleDupKeep);
bot.action(/^dupskip_([a-z0-9]+)$/, handleDupSkip);
bot.action(/^dupstop_([a-z0-9]+)$/, handleDupStop);
bot.action(/^dedupok_([a-z0-9]+)$/, handleDedupOk);
bot.action(/^dedupcancel_([a-z0-9]+)$/, handleDedupCancel);

// Admin callbacks
bot.action(/^admincat_(add|del|rename)_(.+)$/, handleAdminCat);
bot.action(/^adminens_(del|rename)_(\d+)$/, handleAdminEns);
bot.action(/^admindelconfirm$/, handleAdminDelConfirm);
bot.action(/^admincatpick_(del|rename)_(.+)$/, handleAdminCatPick);
bot.action(/^admindelcatconfirm$/, handleAdminDelCatConfirm);
bot.action(/^admincancel$/, handleAdminCancel);

bot.on('text', handleText);

// ── Lancement ──────────────────────────────────────────────
const isProd = process.env.NODE_ENV === 'production' && process.env.WEBHOOK_URL;

if (isProd) {
  const port = Number(process.env.PORT) || 3000;
  const webhookPath = `/webhook/${process.env.TELEGRAM_BOT_TOKEN}`;
  const tgHandler = bot.webhookCallback(webhookPath);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === webhookPath) {
      return tgHandler(req, res);
    }

    if (url.pathname === '/cron/reminder' && req.method === 'GET') {
      const secret = url.searchParams.get('secret');
      if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      try {
        const result = await checkAndRemind(bot);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('[cron/reminder]', err);
        res.writeHead(500).end(err.message);
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200).end('ok');
      return;
    }

    res.writeHead(404).end('not found');
  });

  server.listen(port, () => {
    console.log(`✅ Serveur HTTP démarré sur :${port}`);
    bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}${webhookPath}`)
      .then(() => console.log(`✅ Webhook Telegram enregistré → ${process.env.WEBHOOK_URL}${webhookPath}`))
      .catch((err) => console.error('⚠️ setWebhook échoué (bot toujours actif) :', err.message));
  });
} else {
  bot.launch();
  console.log('✅ Bot démarré en mode polling (dev)');
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
