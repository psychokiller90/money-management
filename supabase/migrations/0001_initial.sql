-- ============================================================
-- Migration 0001 — Schéma initial ExpenseBot V2
-- Phase 0 : structures pour migration depuis Google Sheets
--
-- Tables : categories, enseignes, transactions, budgets, recurrences
-- Extensions : pgcrypto (uuid), unaccent, pg_trgm (fuzzy phase 4)
-- RLS : activée mais sans policies → seul le service_role lit/écrit
-- ============================================================

-- ─── Extensions ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- ─── Tables ─────────────────────────────────────────────────

-- categories : référentiel principal
CREATE TABLE public.categories (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  name          text NOT NULL,
  position      integer NOT NULL DEFAULT 0,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_unique UNIQUE (name)
);

COMMENT ON TABLE public.categories IS
  'Catégories de transactions (Courses, Imprevus, Factures, Abonnements, Jumeaux...)';
COMMENT ON COLUMN public.categories.archived_at IS
  'Soft delete : NULL = active, sinon catégorie archivée';

-- enseignes : scope par catégorie (préserve modèle Sheets)
CREATE TABLE public.enseignes (
  id                uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  category_id       uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  name_normalized   text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',
  archived_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enseignes_unique UNIQUE (category_id, name_normalized)
);

COMMENT ON TABLE public.enseignes IS
  'Enseignes scopées par catégorie. name_normalized rempli par trigger (lower + unaccent).';
COMMENT ON COLUMN public.enseignes.aliases IS
  'Variantes du nom pour matching fuzzy (rempli en phase 4)';

CREATE INDEX enseignes_name_trgm_idx
  ON public.enseignes USING gin (name_normalized extensions.gin_trgm_ops);
CREATE INDEX enseignes_category_idx
  ON public.enseignes (category_id);

-- transactions : table principale
CREATE TABLE public.transactions (
  id                uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  date              date NOT NULL,
  amount            numeric(12,2) NOT NULL CHECK (amount >= 0),
  category_id       uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  enseigne_id       uuid REFERENCES public.enseignes(id) ON DELETE SET NULL,
  enseigne_label    text,
  designation       text,
  transaction_type  text NOT NULL DEFAULT 'expense'
                    CHECK (transaction_type IN ('expense','income','transfer')),
  source            text NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','photo','pdf','csv','recurrence','migration')),
  sheet_row_index   integer,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.transactions IS
  'Transactions financières — source de vérité V2.';
COMMENT ON COLUMN public.transactions.enseigne_label IS
  'Snapshot du libellé brut au moment de l''insertion. Peut différer de enseignes.name.';
COMMENT ON COLUMN public.transactions.sheet_row_index IS
  'Ligne d''origine dans la Sheet pour traçabilité migration (NULL après phase 1).';

CREATE INDEX transactions_date_amount_idx
  ON public.transactions (date DESC, amount);
CREATE INDEX transactions_category_date_idx
  ON public.transactions (category_id, date DESC);
CREATE INDEX transactions_enseigne_idx
  ON public.transactions (enseigne_id) WHERE enseigne_id IS NOT NULL;
CREATE INDEX transactions_expense_date_idx
  ON public.transactions (date DESC) WHERE transaction_type = 'expense';

-- budgets : vide en phase 0, alimenté en phase 3
CREATE TABLE public.budgets (
  id            uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  category_id   uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  month         date NOT NULL CHECK (extract(day FROM month) = 1),
  amount        numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budgets_unique UNIQUE (category_id, month)
);

COMMENT ON TABLE public.budgets IS
  'Budgets mensuels par catégorie (phase 3). month = 1er du mois.';

-- recurrences : vide en phase 0, alimenté en phase 4
CREATE TABLE public.recurrences (
  id                       uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  enseigne_id              uuid NOT NULL REFERENCES public.enseignes(id) ON DELETE CASCADE,
  category_id              uuid NOT NULL REFERENCES public.categories(id) ON DELETE RESTRICT,
  expected_day_of_month    integer CHECK (expected_day_of_month BETWEEN 1 AND 31),
  expected_amount          numeric(12,2),
  tolerance_pct            numeric(4,2) NOT NULL DEFAULT 10.00,
  last_seen_at             date,
  next_expected_at         date,
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.recurrences IS
  'Récurrences détectées (phase 4) : abonnements, loyers, etc.';

-- ─── Triggers ───────────────────────────────────────────────

-- Mise à jour automatique de updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER transactions_set_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Normalisation enseignes.name_normalized (lower + unaccent + trim)
CREATE OR REPLACE FUNCTION public.normalize_enseigne_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.name_normalized = lower(extensions.unaccent(trim(NEW.name)));
  RETURN NEW;
END;
$$;

CREATE TRIGGER enseignes_normalize_name
  BEFORE INSERT OR UPDATE OF name ON public.enseignes
  FOR EACH ROW EXECUTE FUNCTION public.normalize_enseigne_name();

-- ─── RLS désactivée (single-user, service_role uniquement) ──
-- Note : la RLS reste activée par convention Supabase, mais
-- aucune policy n'est définie → seul le service_role peut accéder.
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.enseignes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurrences ENABLE ROW LEVEL SECURITY;
