/**
 * homeAImatch — AI Scoring Service
 * Uses Claude Sonnet 4.5 to score properties against buyer profiles.
 * Falls back to rule-based scoring if API key is not set.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYSTEM_PROMPT_EN = `You are homeAImatch, an AI property matching assistant for Portugal's Silver Coast. You score how well a property matches a buyer's lifestyle.

IMPORTANT: Property descriptions are often in Portuguese. Read and understand them fully — extract details about views, renovation, outdoor space, nearby amenities, neighbourhood character, etc.

SCORING PHILOSOPHY: These properties have ALREADY been pre-filtered to match the buyer's budget and basic requirements. Start from a baseline of 65 (decent match) and adjust up or down.

SCORE GUIDE:
- 85-95: Excellent match — hits most buyer priorities, great value, strong lifestyle fit
- 75-84: Good match — solid on fundamentals, some nice bonuses
- 65-74: Decent match — meets basics but missing some preferences
- 50-64: Weak match — meets budget but poor lifestyle/feature fit
- Below 50: Bad match — significant misalignment

CRITERIA (adjust from 65 baseline):
+10-15: Budget sweet spot (well under max budget, great value for size/location)
+5-10: Perfect area type match (beach town, historic, urban, countryside as requested)
+5-10: Key features found in property/description (pool, garden, sea view, etc.)
+3-8: Neighbourhood vibe match (family-friendly, nightlife, artsy, quiet, surf, local community — read the description and location for clues about the area's character)
+3-8: Transport/walkability alignment
+3-5: Buyer-type specific (schools for families, healthcare for retirees, office space for remote workers)
+2-5: Priority matches (beach proximity, restaurants, peace & quiet, nature, etc.)
-5-10: Missing critical features buyer specifically requested
-5-10: Area type or vibe mismatch
-3-5: Condition mismatch

ALWAYS respond in English. Return ONLY a JSON object (no markdown, no backticks):
{
  "score": 84,
  "highlights": ["€93K under budget — great value", "Walkable beach town vibe matches perfectly", "Modern kitchen as requested"],
  "concerns": ["No garden — buyer wanted outdoor space"],
  "reasoning": "Strong match for a beach-loving couple. The apartment is well under budget, in a family-friendly coastal area with the laid-back surf vibe they want, walkable to the beach and local restaurants."
}`;

const SYSTEM_PROMPT_PT = `Você é o homeAImatch, um assistente de IA para correspondência de imóveis na Costa de Prata de Portugal. Avalia o quão bem um imóvel corresponde ao estilo de vida de um comprador.

IMPORTANTE: As descrições podem estar em Português ou Inglês. Leia e compreenda totalmente — extraia detalhes sobre vistas, renovação, espaço exterior, comodidades, carácter do bairro, etc.

FILOSOFIA DE PONTUAÇÃO: Estes imóveis JÁ foram pré-filtrados para corresponder ao orçamento e requisitos básicos. Comece de uma base de 65 e ajuste.

GUIA DE PONTUAÇÃO:
- 85-95: Excelente — corresponde à maioria das prioridades, bom valor, forte encaixe
- 75-84: Bom — sólido nos fundamentais, alguns bónus
- 65-74: Razoável — cumpre o básico mas falta preferências
- 50-64: Fraco — cumpre orçamento mas fraco no estilo de vida
- Abaixo de 50: Mau — desalinhamento significativo

CRITÉRIOS (ajustar a partir da base 65):
+10-15: Preço ideal (bem abaixo do máximo, excelente valor)
+5-10: Tipo de zona perfeito (praia, histórico, urbano, campo)
+5-10: Características encontradas (piscina, jardim, vista mar, etc.)
+3-8: Ambiente do bairro corresponde (familiar, vida noturna, artístico, calmo, surf, comunidade local — leia a descrição e localização)
+3-8: Alinhamento transporte/caminhabilidade
+3-5: Correspondência tipo de comprador (escolas, saúde, escritório)
+2-5: Prioridades diárias (praia, restaurantes, sossego, natureza)
-5-10: Faltam características pedidas
-5-10: Zona ou ambiente não corresponde
-3-5: Condição não corresponde

RESPONDA SEMPRE em Português de Portugal. Devolve APENAS um objecto JSON (sem markdown, sem backticks):
{
  "score": 84,
  "highlights": ["€93K abaixo do orçamento — excelente valor", "Zona de praia com ambiente descontraído", "Cozinha moderna como pedido"],
  "concerns": ["Sem jardim — comprador queria espaço exterior"],
  "reasoning": "Forte correspondência para um casal costeiro. Bem abaixo do orçamento, zona familiar perto da praia com o ambiente tranquilo que procuram."
}`;

/**
 * Score a single property against a buyer profile using Claude
 */
