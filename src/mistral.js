import { Mistral } from '@mistralai/mistralai';

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures et tickets de caisse français.
Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte autour.
Si une information est absente ou illisible, utilise null.
Les confidences (categorie_confidence, enseigne_confidence) doivent refléter ta certitude :
- "high" si tu es sûr à >90 %
- "medium" si tu hésites entre 2 options
- "low" si l'image est floue ou les indices ambigus`;

function buildCatBlock(refs) {
  const catList = refs.categories.map((c) => `"${c}"`).join(', ');
  const enseignesPerCat = refs.categories
    .map((c) => `  - ${c} : ${refs.enseignes[c].map((e) => `"${e}"`).join(', ') || '(aucune)'}`)
    .join('\n');
  return { catList, enseignesPerCat };
}

function buildUserPrompt(refs) {
  const { catList, enseignesPerCat } = buildCatBlock(refs);
  return `Analyse cette image de facture/ticket et extrais les informations de paiement.

Catégories disponibles (choisis EXACTEMENT une de ces valeurs pour "categorie") :
${catList}

Enseignes connues par catégorie (choisis si possible une de ces valeurs pour "enseigne", mets enseigne_in_list à true) :
${enseignesPerCat}

Si l'enseigne réelle ne figure dans AUCUNE liste, propose-la quand même et mets enseigne_in_list à false.

Pour la "designation" : résume en 3-8 mots les articles principaux de la facture (ex: "Pain, lait, œufs"). Si rien d'identifiable, mets null.

Retourne EXACTEMENT ce JSON :
{
  "date": "YYYY-MM-DD",
  "montant": 0.00,
  "categorie": "Courses",
  "categorie_confidence": "high",
  "enseigne": "Leclerc",
  "enseigne_in_list": true,
  "enseigne_confidence": "high",
  "designation": "Pain, lait, œufs"
}`;
}

function buildMultiPrompt(refs) {
  const { catList, enseignesPerCat } = buildCatBlock(refs);
  return `Analyse ce document financier (relevé bancaire, extrait de compte, ou facture) et extrais TOUTES les lignes de débit.

Catégories disponibles :
${catList}

Enseignes connues par catégorie :
${enseignesPerCat}

═══ RÈGLES IMPORTANTES DE MATCHING D'ENSEIGNE ═══

1. Si le libellé CONTIENT le nom d'une enseigne existante (insensible à la casse), utilise CETTE enseigne avec enseigne_in_list=true et confidence="high". Exemples :
   - "BOULANGERIE EPIN", "BOULANGERIE PAUL", "Au Pain de la Boulangerie" → enseigne="Boulangerie", catégorie="Courses"
   - "PHARMACIE DU CENTRE", "PHARMA SAINT JEAN" → enseigne="Pharmacie", catégorie="Imprevus"
   - "RESTAURANT LE BISTROT", "RESTAU DU COIN" → enseigne="Restaurant" ou "Restau", catégorie="Imprevus"
   - "BAR DU PORT", "LE BAR DES SPORTS" → enseigne="Bar", catégorie="Imprevus"

2. Variantes connues d'enseignes : matche les variantes
   - "Carrefour Market", "Carrefour Express", "Carrefour Drive" → "Carrefour" (si présent)
   - "Leclerc Drive" → "Leclerc"
   - "Action Pro", "Action SA" → "Action"
   - "Tang Freres", "Tang Frères" → "Tang Frères"

3. Catégorisation par sémantique du libellé (même si l'enseigne exacte est inconnue) :
   - Mots "BOULANGERIE", "PATISSERIE", "EPICERIE", "ALIMENT", "PRIMEUR", "FRUITS LEGUMES" → Courses
   - Mots "PHARMACIE", "MEDICAL", "RESTAURANT", "RESTAU", "BAR", "FAST FOOD", "MCDO", "BURGER", "KFC" → Imprevus
   - Mots "EDF", "ENGIE", "EAU", "GAZ", "LOYER", "SCI" → Factures
   - Mots "NETFLIX", "SPOTIFY", "AMAZON PRIME", "DISNEY", "BASIC FIT", "CANAL+", "SFR", "ORANGE", "BOUYGUES", "FREE MOBILE", "NAVIGO" → Abonnements

4. Si AUCUN match clair → enseigne_in_list=false avec le libellé tel quel + categorie="Imprevus" + confidence="low"

═══ RÈGLES GÉNÉRALES ═══
- Ignore les crédits, remboursements, soldes, reports et en-têtes.
- Pour chaque débit : extrais date, montant positif, enseigne/libellé, catégorie.
- "designation" : résume le libellé en 3-8 mots, ou null si le libellé est déjà l'enseigne.
- "transaction_type" :
  * "retrait" → retrait d'espèces / DAB / ATM / "RETRAIT"
  * "virement" → virement sortant / SCT / SEPA OUT / "VIR " / prélèvement entre comptes
  * "debit" → tout autre achat
- Confidence "high" si match direct ou règle 1-3 appliquée. "low" UNIQUEMENT si vraiment indéterminable.

Retourne EXACTEMENT ce JSON :
{
  "is_statement": true,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "montant": 0.00,
      "transaction_type": "debit",
      "categorie": "Courses",
      "categorie_confidence": "high",
      "enseigne": "Boulangerie",
      "enseigne_in_list": true,
      "enseigne_confidence": "high",
      "designation": null
    }
  ]
}`;
}

