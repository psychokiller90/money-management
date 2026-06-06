import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import {
  handlePhoto,
  handleDocument,
  handleAjout,
  handleAjoutDate,
  handleCategory,
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
import { handleStats } from './handlers/stats.js';
import {
  handleDerniere,
  handleCherche,
  handleGraph,
  handleJour,
  handleSemaine,
  handleMois,
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
import { checkAndRemind } from './handlers/reminder.js';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Commandes ──────────────────────────────────────────────
bot.start((ctx) =>
  ctx.reply(
    '👋 <b>ExpenseBot</b>\n\n' +
      'Envoie-moi une photo de ta facture ou ticket de caisse.\n' +
      "Je l'analyse et l'insère dans ton Google Sheets.\n\n" +
      'Saisie rapide : <code>/ajout 38.95 Leclerc Courses</code>\n\n' +
      '💬 Pose-moi aussi tes questions en langage naturel :\n' +
      '<i>« Combien j\'ai dépensé en courses ce mois-ci ? »</i>\n\n' +
      'Commandes : /jour /semaine /mois /ajout /help',
    { parse_mode: 'HTML' }
  )
);

bot.help((ctx) =>
  ctx.reply(
    '📖 <b>Guide complet</b>\n\n' +
      '<b>📸 Saisie de dépense</b>\n' +
      '• Envoie une <b>photo</b> ou un <b>PDF</b> de facture → analyse IA automatique\n' +
      '• L\'IA détecte catégorie, enseigne, date, montant, désignation\n' +
      '• Détection automatique des doublons (±2 jours)\n' +
      '• Album de photos → traité individuellement\n\n' +
      '<b>✏️ Saisie manuelle</b>\n' +
      '• /ajout — flow interactif (montant → date → catégorie → enseigne)\n' +
      '• <b>Saisie rapide</b> : <code>/ajout montant enseigne catégorie [date]</code>\n' +
      '  Ex : <code>/ajout 38.95 Leclerc Courses 12/05/2026</code>\n' +
      '  La date est facultative (aujourd\'hui par défaut)\n' +
      '• <b>Saisie en masse</b> : /ajout suivi de plusieurs lignes\n' +
      '  <code>/ajout\n38.95 Leclerc Courses\n12.50 Pharmacie Imprevus\n9.90 Netflix Abonnements</code>\n\n' +
      '<b>📋 Consultation & édition</b>\n' +
      '• /jour — dépenses d\'aujourd\'hui avec boutons ✏️ / 🗑️\n' +
      '• /semaine — 7 derniers jours avec boutons ✏️ / 🗑️\n' +
      '• /mois — mois en cours avec boutons ✏️ / 🗑️\n' +
      '• /mois <code>YYYY-MM</code> — mois précis (ex : <code>/mois 2026-04</code>)\n' +
      '• /derniere — 5 dernières dépenses\n' +
      '• /cherche <code>terme</code> — recherche texte\n\n' +
      '<b>📊 Graphiques & stats</b>\n' +
      '• /stats — vue globale du mois (total, objectif épargne, solde)\n' +
      '• /graph — camembert mensuel\n' +
      '• /graph <code>YYYY-MM</code> — camembert d\'un mois précis\n\n' +
      '<b>🏷️ Gestion des listes</b>\n' +
      '• /categories — liste catégories et enseignes\n' +
      '• /addcategorie · /delcategorie · /renamecategorie\n' +
      '• /addenseigne · /delenseigne · /renameenseigne\n\n' +
      '<b>💬 Assistant</b>\n' +
      'Écris-moi simplement une question sur tes finances :\n' +
      '<i>« Combien en transport en mai ? », « Ma plus grosse dépense ? »,\n' +
      '« Où puis-je économiser ? »</i>',
    { parse_mode: 'HTML' }
  )
);

bot.command('ajout', handleAjout);
bot.command('stats', handleStats);

// ── Consultation par période ────────────────────────────────
bot.command('jour', handleJour);
bot.command('semaine', handleSemaine);
bot.command('mois', handleMois);

// ── Recherche / édition / graph ─────────────────────────────
bot.command('derniere', handleDerniere);
bot.command('cherche', handleCherche);
bot.command('graph', handleGraph);

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
bot.action(/^ajoutdate_([a-z0-9]+)$/, handleAjoutDate);

// Expense callbacks (P4 — /derniere)
bot.action(/^expmod_([a-z0-9]+)$/, handleExpMod);
bot.action(/^expdel_([a-z0-9]+)$/, handleExpDel);
bot.action(/^expdelok_([a-z0-9]+)$/, handleExpDelConfirm);
bot.action(/^expcancel_([a-z0-9]+)$/, handleExpCancel);

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
