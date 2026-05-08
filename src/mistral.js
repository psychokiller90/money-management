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
  return `Analyse ce document financier (relevé bancaire, extrait de compte, ou facture) et extrais TOUTES les transactions de débit (dépenses).

Catégories disponibles :
${catList}

Enseignes connues par catégorie :
${enseignesPerCat}

Règles :
- Ignore les crédits, virements entrants, soldes, reports et en-têtes.
- Pour chaque débit : extrais date, montant (positif), enseigne/libellé, catégorie.
- Si l'enseigne n'est pas dans la liste → enseigne_in_list: false.
- "designation" : résume le libellé en 3-8 mots, ou null si le libellé IS déjà l'enseigne.
- S'il n'y a qu'une seule transaction (facture simple) → tableau à 1 élément.

Retourne EXACTEMENT ce JSON (tableau, même pour 1 élément) :
{
  "is_statement": true,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "montant": 0.00,
      "categorie": "Courses",
      "categorie_confidence": "high",
      "enseigne": "Leclerc",
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
  const response = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${buildMultiPrompt(refs)}\n\nContenu OCR :\n---\n${ocrText}\n---`,
      },
    ],
    maxTokens: 2000,
    responseFormat: { type: 'json_object' },
  });

  const parsed = parseJSON(response.choices[0].message.content);

  // Normalise : si l'IA retourne un objet simple (rétro-compat), l'emballe
  if (Array.isArray(parsed)) return { is_statement: false, transactions: parsed };
  if (parsed.transactions) return parsed;
  return { is_statement: false, transactions: [parsed] };
}
