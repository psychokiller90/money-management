import { Mistral } from '@mistralai/mistralai';

const client = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures et tickets de caisse français.
Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte autour.
Si une information est absente ou illisible, utilise null.
Les confidences (categorie_confidence, enseigne_confidence) doivent refléter ta certitude :
- "high" si tu es sûr à >90 %
- "medium" si tu hésites entre 2 options
- "low" si l'image est floue ou les indices ambigus`;

function buildUserPrompt(refs) {
  const catList = refs.categories.map((c) => `"${c}"`).join(', ');
  const enseignesPerCat = refs.categories
    .map((c) => `  - ${c} : ${refs.enseignes[c].map((e) => `"${e}"`).join(', ') || '(aucune)'}`)
    .join('\n');

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

  if (!ocrText) {
    throw new Error('OCR a retourné un contenu vide.');
  }

  // 4) Chat completion text-only
  const response = await client.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${buildUserPrompt(refs)}\n\nContenu OCR de la facture :\n---\n${ocrText}\n---`,
      },
    ],
    maxTokens: 400,
    responseFormat: { type: 'json_object' },
  });

  return parseJSON(response.choices[0].message.content);
}
