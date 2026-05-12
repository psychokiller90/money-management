/**
 * scripts/_supabase-client.mjs
 *
 * Helper partagé : crée un client Supabase admin (service_role) correctement
 * configuré pour Node.js < 22 (WebSocket non natif).
 *
 * Usage :
 *   import 'dotenv/config';
 *   import { supabase } from './_supabase-client.mjs';
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const rawUrl = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!rawUrl || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis dans .env');
  process.exit(1);
}

// Normalisation défensive de l'URL :
//  - supprime "/rest/v1" ou "/rest/v1/" si l'utilisateur l'a copié par erreur
//  - supprime le slash final
// supabase-js attend juste la racine "https://<project>.supabase.co"
function normalizeSupabaseUrl(url) {
  let u = url.trim().replace(/\/rest\/v1\/?$/i, '');
  while (u.endsWith('/')) u = u.slice(0, -1);
  return u;
}

const SUPABASE_URL = normalizeSupabaseUrl(rawUrl);
if (SUPABASE_URL !== rawUrl) {
  console.warn(
    `⚠️  SUPABASE_URL normalisée : "${rawUrl}" → "${SUPABASE_URL}".\n` +
      '   Pense à corriger ton .env pour ne plus voir ce warning.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
  // Node 20 n'a pas de WebSocket natif → on injecte ws comme transport.
  // Aucun impact sur les requêtes REST/PostgREST.
  realtime: { transport: ws },
});