/**
 * Analyse une image de facture avec Mistral Pixtral.
 * @param {string} base64Image
 * @param {{categories: string[], enseignes: Record<string, string[]>}} refs
 * @param {string} mimeType
 */
export async function analyzeInvoice(base64Image, refs, mimeType = 'image/jpeg') {
  const response = await client.chat.complete({
    model: 'pixtral-12b-2409',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            imageUrl: { url: `data:${mimeType};base64,${base64Image}` },
          },
          { type: 'text', text: buildUserPrompt(refs) },
        ],
      },
    ],
    maxTokens: 400,
  });

  const raw = response.choices[0].message.content;
  return parseJSON(raw);
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw.trim());
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Réponse IA non parseable : ${raw}`);
  }
}

/**
 * Extrait les objets transaction valides depuis un JSON potentiellement tronqué.
 * Parcourt le contenu de l'array "transactions" en cherchant des objets { } complets.
 */
function extractPartialTransactions(raw) {
  const arrStart = raw.indexOf('"transactions"');
  if (arrStart === -1) return null;
  const bracketStart = raw.indexOf('[', arrStart);
  if (bracketStart === -1) return null;

  const transactions = [];
  let i = bracketStart + 1;

  while (i < raw.length) {
    // Saute les espaces / virgules
    while (i < raw.length && /[\s,]/.test(raw[i])) i++;
    if (i >= raw.length || raw[i] === ']') break;
    if (raw[i] !== '{') { i++; continue; }

    // Trouve l'accolade fermante correspondante
    let depth = 0;
    let inString = false;
    let escaped = false;
    const start = i;
    let end = -1;

    for (let j = i; j < raw.length; j++) {
      const c = raw[j];
      if (escaped) { escaped = false; continue; }
      if (c === '\\' && inString) { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = j; break; }
      }
    }

    if (end === -1) break; // Objet incomplet → fin du JSON tronqué

    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      if (obj.montant !== undefined) transactions.push(obj);
    } catch { /* objet mal formé, on ignore */ }

    i = end + 1;
  }

  return transactions.length > 0 ? transactions : null;
}

/**
 * Parse la réponse multi-transactions avec récupération partielle.
 */
function parseMultiJSON(raw) {
  // 1) Parse complet
  try {
    const parsed = JSON.parse(raw.trim());
    if (parsed.transactions) return parsed;
    if (Array.isArray(parsed)) return { is_statement: true, transactions: parsed };
  } catch { /* continue */ }

  // 2) Extraction du bloc JSON principal
  const match = raw.match(/\{[\s\S]*/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.transactions) return parsed;
    } catch { /* continue */ }
  }

  // 3) Récupération partielle depuis JSON tronqué
  const partial = extractPartialTransactions(raw);
  if (partial) {
    console.warn(`[parseMultiJSON] JSON tronqué — ${partial.length} transactions récupérées`);
    return { is_statement: true, transactions: partial };
  }

  throw new Error(`Réponse IA non parseable (position ~${raw.length}) : ${raw.slice(0, 150)}…`);
}

/**
 * Analyse un PDF de facture via Mistral OCR + chat completion.
 * 1. Upload du PDF dans Mistral Files API (purpose: ocr)
 * 2. Récupération d'une URL signée
 * 3. OCR pour extraire le texte
 * 4. Chat completion text-only avec le même prompt système
 */
/**
 * Extrait le texte d'un PDF via Mistral OCR puis soumet au chat.
 * Retourne { is_statement, transactions[] } — toujours un tableau.
 */
export async function analyzeInvoicePdf(pdfBuffer, refs, fileName = 'facture.pdf') {
  // 1) Upload
  const uploaded = await client.files.upload({
    file: { fileName, content: pdfBuffer },
    purpose: 'ocr',
  });

  // 2) Signed URL
  const signed = await client.files.getSignedUrl({ fileId: uploaded.id });

  // 3) OCR
  const ocr = await client.ocr.process({
    model: 'mistral-ocr-latest',
    document: { type: 'document_url', documentUrl: signed.url },
  });

  const ocrText = (ocr.pages || [])
    .map((p) => p.markdown || p.text || '')
    .join('\n\n')
    .trim();

  if (!ocrText) throw new Error('OCR a retourné un contenu vide.');

  // 4) Chat multi-transactions
  // Pas de responseFormat json_object : le modèle peut tronquer le JSON
  // et on veut pouvoir récupérer les transactions partielles.
  const response = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${buildMultiPrompt(refs)}\n\nContenu OCR :\n---\n${ocrText}\n---`,
      },
    ],
    maxTokens: 8000,
  });

  return parseMultiJSON(response.choices[0].message.content);
}