export async function scoreWithAI(buyerProfile, property, enrichment) {
  if (!client) {
    return scoreWithRules(buyerProfile, property, enrichment);
  }

  const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);

  const prompt = `
BUYER PROFILE:
- Buyer type: ${buyerProfile.buyer_type || 'Not specified'}
- Transport: ${buyerProfile.transport || 'Not specified'}
- Budget: €${(buyerProfile.budget_min || 0).toLocaleString()} – €${(buyerProfile.budget_max || 0).toLocaleString()}
- Min beds: ${buyerProfile.min_beds || 'Any'}, Min baths: ${buyerProfile.min_baths || 'Any'}, Min size: ${buyerProfile.min_sqm || 'Any'}m²
- Condition: ${buyerProfile.property_condition || 'Any'}
- Outdoor space: ${buyerProfile.outdoor_space || 'Not specified'}
- Desired features: ${toArr(buyerProfile.features).join(', ') || 'None specified'}
- Area preference: ${buyerProfile.setting || 'Flexible'}
- Neighbourhood vibe wanted: ${toArr(buyerProfile.vibe).join(', ') || 'Not specified'}
- Daily priorities: ${toArr(buyerProfile.priorities).join(', ') || 'None specified'}
- Pets: ${buyerProfile.pets || 'None'}
- Parking: ${buyerProfile.parking || 'Not specified'}
- Purpose: ${buyerProfile.purpose || 'Not specified'}

PROPERTY:
- Title: ${property.title}
- Price: €${property.price?.toLocaleString()} (${property.price <= (buyerProfile.budget_max || 9999999) ? '€' + ((buyerProfile.budget_max || 0) - property.price).toLocaleString() + ' under max budget' : 'OVER budget'})
- Beds: ${property.beds}, Baths: ${property.baths}, Size: ${property.sqm || '?'}m²
- Type: ${property.property_type}, Condition: ${property.condition}
- City: ${property.city}, Area: ${property.region}
- Features: ${toArr(property.features).join(', ') || 'None listed'}
- Neighbourhood vibe tags: ${toArr(property.neighborhood_vibe).join(', ') || 'None tagged'}
- Parking: ${toArr(property.parking).join(', ') || 'None'}
- Pet-friendly: ${property.pet_friendly || 'Unknown'}
- EPC: ${property.epc_rating || 'Unknown'}
- Description: ${(property.description || '').slice(0, 400)}
${enrichment ? `
NEIGHBOURHOOD DATA:
- Walkability: ${enrichment.walkability}/10 (${enrichment.walkability_label || ''})
- Type: ${enrichment.neighborhood_type || 'Unknown'}
- Computed vibe: ${(enrichment.computed_vibe || []).join(', ') || 'Not computed'}
- Schools: ${enrichment.schools || '?'} (${enrichment.schools_count_2km || 0} within 2km)
- Restaurants: ${enrichment.restaurants_count_1km || 0}, Bars: ${enrichment.bars_count_1km || 0}, Shops: ${enrichment.shops_count_1km || 0} within 1km
- Transport: ${enrichment.transport_count_500m || 0} stops, Cycling: ${enrichment.cycling_count_500m || 0} bike facilities within 500m
- Pharmacies: ${enrichment.pharmacies_count_1km || 0} within 1km${enrichment.nearest_pharmacy ? ' (nearest: ' + enrichment.nearest_pharmacy.name + ' ' + enrichment.nearest_pharmacy.distance_km + 'km)' : ''}
- Hospitals/clinics: ${enrichment.hospitals_count_5km || 0} within 5km${enrichment.nearest_hospital ? ' (nearest: ' + enrichment.nearest_hospital.name + ' ' + enrichment.nearest_hospital.distance_km + 'km)' : ''}
- Parks: ${enrichment.parks_count_1km || 0}, Playgrounds: ${enrichment.playgrounds_count_1km || 0} within 1km
- Tourism/culture: ${enrichment.tourism_count_2km || 0} within 2km${enrichment.is_historic_area ? ' (HISTORIC AREA)' : ''}
- EV charging: ${enrichment.ev_charging_count_2km || 0} stations within 2km
- Coworking: ${enrichment.coworking_count_2km || 0} spaces within 2km
- Beach: ${enrichment.beach_nearby ? 'Yes — ' + (enrichment.nearest_beach?.name || '') + ' (' + (enrichment.nearest_beach?.distance_km || '?') + ' km)' : 'No'}
- Airport: ${enrichment.nearest_airport ? enrichment.nearest_airport.name + ' (' + enrichment.nearest_airport.distance_km + ' km)' : 'No major airport nearby'}
` : ''}
Score this property. Baseline is 65 — adjust based on how well it fits this buyer's lifestyle, vibe preferences, and priorities.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: buyerProfile.language === 'pt' ? SYSTEM_PROMPT_PT : SYSTEM_PROMPT_EN,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('AI scoring error:', err.message);
    return scoreWithRules(buyerProfile, property, enrichment);
  }
}

/**
 * Score multiple properties, return top results sorted by score
 */
export async function scoreProperties(buyerProfile, propertiesWithEnrichment) {
  const BATCH_SIZE = 5;
  const results = [];

  for (let i = 0; i < propertiesWithEnrichment.length; i += BATCH_SIZE) {
    const batch = propertiesWithEnrichment.slice(i, i + BATCH_SIZE);
    const scores = await Promise.all(
      batch.map(({ property, enrichment }) =>
        scoreWithAI(buyerProfile, property, enrichment)
      )
    );

    for (let j = 0; j < batch.length; j++) {
      results.push({
        property: batch[j].property,
        enrichment: batch[j].enrichment,
        score: scores[j],
      });
    }
  }

  results.sort((a, b) => (b.score?.score || 0) - (a.score?.score || 0));
  return results.slice(0, 5);
}

/**
 * Generate a buyer persona from quiz answers
 */
export async function generatePersona(profile) {
  if (!client) {
    return fallbackPersona(profile);
  }

  try {
    const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 250,
      messages: [{
        role: 'user',
        content: `Based on this home buyer profile, create a fun buyer persona with an emoji and title. Write a 3-4 sentence description that captures their personality, what they're looking for, and what kind of lifestyle they want. Be warm, specific, and paint a vivid picture. Respond in ${profile.language === 'pt' ? 'Portuguese (European/Portugal)' : 'English'}.
