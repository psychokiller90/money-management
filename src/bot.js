import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import {
  handlePhoto,
  handleDocument,
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
  handleText,
} from './handlers/photo.js';
import { handleStats, handleSemaine, handleMois } from './handlers/stats.js';
import {
  handleCategories,
  handleAddEnseigne,
  handleDelEnseigne,
  handleRenameEnseigne,
  handleAdminCat,
  handleAdminEns,
  handleAdminDelConfirm,
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
      'Commandes : /stats /semaine /mois /help',
    { parse_mode: 'HTML' }
  )
);

bot.help((ctx) =>
  ctx.reply(
    '📖 <b>Utilisation</b>\n\n' +
      '• Envoie une <b>photo</b> ou un <b>PDF</b> de facture → analyse IA → insertion Sheets\n' +
      '• Album de photos = traitement individuel de chaque facture\n' +
      "• L'IA propose la catégorie et l'enseigne ; en cas de doute tu choisis\n" +
      '• Détection auto des doublons (même date, montant, enseigne ±2j)\n' +
      '• Avant insertion : ✏️ Modifier permet de corriger chaque champ\n\n' +
      '<b>Statistiques :</b>\n' +
      '• /stats — résumé du mois en cours\n' +
      '• /semaine — 7 derniers jours\n' +
      '• /mois [YYYY-MM] — résumé d\'un mois précis\n\n' +
      '<b>Gestion des listes :</b>\n' +
      '• /categories — affiche catégories & enseignes\n' +
      '• /addenseigne — ajoute une enseigne\n' +
      '• /delenseigne — supprime une enseigne\n' +
      '• /renameenseigne — renomme une enseigne\n\n' +
      '<b>Colonnes Sheet :</b> Catégorie | Date | Type/Enseigne | Désignation | Montant',
    { parse_mode: 'HTML' }
  )
);

bot.command('stats', handleStats);
bot.command('semaine', handleSemaine);
bot.command('mois', handleMois);

// ── Admin (P4) ──────────────────────────────────────────────
bot.command('categories', handleCategories);
bot.command('addenseigne', handleAddEnseigne);
bot.command('delenseigne', handleDelEnseigne);
bot.command('renameenseigne', handleRenameEnseigne);

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

// Admin callbacks
bot.action(/^admincat_(add|del|rename)_(.+)$/, handleAdminCat);
bot.action(/^adminens_(del|rename)_(\d+)$/, handleAdminEns);
bot.action(/^admindelconfirm$/, handleAdminDelConfirm);
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
