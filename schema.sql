-- ExpenseBot — miroir Postgres (Neon) du Google Sheet.
--
-- Le Google Sheet reste la source de vérité : le bot y écrit exactement comme
-- avant, puis recopie l'état complet ici. Ces tables sont donc en lecture seule
-- du point de vue de l'utilisateur — toute écriture directe serait écrasée au
-- prochain miroir.

-- Une ligne par dépense de l'onglet « Dépenses ».
-- row_index = numéro de ligne physique dans le Sheet (1-based, en-tête = 1).
-- Il bouge à chaque suppression de ligne, d'où la resynchronisation complète.
create table if not exists depenses (
  id          bigserial primary key,
  row_index   integer not null,
  categorie   text    not null,
  date        date    not null,
  enseigne    text,
  designation text,
  montant     numeric(12,2) not null,
  synced_at   timestamptz default now()
);

create index if not exists idx_depenses_date on depenses(date desc);
create index if not exists idx_depenses_categorie on depenses(categorie);
create index if not exists idx_depenses_enseigne on depenses(enseigne);

-- Colonnes de l'onglet « data » : une catégorie par colonne.
create table if not exists categories (
  nom       text primary key,
  colonne   text,
  synced_at timestamptz default now()
);

-- Sous-listes de l'onglet « data » (lignes 2+ de chaque colonne).
create table if not exists enseignes (
  categorie text not null references categories(nom) on delete cascade,
  nom       text not null,
  primary key (categorie, nom)
);

-- Trace des synchronisations, pour diagnostiquer un miroir qui décroche.
create table if not exists sync_log (
  id          bigserial primary key,
  date        timestamptz default now(),
  source      text,
  nb_depenses integer,
  status      text,
  details     text
);

create index if not exists idx_sync_log_date on sync_log(date desc);
