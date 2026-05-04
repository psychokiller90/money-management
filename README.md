# ExpenseBot

Bot Telegram personnel : photo de facture → analyse Mistral Vision → insertion automatique dans Google Sheets, avec détection de doublons, rappels et stats.

## Features

- 📸 Envoie une photo de ticket/facture → IA détecte catégorie, enseigne, date, montant, désignation
- 🤔 Si l'IA hésite, propose les valeurs existantes en boutons ; possibilité d'ajouter une nouvelle enseigne (auto-injectée dans l'onglet `data`)
- 🔁 Détection automatique des doublons (même date ±2j, montant, enseigne)
- 📊 Commandes `/stats`, `/semaine`, `/mois [YYYY-MM]` pour des résumés
- ⏰ Rappel automatique si pas de scan depuis N jours (via cron externe)

## Stack

| Composant | Service | Coût |
|---|---|---|
| Bot framework | Telegraf 4 | gratuit |
| Vision IA | Mistral Pixtral 12B | gratuit (free tier console.mistral.ai) |
| Persistance | Google Sheets API | gratuit |
| Hébergement | Render Web Service | gratuit |
| Cron rappels | cron-job.org ou GitHub Actions | gratuit |

---

## Setup

### 1. Cloner et installer
```bash
git clone <ton-repo> && cd money-management
npm install
cp .env.example .env
```

### 2. Créer le bot Telegram
1. Ouvre [@BotFather](https://t.me/BotFather) → `/newbot` → copie le token → `TELEGRAM_BOT_TOKEN`
2. Récupère ton user ID via [@userinfobot](https://t.me/userinfobot) → `TELEGRAM_ADMIN_ID`

### 3. Clé Mistral
[console.mistral.ai](https://console.mistral.ai) → API Keys → `MISTRAL_API_KEY`

### 4. Google Sheets — Service Account
1. [console.cloud.google.com](https://console.cloud.google.com) → nouveau projet
2. **APIs & Services** → activer `Google Sheets API`
3. **Credentials** → Create → Service Account → télécharger le JSON
4. Dans le JSON, copie l'email du service account
5. **Ouvre ton Google Sheet** → Partager → colle l'email → Éditeur
6. Stringifie le JSON : `cat key.json | jq -c .` → `GOOGLE_CREDENTIALS_JSON`
7. Récupère l'ID du Sheet depuis l'URL → `SPREADSHEET_ID`

### 5. Structure attendue du Sheet
- Onglet **`Dépenses`** avec en ligne 1 : `Catégorie | Date | Type / Enseigne | Désignation | Montant (€)`
- Onglet **`data`** : colonnes A-E remplies avec les enseignes par catégorie (header en ligne 1 = nom de la catégorie)

### 6. Lancer en local
```bash
npm run dev
```

---

## Déploiement Render

1. Crée un **Web Service** → connecte le repo GitHub
2. Build : `npm install` — Start : `npm start`
3. Ajoute toutes les variables d'env (cf. `.env.example`)
4. Set `NODE_ENV=production` et `WEBHOOK_URL=https://<ton-app>.onrender.com`
5. Génère un secret aléatoire pour `CRON_SECRET` (ex: `openssl rand -hex 32`)

## Cron rappels (cron-job.org)

1. Crée un compte sur [cron-job.org](https://cron-job.org)
2. New cronjob :
   - URL : `https://<ton-app>.onrender.com/cron/reminder?secret=<CRON_SECRET>`
   - Schedule : tous les jours à 20h (par exemple)
   - Method : GET

---

## Variables d'environnement

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Token @BotFather |
| `TELEGRAM_ADMIN_ID` | Ton ID Telegram (auth bot perso) |
| `MISTRAL_API_KEY` | Clé API Mistral |
| `GOOGLE_CREDENTIALS_JSON` | JSON service account stringifié |
| `SPREADSHEET_ID` | ID du fichier Google Sheets |
| `REMINDER_DAYS` | Seuil avant rappel (défaut : 3) |
| `CRON_SECRET` | Secret pour protéger /cron/reminder |
| `WEBHOOK_URL` | URL publique Render (prod) |
| `PORT` | Auto-injecté par Render |
| `NODE_ENV` | `development` ou `production` |