Profile: ${profile.buyer_type || 'Home buyer'}, searching on the Silver Coast Portugal, budget €${(profile.budget_min || 0).toLocaleString()}–€${(profile.budget_max || 0).toLocaleString()}, wants ${profile.outdoor_space || 'flexible'} outdoor space, area: ${profile.setting || 'flexible'}, vibe: ${toArr(profile.vibe).join(', ') || 'not specified'}, priorities: ${toArr(profile.priorities).join(', ') || 'none specified'}, pets: ${profile.pets || 'none'}, transport: ${profile.transport || 'car'}, features: ${toArr(profile.features).join(', ') || 'none'}, purpose: ${profile.purpose || 'primary home'}.
Return ONLY JSON: { "emoji": "🌿", "title": "The Urban Gardener", "description": "..." }`
      }],
    });

    const text = response.content[0]?.text || '';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (err) {
    console.error('Persona error:', err.message);
    return fallbackPersona(profile);
  }
}

/**
 * Rule-based fallback scoring — starts at 65 baseline
 */
function scoreWithRules(profile, property, enrichment) {
  let score = 65;
  const highlights = [];
  const concerns = [];
  const pt = profile.language === 'pt';

  // Budget (+12 / -10)
  const price = property.price || 0;
  const bMax = profile.budget_max || 9999999;
  const bMin = profile.budget_min || 0;
  if (price >= bMin && price <= bMax) {
    const savings = bMax - price;
    const savingsPct = bMax > 0 ? savings / bMax : 0;
    if (savingsPct >= 0.3) { score += 12; highlights.push(pt ? `€${Math.round(savings/1000)}K abaixo do orçamento` : `€${Math.round(savings/1000)}K under budget`); }
    else if (savingsPct >= 0.15) { score += 8; highlights.push(pt ? 'Bem dentro do orçamento' : 'Well within budget'); }
    else { score += 4; }
  } else if (price <= bMax * 1.1) {
    score -= 3;
    concerns.push(pt ? 'Ligeiramente acima do orçamento' : 'Slightly above budget');
  } else {
    score -= 10;
    concerns.push(pt ? 'Acima do orçamento' : 'Above budget');
  }

  // Size & beds (+8 / -5)
  if (profile.min_sqm && profile.min_sqm > 0 && property.sqm) {
    if (property.sqm >= profile.min_sqm * 1.2) { score += 5; highlights.push(pt ? `${property.sqm}m² — espaçoso` : `${property.sqm}m² — spacious`); }
    else if (property.sqm >= profile.min_sqm) { score += 3; }
    else { score -= 3; }
  }
  if (property.beds >= (profile.min_beds || 1)) { score += 3; }
  else { score -= 5; concerns.push(pt ? 'Quartos insuficientes' : 'Not enough bedrooms'); }

  // Walkability & transport (+10 / -5)
  const transport = (profile.transport || '').toLowerCase();
  const walkScore = enrichment?.walkability ?? property.walkability;
  const needsWalk = transport.includes('walking') || transport.includes('pé') || transport.includes('public') || transport.includes('público') || transport.includes('bicycle') || transport.includes('bicicleta');
  if (needsWalk) {
    if (walkScore >= 7) { score += 8; highlights.push(pt ? `Caminhável (${walkScore}/10)` : `Walkable (${walkScore}/10)`); }
    else if (walkScore >= 5) { score += 4; }
    else if (walkScore != null && walkScore < 3) { score -= 5; concerns.push(pt ? 'Dependente de carro' : 'Car-dependent'); }
    if (enrichment?.transport_count_500m >= 2) { score += 2; }
  } else {
    if (walkScore >= 7) { score += 3; }
  }

  // Area type (+8 / -3)
  const setting = (profile.setting || '').toLowerCase();
  if (setting.includes('beach') || setting.includes('praia')) {
    if (enrichment?.beach_nearby) { score += 8; highlights.push(pt ? `Praia a ${enrichment.nearest_beach?.distance_km || '?'} km` : `Beach ${enrichment.nearest_beach?.distance_km || '?'} km`); }
    else { score -= 3; }
  } else if (setting.includes('urban') || setting.includes('urbano')) {
    if (enrichment?.neighborhood_type === 'urban' || walkScore >= 7) { score += 6; }
  } else if (setting.includes('country') || setting.includes('campo')) {
    if (enrichment?.neighborhood_type === 'rural') { score += 6; }
  } else { score += 3; }
  if (!setting.includes('beach') && !setting.includes('praia') && enrichment?.beach_nearby) { score += 2; }

  // Neighbourhood vibe match (+6 max)
  const vibes = (profile.vibe || []).map(v => v.toLowerCase());
  const pVibes = (property.neighborhood_vibe || []).map(v => v.toLowerCase());
  const desc = (property.description || '').toLowerCase();
  let vibeHits = 0;
  vibes.forEach(v => {
    if (v.includes('family') || v.includes('familiar')) { if (pVibes.some(pv => pv.includes('family')) || desc.includes('familiar') || desc.includes('family') || desc.includes('tranquil')) vibeHits++; }
    else if (v.includes('nightlife') || v.includes('noturna')) { if (pVibes.some(pv => pv.includes('nightlife')) || enrichment?.restaurants_count_1km >= 5) vibeHits++; }
    else if (v.includes('artsy') || v.includes('artístico') || v.includes('artistico')) { if (pVibes.some(pv => pv.includes('artsy') || pv.includes('creative'))) vibeHits++; }
    else if (v.includes('quiet') || v.includes('calmo') || v.includes('tranquilo')) { if (pVibes.some(pv => pv.includes('quiet') || pv.includes('peaceful')) || (walkScore != null && walkScore <= 5)) vibeHits++; }
    else if (v.includes('nature') || v.includes('natureza')) { if (pVibes.some(pv => pv.includes('nature')) || enrichment?.parks_count_1km >= 2 || enrichment?.neighborhood_type === 'rural') vibeHits++; }
    else if (v.includes('upscale') || v.includes('sofisticado') || v.includes('exclusivo')) { if (pVibes.some(pv => pv.includes('upscale') || pv.includes('luxury'))) vibeHits++; }
    else if (v.includes('surf') || v.includes('descontraído') || v.includes('laid-back')) { if (enrichment?.beach_nearby || desc.includes('surf') || desc.includes('praia')) vibeHits++; }
    else if (v.includes('community') || v.includes('comunidade')) { if (desc.includes('comunidade') || desc.includes('community') || desc.includes('aldeia') || desc.includes('village')) vibeHits++; }
  });
  score += Math.min(vibeHits * 3, 6);

  // Buyer type (+5)
  const bt = (profile.buyer_type || '').toLowerCase();
  if (bt.includes('retired') || bt.includes('reformado')) {
    if (enrichment?.hospitals_count_5km >= 1) { score += 4; }
    else if (enrichment?.pharmacies_count_1km >= 1) { score += 2; }
  }
  if ((bt.includes('family') || bt.includes('família')) && ['excellent','good'].includes(enrichment?.schools)) { score += 4; highlights.push(pt ? 'Boas escolas perto' : 'Good schools nearby'); }
  if ((bt.includes('family') || bt.includes('família')) && enrichment?.playgrounds_count_1km >= 1) { score += 3; highlights.push(pt ? 'Parques infantis perto' : 'Playgrounds nearby'); }
  if ((bt.includes('remote') || bt.includes('remoto')) && property.sqm >= 100) { score += 2; }

  // Priorities (+3 each, max +12)
  const prios = (profile.priorities || []).map(p => p.toLowerCase());
  let hits = 0;
  if (prios.some(p => p.includes('beach') || p.includes('praia')) && enrichment?.beach_nearby) hits++;
  if (prios.some(p => p.includes('school') || p.includes('escola')) && ['excellent','good'].includes(enrichment?.schools)) hits++;
  if (prios.some(p => p.includes('walkable') || p.includes('caminhável')) && walkScore >= 7) hits++;
  if (prios.some(p => p.includes('restaurant') || p.includes('restaurante')) && enrichment?.restaurants_count_1km >= 3) hits++;
  if (prios.some(p => p.includes('hospital') || p.includes('saúde') || p.includes('healthcare')) && (enrichment?.hospitals_count_5km >= 1 || enrichment?.healthcare_count_1km >= 1)) hits++;
  if (prios.some(p => p.includes('peace') || p.includes('paz') || p.includes('sossego')) && walkScore <= 5) hits++;
  if (prios.some(p => p.includes('nature') || p.includes('natureza')) && enrichment?.parks_count_1km >= 2) hits++;
  if (prios.some(p => p.includes('playground') || p.includes('infantil') || p.includes('infantis')) && enrichment?.playgrounds_count_1km >= 1) hits++;
  score += Math.min(hits * 3, 12);

  // Convenience (+3)
  if (enrichment?.shops_count_1km >= 3 && enrichment?.restaurants_count_1km >= 3) { score += 3; }

  // Pets (+3 / -3)
  const pets = (profile.pets || '').toLowerCase();
  if (pets.includes('dog') || pets.includes('cão') || pets.includes('cat') || pets.includes('gato')) {
    if (property.pet_friendly) { score += 3; }
    else { score -= 3; concerns.push(pt ? 'Não aceita animais' : 'Not pet-friendly'); }
  }

  return {
    score: Math.min(98, Math.max(30, score)),
    highlights: highlights.slice(0, 5),
    concerns: concerns.slice(0, 3),
    reasoning: pt
      ? `Pontuação baseada em orçamento, localização, ambiente, caminhabilidade (${walkScore || '?'}/10) e prioridades.`
      : `Score based on budget, location, vibe, walkability (${walkScore || '?'}/10), and priorities.`,
  };
}

function fallbackPersona(profile) {
  const bt = (profile.buyer_type || '').toLowerCase();
  if (bt.includes('retired') || bt.includes('reformado')) return { emoji: '🌅', title: 'The Retirement Explorer', description: 'Time to live where you\'ve always dreamed.' };
  if (bt.includes('remote') || bt.includes('remoto')) return { emoji: '💻', title: 'The Digital Nomad', description: 'Freedom to live wherever inspires you.' };
  if (bt.includes('family') || bt.includes('família')) return { emoji: '👨‍👩‍👧‍👦', title: 'The Family Builder', description: 'Schools, garden, safety — everything for a happy family.' };
  if (bt.includes('couple') || bt.includes('casal')) return { emoji: '💑', title: 'The Adventure Couple', description: 'Building a future together in a new place.' };
  if (bt.includes('investor') || bt.includes('investidor')) return { emoji: '📈', title: 'The Strategic Investor', description: 'Eye on returns and appreciation potential.' };
  if (bt.includes('student') || bt.includes('estudante')) return { emoji: '🎓', title: 'The Smart Student', description: 'Smart budget, great location.' };
  return { emoji: '🏡', title: 'The Smart Buyer', description: 'Methodical, informed, and ready to find the perfect fit.' };
}
