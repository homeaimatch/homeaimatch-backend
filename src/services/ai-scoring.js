/**
 * homeAImatch — AI Scoring Service
 * Uses Claude Sonnet 4.5 to score properties against buyer profiles.
 * Falls back to rule-based scoring if API key is not set.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYSTEM_PROMPT_EN = `You are homeAImatch, an AI property matching assistant for Portugal and Ireland. You score how well a property matches a buyer's lifestyle profile.

IMPORTANT: Property descriptions may be in Portuguese, English, or other languages. Understand them in any language but ALWAYS respond in English. Use the description to extract useful details about the property (views, renovation status, nearby amenities, etc.) for scoring.

Score the property from 0-100 based on these weighted criteria:
- Location & Area (20 pts): Does the neighbourhood vibe match? Urban vs suburban vs rural preference?
- Budget Fit (20 pts): Is price within or close to their range? Slightly under budget = bonus.
- Commute (15 pts): How close to their commute priority? Under 20 min = excellent.
- Space & Layout (10 pts): Enough beds for family size? Garden if they want outdoor space?
- Condition (10 pts): Does move-in/renovation match their preference?
- Lifestyle (8 pts): Walkability, nearby restaurants/pubs, gym access for active lifestyles.
- Vibe Match (7 pts): Does neighbourhood feel match what they described?
- Pet Friendly (5 pts): Pet-friendly if they have pets? Dog park nearby?
- Parking (3 pts): Does parking match their needs?
- Style (2 pts): Bonus for preferred architectural style match.

Return ONLY a JSON object (no markdown, no backticks):
{
  "score": 82,
  "highlights": ["15 min walk to city centre", "Large garden for the dog", "Excellent schools nearby"],
  "concerns": ["Slightly above budget", "No garage for EV charging"],
  "reasoning": "A strong match for a family wanting walkability and green space. The Edwardian character fits their 'charming' vibe preference, and Didsbury's village feel scores high on their family-friendly priority."
}`;

const SYSTEM_PROMPT_PT = `Você é o homeAImatch, um assistente de IA para correspondência de imóveis em Portugal e Irlanda. Avalia o quão bem um imóvel corresponde ao perfil de estilo de vida de um comprador.

IMPORTANTE: As descrições dos imóveis podem estar em Português, Inglês ou outros idiomas. Compreenda-as em qualquer idioma mas RESPONDA SEMPRE em Português de Portugal. Use a descrição para extrair detalhes úteis sobre o imóvel (vistas, estado de renovação, comodidades próximas, etc.) para a avaliação.

Avalie o imóvel de 0-100 com base nestes critérios ponderados:
- Localização (20 pts): A zona corresponde? Urbano vs suburbano vs rural?
- Orçamento (20 pts): O preço está dentro do intervalo? Abaixo do orçamento = bónus.
- Deslocação (15 pts): Quão perto da prioridade de deslocação? Menos de 20 min = excelente.
- Espaço (10 pts): Quartos suficientes? Jardim se querem espaço exterior?
- Condição (10 pts): Pronto a habitar ou renovação corresponde à preferência?
- Estilo de vida (8 pts): Caminhabilidade, restaurantes, ginásio.
- Ambiente (7 pts): A sensação do bairro corresponde?
- Animais (5 pts): Aceita animais? Parque canino perto?
- Estacionamento (3 pts): Corresponde às necessidades?
- Estilo (2 pts): Bónus para estilo arquitectónico preferido.

Devolve APENAS um objecto JSON (sem markdown, sem backticks):
{
  "score": 82,
  "highlights": ["15 min a pé do centro", "Jardim grande para o cão", "Escolas excelentes perto"],
  "concerns": ["Ligeiramente acima do orçamento", "Sem garagem"],
  "reasoning": "Uma excelente correspondência para uma família que valoriza caminhabilidade e espaços verdes."
}`;

/**
 * Score a single property against a buyer profile using Claude
 */
