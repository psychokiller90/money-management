# Migration V2 — Phase 0

Ce guide te conduit pas-à-pas de l'état actuel (Google Sheets seul) à un Supabase peuplé avec **tout l'historique 2025-2026**. Le bot Telegram continue d'écrire dans la Sheet ; rien n'est touché côté `src/`.

Temps estimé : **~2 h 30** en une seule session.

---

## Pré-requis

- ✅ Projet Supabase `expense-bot` créé (région `eu-west-3` Paris) — fait via MCP par Claude
- ✅ URL : `https://dgcxhsgalicjklutabtl.supabase.co`
- ✅ Schéma SQL appliqué — 5 tables + 3 extensions présentes
- ⏳ `service_role_key` à copier depuis le dashboard
- ⏳ `.env` à compléter

---

## Étape 1 — Compléter `.env`

1. Va sur https://supabase.com/dashboard/project/dgcxhsgalicjklutabtl/settings/api
2. Copie :
   - **`Project URL`** → `SUPABASE_URL`
   - **`service_role` secret** (section "Project API keys") → `SUPABASE_SERVICE_ROLE_KEY` ⚠️ **NE LA PARTAGE JAMAIS**
   - **`anon` public** → `SUPABASE_ANON_KEY` (utile uniquement pour le keep-alive)
3. Colle-les dans ton `.env` :

```env
SUPABASE_URL=https://dgcxhsgalicjklutabtl.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi... (long)
SUPABASE_ANON_KEY=eyJhbGciOi... (long)
```

---

## Étape 2 — Seed des référentiels

Insère les catégories + enseignes depuis l'onglet `data` du Sheet vers Supabase.

```bash
npm run seed
```

**Attendu :**
```
📚 Lecture du référentiel depuis Google Sheets...
   5 catégories trouvées
📂 Insertion des catégories...
   ✅ 5 catégorie(s) en base
🏪 Insertion des enseignes...
   ✅ Courses          6 fournies, 6 insérée(s)
   ✅ Imprevus         9 fournies, 9 insérée(s)
   ...
✅ Total enseignes actives en base : ~30
```

**Idempotent** : tu peux relancer sans risque, les doublons sont ignorés.

---

## Étape 3 — Migration en dry-run

Lit l'onglet `Dépenses`, transforme, **n'écrit rien**, affiche un rapport.

```bash
npm run migrate:dry
```

**À vérifier :**
- `Prêts à insérer` ≈ nombre total de lignes Sheet
- `Ignorés (incomplets/dates KO)` : devrait être 0 ou très faible
- `Ignorés (catégorie inconnue)` : doit être **0** (sinon arrête, vérifie le seed)
- `Warnings enseigne inconnue` : tolérable — ces lignes seront insérées avec `enseigne_id=NULL` + `enseigne_label` brut, phase 4 les rattrapera
- `Somme des montants à insérer` : note-la pour la comparer à l'étape 5

Si quelque chose cloche : corrige côté Sheet ou côté seed, puis relance.

---

## Étape 4 — Migration en mode commit

```bash
npm run migrate:commit
```

**Attendu :**
```
💾 Insertion par batches de 500...
   1247/1247

✅ 1247 transaction(s) insérée(s) avec succès.
```

**En cas d'erreur** à mi-parcours, tu peux nettoyer et recommencer :
```sql
-- Dans le SQL Editor Supabase
TRUNCATE public.transactions RESTART IDENTITY;
```
Puis relance `npm run migrate:commit`.

---

## Étape 5 — Vérification

```bash
npm run migrate:verify
```

**Critères de succès :**
- `Delta count` = 0 ✅
- `Delta sum` < 0.01 € ✅
- 5/5 spot-checks ✅

Ouvre aussi le Table Editor pour un coup d'œil visuel :
https://supabase.com/dashboard/project/dgcxhsgalicjklutabtl/editor

---

## Étape 6 — Keep-alive cron-job.org

Sans activité pendant 7 jours, le projet free tier Supabase se met en pause. Pour l'éviter :

1. Va sur https://cron-job.org → **Create cronjob**
2. **Title** : `Supabase expense-bot keep-alive`
3. **URL** :
   ```
   https://dgcxhsgalicjklutabtl.supabase.co/rest/v1/categories?select=id&limit=1
   ```
4. **Schedule** : Every 6 hours
5. **Advanced → Custom HTTP Headers** :
   ```
   apikey: <colle ton SUPABASE_ANON_KEY>
   Authorization: Bearer <colle ton SUPABASE_ANON_KEY>
   ```
6. **Save**. Lance un "Test run" pour valider : status 200 attendu.

---

## Étape 7 — Commit

```bash
git add supabase/ scripts/ MIGRATION.md package.json package-lock.json .env.example
git commit -m "feat: V2 phase 0 — schéma Supabase + scripts de migration"
git push
```

⚠️ **Ne commit JAMAIS** ton `.env` (déjà dans `.gitignore`, mais vérifie).

---

## État à la fin de la phase 0

| Composant | État |
|---|---|
| Sheet | Inchangée — toujours la source de vérité du bot |
| Supabase | Peuplé avec tout l'historique (read-only depuis le bot) |
| Bot Telegram | Inchangé — écrit toujours dans la Sheet |
| Keep-alive | Actif (1 hit/6h) |

**Prochaine étape : Phase 1** — créer `src/db.js`, remplacer `sheets.js` côté handlers, basculer le bot sur Supabase.

---

## Référence — Tables créées

```
public.categories     (id, name, position, archived_at, created_at)
public.enseignes      (id, category_id, name, name_normalized, aliases, ...)
public.transactions   (id, date, amount, category_id, enseigne_id, enseigne_label,
                       designation, transaction_type, source, sheet_row_index, ...)
public.budgets        (vide — phase 3)
public.recurrences    (vide — phase 4)
```

Extensions installées : `pgcrypto`, `unaccent`, `pg_trgm` (toutes dans schema `extensions`).

RLS activée sur les 5 tables sans policies → seul le `service_role` peut accéder.
