const SUPABASE_URL = 'https://hkhhonbhrsxinixughhw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_gtebuA6Z4Q6rApFAUQVFWg_vgc0Rykx';
const OVH_AK = 'abe2d11f2035e322';
const OVH_AS = '1aca44215b5fd7bf6894cc033622c857';
const OVH_CK = '06721f8650302a5a424472463c3394a0';
const OVH_SERVICE = 'sms-lq44011-1';
const OVH_SENDER = 'PSLBatiment';

async function getPrix(corpsMetier, description) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/prestations?actif=eq.true&order=confiance.desc&limit=50`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const prestations = await res.json();

  // Cherche les prestations correspondantes
  const motsDescription = description.toLowerCase().split(' ');
  let meilleures = prestations.filter(p => {
    const labelLower = p.label.toLowerCase();
    const corpsOk = !corpsMetier || p.corps_metier === corpsMetier;
    const motOk = motsDescription.some(mot => mot.length > 3 && labelLower.includes(mot));
    return corpsOk && motOk;
  });

  if (!meilleures.length) meilleures = prestations.filter(p => p.corps_metier === corpsMetier);
  if (!meilleures.length && prestations.length) meilleures = prestations.slice(0, 3);

  return meilleures.slice(0, 3);
}

function calculerFourchette(prestations, quantite, region) {
  const coeffRegion = { 'idf': 1.25, 'grande_ville': 1.15, 'province': 1.0, 'rural': 0.9 };
  const coeff = coeffRegion[region] || 1.0;
  const qte = parseFloat(quantite) || 1;

  let minTotal = 0, maxTotal = 0;
  let confiance = 60;

  if (prestations.length > 0) {
    const p = prestations[0];
    const unite = p.unite;
    const facteur = (unite === 'forfait') ? 1 : qte;
    minTotal = Math.round(p.prix_min * facteur * coeff);
    maxTotal = Math.round(p.prix_max * facteur * coeff);
    confiance = p.confiance;
  }

  return { min: minTotal, max: maxTotal, confiance };
}

async function sha1Hex(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function envoyerSMS(telephone, message) {
  const telFormate = telephone.replace(/\s/g, '').replace(/^0/, '+33');
  const url = `https://eu.api.ovh.com/1.0/sms/${OVH_SERVICE}/jobs`;
  const now = Math.round(Date.now() / 1000);
  const body = JSON.stringify({
    message,
    receivers: [telFormate],
    sender: OVH_SENDER,
    noStopClause: false
  });

  const toSign = `${OVH_AS}+${OVH_CK}+POST+${url}+${body}+${now}`;
  const signature = '$1$' + await sha1Hex(toSign);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Ovh-Application': OVH_AK,
      'X-Ovh-Consumer': OVH_CK,
      'X-Ovh-Timestamp': now.toString(),
      'X-Ovh-Signature': signature
    },
    body
  });
  const data = await res.json();
  console.log('OVH SMS response:', JSON.stringify(data));
  return res.ok;
}

async function sauvegarderAppel(data) {
  await fetch(`${SUPABASE_URL}/rest/v1/appels_clients`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body;
    console.log('Webhook reçu:', JSON.stringify(body));

    // Vapi envoie les données dans différents formats selon l'événement
    const message = body.message || body;
    const type = message.type || body.type;

    // On traite uniquement la fin d'appel
    if (type !== 'end-of-call-report' && type !== 'call.ended') {
      return res.status(200).json({ ok: true, ignored: true });
    }

    // Extraction des données du transcript
    const transcript = message.transcript || message.call?.transcript || '';
    const metadata = message.call?.metadata || message.metadata || {};

    // Extraction intelligente depuis le transcript
    const telMatch = transcript.match(/0[67]\s*\d{2}\s*\d{2}\s*\d{2}\s*\d{2}|0[1-5]\s*\d{2}\s*\d{2}\s*\d{2}\s*\d{2}/);
    const telephone = telMatch ? telMatch[0].replace(/\s/g, '') : metadata.telephone || null;

    const prenomMatch = transcript.match(/je m'appelle ([A-ZÀ-Ÿa-zà-ÿ]+)|mon prénom est ([A-ZÀ-Ÿa-zà-ÿ]+)|c'est ([A-ZÀ-Ÿa-zà-ÿ]+)/i);
    const prenom = prenomMatch ? (prenomMatch[1] || prenomMatch[2] || prenomMatch[3]) : 'Client';

    const surfaceMatch = transcript.match(/(\d+)\s*m[èe]?t?r?e?s?\s*carr[eé]s?|(\d+)\s*m²/i);
    const quantite = surfaceMatch ? parseInt(surfaceMatch[1] || surfaceMatch[2]) : 1;

    const regionMatch = transcript.match(/paris|île[- ]de[- ]france|idf/i) ? 'idf'
      : transcript.match(/lyon|bordeaux|marseille|toulouse|nice|nantes|strasbourg|lille|montpellier/i) ? 'grande_ville'
      : transcript.match(/rural|campagne|village/i) ? 'rural' : 'province';

    const corpsMatch = transcript.match(/carrelage|carrel/i) ? 'carrelage'
      : transcript.match(/peinture|peindre/i) ? 'peinture'
      : transcript.match(/plomberie|plombier|fuite|tuyau/i) ? 'plomberie'
      : transcript.match(/électricité|électricien|tableau|prise/i) ? 'electricite'
      : transcript.match(/menuiserie|porte|fenêtre|parquet/i) ? 'menuiserie'
      : transcript.match(/toiture|toit|couverture|charpente/i) ? 'charpente'
      : transcript.match(/isolation|isoler|combles/i) ? 'isolation'
      : transcript.match(/chauffage|chaudière|climatisation|clim/i) ? 'chauffage'
      : transcript.match(/maçonnerie|maçon|mur|béton|chape/i) ? 'maconnerie'
      : 'renovation';

    // Calcul de la fourchette
    const prestations = await getPrix(corpsMatch, transcript);
    const fourchette = calculerFourchette(prestations, quantite, regionMatch);

    // Sauvegarde dans Supabase
    await sauvegarderAppel({
      nom_client: prenom,
      telephone: telephone,
      description_travaux: transcript.substring(0, 500),
      corps_metier: corpsMatch,
      quantite_estimee: quantite,
      region: regionMatch,
      devis_min: fourchette.min,
      devis_max: fourchette.max,
      statut: 'en_attente'
    });

    // Envoi SMS si on a un numéro
    if (telephone) {
      const sms = `Bonjour ${prenom}, voici votre estimation PSL Bâtiment :

Travaux : ${corpsMatch} — ${quantite}m²
Fourchette : ${fourchette.min.toLocaleString('fr-FR')}€ à ${fourchette.max.toLocaleString('fr-FR')}€ HT
Confiance : ${fourchette.confiance}%

Cette estimation est indicative. Un technicien PSL Bâtiment vous contactera pour affiner ce devis lors d'une visite gratuite.

PSL Bâtiment — 0X XX XX XX XX`;

      await envoyerSMS(telephone, sms);
    }

    return res.status(200).json({
      ok: true,
      telephone,
      fourchette,
      sms_envoye: !!telephone
    });

  } catch(err) {
    console.error('Erreur webhook:', err);
    return res.status(500).json({ error: err.message });
  }
}
