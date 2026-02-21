/**
 * homeAImatch — AI Scoring Service
 * Uses Claude Sonnet 4.5 to score properties against buyer profiles.
 * Falls back to rule-based scoring if API key is not set.
 */

import Anthropic from '@anthropic-ai/sdk';

const client = process.env.ANTHROPIC_API_KEY 
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const SYSTEM_PROMPT = `You are homeAImatch, an AI property matching assistant. You score how well a property matches a buyer's lifestyle profile.

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
- City: ${buyerProfile.city}
- Budget: ${buyerProfile.budget_range}
- Family: ${buyerProfile.family_size}
- Commute priority: ${buyerProfile.commute_priority}
- Property condition: ${buyerProfile.property_condition}
- Outdoor space: ${buyerProfile.outdoor_space}
- Vibe preferences: ${toArr(buyerProfile.vibe).join(', ')}
- Pets: ${buyerProfile.pets}
- Parking needs: ${buyerProfile.parking}
- Dealbreakers: ${toArr(buyerProfile.dealbreakers).join(', ')}
- Priorities: ${toArr(buyerProfile.priorities).join(', ')}
- Lifestyle: ${toArr(buyerProfile.lifestyle).join(', ')}

PROPERTY:
- Name: ${property.title}
- Price: £${property.price?.toLocaleString()}
- Beds: ${property.beds}, Baths: ${property.baths}
- Size: ${property.sqm}m²
- Type: ${property.property_type}, Style: ${property.style}
- Condition: ${property.condition}
- City: ${property.city}, Area: ${property.region}
- Walkability: ${property.walkability}/10
- Schools: ${property.schools_quality}
- Parking: ${toArr(property.parking).join(', ')}
- Pet-friendly: ${property.pet_friendly}
- Dog park nearby: ${property.nearby_dog_park}
- Neighbourhood vibe: ${toArr(property.neighborhood_vibe).join(', ')}
- Features: ${toArr(property.features).join(', ')}
- Commute to city centre: ${property.commute_city_center} min
- EPC rating: ${property.epc_rating || 'Unknown'}
${enrichment ? `
ENRICHMENT DATA:
- Nearest grocery: ${enrichment.nearest_grocery_m}m (${enrichment.nearest_grocery_name})
- Nearest station: ${enrichment.nearest_station_m}m
- Nearest park: ${enrichment.nearest_park_m}m
- Restaurants within 1km: ${enrichment.restaurant_count_1km}
- Walk score: ${enrichment.walkability_score}/100
- Area avg price: £${enrichment.avg_price_area?.toLocaleString()}
- Price trend (1yr): ${enrichment.price_trend_1yr_pct}%
` : ''}
Score this property for this buyer.`;

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
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
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Based on this home buyer profile, create a fun 2-sentence buyer persona with an emoji and title.
Profile: ${profile.family_size}, searching in ${profile.city}, budget ${profile.budget_range}, wants ${profile.outdoor_space} outdoor space, vibe: ${Array.isArray(profile.vibe) ? profile.vibe.join(', ') : (profile.vibe || '')}, priorities: ${Array.isArray(profile.priorities) ? profile.priorities.join(', ') : (profile.priorities || '')}, pets: ${profile.pets}.
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

  // Budget fit (20 pts)
  const budgetMap = {
    'Under £200K': 200000, '£200K-£400K': 400000, '£400K-£600K': 600000,
    '£600K-£800K': 800000, '£800K+': 1200000,
    'Under €200K': 200000, '€200K-€400K': 400000, '€400K-€600K': 600000,
    '€600K-€800K': 800000, '€800K+': 1200000,
  };
  const maxBudget = budgetMap[profile.budget_range] || 500000;
  if (property.price <= maxBudget) {
    score += 15;
    if (property.price <= maxBudget * 0.85) highlights.push('Well within budget');
  } else if (property.price <= maxBudget * 1.1) {
    score += 5;
    concerns.push('Slightly above budget');
  } else {
    score -= 10;
    concerns.push('Above budget');
  }

  // Commute (15 pts)
  if (property.commute_city_center) {
    if (property.commute_city_center <= 15) { score += 15; highlights.push(`${property.commute_city_center} min commute`); }
    else if (property.commute_city_center <= 25) score += 10;
    else if (property.commute_city_center <= 40) score += 5;
  }

  // Walkability (8 pts)
  if (property.walkability >= 8) { score += 8; highlights.push('Very walkable area'); }
  else if (property.walkability >= 6) score += 5;

  // Pets (5 pts)
  if (profile.pets !== 'No pets' && property.pet_friendly) { score += 5; highlights.push('Pet-friendly'); }
  if (profile.pets !== 'No pets' && !property.pet_friendly) concerns.push('Not pet-friendly');

  // Outdoor space (5 pts)
  if (profile.outdoor_space === 'Big garden' && property.features?.includes('garden')) { score += 5; highlights.push('Has garden'); }

  // Schools (5 pts)
  if (property.schools_quality === 'excellent') { score += 5; highlights.push('Excellent schools'); }

  // Cap at 100
  score = Math.min(100, Math.max(0, score));

  return {
    score,
    highlights: highlights.slice(0, 3),
    concerns: concerns.slice(0, 2),
    reasoning: `Score based on budget fit, commute time, walkability, and lifestyle preferences.`,
  };
}

function fallbackPersona(profile) {
  const personas = [
    { emoji: '🏡', title: 'The Nester', description: 'Looking for a forever home with room to grow.' },
    { emoji: '🌆', title: 'The Urban Explorer', description: 'Wants the buzz of the city right outside the door.' },
    { emoji: '🌿', title: 'The Green Seeker', description: 'Needs nature, space, and fresh air to feel at home.' },
    { emoji: '💼', title: 'The Smart Commuter', description: 'Location is everything — close to work, close to life.' },
  ];
  return personas[Math.floor(Math.random() * personas.length)];
}
