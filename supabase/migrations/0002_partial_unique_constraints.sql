-- ============================================================
-- Migration 0002 — Contraintes UNIQUE partielles (soft-delete friendly)
--
-- Phase 1 : permet de re-créer une catégorie/enseigne avec un nom
-- déjà utilisé par une ligne archivée (archived_at IS NOT NULL).
-- ============================================================

-- Categories
ALTER TABLE public.categories DROP CONSTRAINT categories_name_unique;
CREATE UNIQUE INDEX categories_name_active_unique
  ON public.categories(name)
  WHERE archived_at IS NULL;

-- Enseignes
ALTER TABLE public.enseignes DROP CONSTRAINT enseignes_unique;
CREATE UNIQUE INDEX enseignes_active_unique
  ON public.enseignes(category_id, name_normalized)
  WHERE archived_at IS NULL;
