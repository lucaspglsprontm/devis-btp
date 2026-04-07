const SUPABASE_URL = 'https://hkhhonbhrsxinixughhw.supabase.co';
const SUPABASE_KEY = 'sb_publishable_gtebuA6Z4Q6rApFAUQVFWg_vgc0Rykx';
const BREVO_KEY = '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';

async function getPrix(corpsMetier, transcript) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/prestations?actif=eq.true&order=confiance.desc&limit=50`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const prestations = await res.json();
  const mots = transcript.toLowerCase().split(' ');
  let trouvees = prestations.filter(p => {
    const label = p.label.toLowerCase();
    const corpsOk = !corpsMetier || p.corps_metier === corpsMetier;
    const motOk = mots.some(m => m.length > 3 && label.includes(m));
    return corpsOk && motOk;
  });
  if (!trouvees.length) trouvees = prestations.filter(p => p.corps_metier === corpsMetier);
  if (!trouvees.length) trouvees = prestations.slice(0, 3);
  return trouvees.slice(0, 3);
}

function detecterInfos(transcript) {
  const tel = transcript.match(/0[67]\s*\d{2}\s*\d{2}\s*\d{2}\s*\d{2}|0[1-5]\s*\d{2}\s*\d{2}\s*\d{2}\s*\d{2}/);
  const prenom = transcript.match(/je m'appelle ([A-ZÀ-Ÿa-zà-ÿ]+)|mon prénom est ([A-ZÀ-Ÿa-zà-ÿ]+)/i);
  const surface = transcript.match(/(\d+)\s*m[²e]/i);
  const region = /paris|île-de-france/i.test(transcript) ? 'idf'
    : /lyon|bordeaux|marseille|toulouse|nice|nantes|lille/i.test(transcript) ? 'grande_ville'
    : /rural|campagne/i.test(transcript) ? 'rural' : 'province';
  const corps = /carrelage/i.test(transcript) ? 'carrelage'
    : /peinture/i.test(transcript) ? 'peinture'
    : /plomberie|fuite/i.test(transcript) ? 'plomberie'
    : /électricité|électricien/i.test(transcript) ? 'electricite'
    : /menuiserie|porte|fenêtre/i.test(transcript) ? 'menuiserie'
    : /toiture|toit/i.test(transcript) ? 'charpente'
    : /isolation/i.test(transcript) ? 'isolation'
    : /chauffage|clim/i.test(transcript) ? 'chauffage'
    : /maçonnerie|béton/i.test(transcript) ? 'maconnerie' : 'renovation';
  return {
    telephone: tel ? tel[0].replace(/\s/g,'') : null,
    prenom: prenom ? (prenom[1]||prenom[2]) : 'Client',
    quantite: surface ? parseInt(surface[1]) : 1,
    region, corps
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const body = req.body;
    const type = body.message?.type || body.type;
    if (type !== 'end-of-call-report' && type !== 'call.ended') {
      return res.status(200).json({ ok: true });
    }
    const transcript = body.message?.transcript || body.transcript || '';
    const infos = detecterInfos(transcript);
    const prestations = await getPrix(infos.corps, transcript);
    const coeff = {idf:1.25,grande_ville:1.15,province:1.0,rural:0.9}[infos.region]||1;
    const p = prestations[0];
    const facteur = p?.unite === 'forfait' ? 1 : infos.quantite;
    const min = p ? Math.round(p.prix_min * facteur * coeff) : 0;
    const max = p ? Math.round(p.prix_max * facteur * coeff) : 0;
    const confiance = p?.confiance || 60;

    await fetch(`${SUPABASE_URL}/rest/v1/appels_clients`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ nom_client: infos.prenom, telephone: infos.telephone, description_travaux: transcript.substring(0,500), corps_metier: infos.corps, quantite_estimee: infos.quantite, region: infos.region, devis_min: min, devis_max: max, statut: 'en_attente' })
    });

    if (infos.telephone) {
      const tel = infos.telephone.replace(/^0/,'+33');
      await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: 'PSLBatiment',
          recipient: tel,
          content: `Bonjour ${infos.prenom}, voici votre estimation PSL Batiment :\n\nTravaux : ${infos.corps} (${infos.quantite}m2)\nEstimation : ${min.toLocaleString('fr-FR')}EUR a ${max.toLocaleString('fr-FR')}EUR HT\nConfiance : ${confiance}%\n\nUn technicien vous contactera pour une visite gratuite.\nPSL Batiment`
        })
      });
    }
    return res.status(200).json({ ok: true, min, max, sms: !!infos.telephone });
  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