export async function scoreWithAI(buyerProfile, property, enrichment) {
  if (!client) {
    return scoreWithRules(buyerProfile, property, enrichment);
  }

  // Helper: ensure value is an array for .join()
  const toArr = (v) => Array.isArray(v) ? v : (v ? [v] : []);

  const prompt = `
BUYER PROFILE:
- Buyer type: ${buyerProfile.buyer_type || 'Not specified'}
- Transport: ${buyerProfile.transport || 'Not specified'}
- Budget: €${(buyerProfile.budget_min || 0).toLocaleString()} – €${(buyerProfile.budget_max || 0).toLocaleString()}
- Min bedrooms: ${buyerProfile.min_beds || 'Any'}
- Min bathrooms: ${buyerProfile.min_baths || 'Any'}
- Min size: ${buyerProfile.min_sqm || 'Any'} m²
- Property condition: ${buyerProfile.property_condition || 'Any'}
- Outdoor space: ${buyerProfile.outdoor_space || 'Not specified'}
- Required features: ${toArr(buyerProfile.features).join(', ') || 'None specified'}
- Area preference: ${buyerProfile.setting || 'Flexible'}
- Daily priorities: ${toArr(buyerProfile.priorities).join(', ') || 'None specified'}
- Pets: ${buyerProfile.pets || 'None'}
- Parking: ${buyerProfile.parking || 'Not specified'}
- Purpose: ${buyerProfile.purpose || 'Not specified'}

PROPERTY:
- Name: ${property.title}
- Price: €${property.price?.toLocaleString()}
- Beds: ${property.beds}, Baths: ${property.baths}
- Size: ${property.sqm}m²
- Type: ${property.property_type}, Style: ${property.style}
- Condition: ${property.condition}
- City: ${property.city}, Area: ${property.region}
- Features: ${toArr(property.features).join(', ')}
- Parking: ${toArr(property.parking).join(', ')}
- Pet-friendly: ${property.pet_friendly}
- Description: ${(property.description || '').slice(0, 300)}
${enrichment ? `
ENRICHMENT DATA (from surroundings analysis):
- Walkability: ${enrichment.walkability}/10 (${enrichment.walkability_label})
- Neighbourhood type: ${enrichment.neighborhood_type}
- Schools: ${enrichment.schools} (${enrichment.schools_count_2km} within 2km)
- Restaurants within 1km: ${enrichment.restaurants_count_1km}
- Cafes within 1km: ${enrichment.cafes_count_1km}
- Shops within 1km: ${enrichment.shops_count_1km}
- Transport stops within 500m: ${enrichment.transport_count_500m}
- Healthcare within 1km: ${enrichment.healthcare_count_1km}
- Parks within 1km: ${enrichment.parks_count_1km}
- Beach nearby: ${enrichment.beach_nearby ? 'Yes — ' + (enrichment.nearest_beach?.name || '') + ' (' + (enrichment.nearest_beach?.distance_km || '?') + ' km)' : 'No'}
- Nearest airport: ${enrichment.nearest_airport ? enrichment.nearest_airport.name + ' (' + enrichment.nearest_airport.distance_km + ' km)' : 'Unknown'}
- Sports facilities within 2km: ${enrichment.sports_count_2km}
` : ''}
Score this property for this buyer. Consider their buyer type, transport needs, and daily priorities carefully.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: buyerProfile.language === 'pt' ? SYSTEM_PROMPT_PT : SYSTEM_PROMPT_EN,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.text || '';
    // Parse JSON — handle potential markdown wrapping
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

  // Sort by score descending, return top 5
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
Profile: ${profile.buyer_type || 'Home buyer'}, searching on the Silver Coast Portugal, budget €${(profile.budget_min || 0).toLocaleString()}–€${(profile.budget_max || 0).toLocaleString()}, wants ${profile.outdoor_space || 'flexible'} outdoor space, area: ${profile.setting || 'flexible'}, priorities: ${toArr(profile.priorities).join(', ') || 'none specified'}, pets: ${profile.pets || 'none'}, transport: ${profile.transport || 'car'}, features: ${toArr(profile.features).join(', ') || 'none'}, purpose: ${profile.purpose || 'primary home'}.
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
 * Rule-based fallback scoring (no AI needed)
 */
function scoreWithRules(profile, property, enrichment) {
  let score = 50; // baseline
  const highlights = [];
  const concerns = [];
  const pt = profile.language === 'pt';

  // Budget fit (20 pts) — using exact min/max
  const price = property.price || 0;
  const bMax = profile.budget_max || 9999999;
  const bMin = profile.budget_min || 0;
  if (price >= bMin && price <= bMax) {
    score += 15;
    if (price <= bMax * 0.85) highlights.push(pt ? 'Bem dentro do orçamento' : 'Well within budget');
  } else if (price <= bMax * 1.1) {
    score += 5;
    concerns.push(pt ? 'Ligeiramente acima do orçamento' : 'Slightly above budget');
  } else {
    score -= 10;
    concerns.push(pt ? 'Acima do orçamento' : 'Above budget');
  }

  // Size fit
  if (profile.min_sqm && profile.min_sqm > 0 && property.sqm) {
    if (property.sqm >= profile.min_sqm) { score += 5; highlights.push(pt ? `${property.sqm}m² (mín. ${profile.min_sqm})` : `${property.sqm}m² (min. ${profile.min_sqm})`); }
  }

  // Beds fit
  if (property.beds >= (profile.min_beds || 1)) { score += 3; }

  // Transport & walkability
  const transport = (profile.transport || '').toLowerCase();
  const walkScore = enrichment?.walkability ?? property.walkability;
  const needsWalkability = transport.includes('walking') || transport.includes('pé') || transport.includes('public') || transport.includes('público') || transport.includes('bicycle') || transport.includes('bicicleta');

  if (needsWalkability) {
    if (walkScore >= 7) { score += 10; highlights.push(pt ? `Zona caminhável (${walkScore}/10)` : `Walkable area (${walkScore}/10)`); }
    else if (walkScore >= 5) { score += 5; }
    else if (walkScore != null && walkScore < 3) { score -= 3; concerns.push(pt ? 'Zona dependente de carro' : 'Car-dependent area'); }
    if (enrichment?.transport_count_500m >= 2) { score += 3; }
  } else {
    if (walkScore >= 7) { score += 5; highlights.push(pt ? `Zona caminhável (${walkScore}/10)` : `Walkable area (${walkScore}/10)`); }
    else if (walkScore >= 5) { score += 3; }
  }

  // Schools (important for families)
  const bt = (profile.buyer_type || '').toLowerCase();
  const schoolRating = enrichment?.schools || property.schools_quality;
  if (bt.includes('family') || bt.includes('família') || bt.includes('familia')) {
    if (schoolRating === 'excellent') { score += 6; highlights.push(pt ? 'Escolas excelentes perto' : 'Excellent schools nearby'); }
    else if (schoolRating === 'good') { score += 4; highlights.push(pt ? 'Boas escolas perto' : 'Good schools nearby'); }
  } else {
    if (schoolRating === 'excellent') { score += 3; }
    else if (schoolRating === 'good') { score += 2; }
  }

  // Beach proximity
  if (enrichment?.beach_nearby) { score += 4; highlights.push(pt ? `Praia perto (${enrichment.nearest_beach?.distance_km || '?'} km)` : `Beach nearby (${enrichment.nearest_beach?.distance_km || '?'} km)`); }

  // Shops & restaurants
  if (enrichment?.shops_count_1km >= 3 && enrichment?.restaurants_count_1km >= 3) {
    score += 3; highlights.push(pt ? 'Lojas e restaurantes perto' : 'Shops & restaurants nearby');
  }

  // Healthcare (important for retirees)
  if (enrichment?.healthcare_count_1km >= 1) { score += 1; }
  else if (enrichment?.healthcare_count_1km === 0) {
    if (bt.includes('retired') || bt.includes('reformado')) { score -= 3; concerns.push(pt ? 'Sem saúde a menos de 1km' : 'No healthcare within 1km'); }
    else { concerns.push(pt ? 'Sem saúde a menos de 1km' : 'No healthcare within 1km'); }
  }

  // Airport
  if (enrichment?.nearest_airport?.distance_km) {
    if (enrichment.nearest_airport.distance_km <= 30) highlights.push(pt ? `Aeroporto a ${enrichment.nearest_airport.distance_km} km` : `Airport ${enrichment.nearest_airport.distance_km} km`);
    else if (enrichment.nearest_airport.distance_km >= 80) concerns.push(pt ? `Aeroporto a ${enrichment.nearest_airport.distance_km} km` : `Airport ${enrichment.nearest_airport.distance_km} km away`);
  }

  // Pets
  const pets = (profile.pets || '').toLowerCase();
  if ((pets.includes('dog') || pets.includes('cão') || pets.includes('cao')) && property.pet_friendly) { score += 4; highlights.push(pt ? 'Aceita animais' : 'Pet-friendly'); }
  if ((pets.includes('dog') || pets.includes('cão') || pets.includes('cao')) && !property.pet_friendly) concerns.push(pt ? 'Não aceita animais' : 'Not pet-friendly');

  // Outdoor space
  const outdoor = (profile.outdoor_space || '').toLowerCase();
  if ((outdoor.includes('garden') || outdoor.includes('jardim')) && property.features?.some(f => f.includes('garden'))) { score += 4; highlights.push(pt ? 'Tem jardim' : 'Has garden'); }
  if ((outdoor.includes('large') || outdoor.includes('terreno')) && property.sqm >= 200) { score += 3; }

  // Parks
  if (enrichment?.parks_count_1km >= 2) { score += 2; }

  // Cap
  score = Math.min(100, Math.max(0, score));

  return {
    score,
    highlights: highlights.slice(0, 4),
    concerns: concerns.slice(0, 3),
    reasoning: pt
      ? `Pontuação baseada em orçamento, localização, caminhabilidade (${walkScore || '?'}/10), comodidades e estilo de vida.`
      : `Score based on budget, location, walkability (${walkScore || '?'}/10), amenities, and lifestyle fit.`,
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
