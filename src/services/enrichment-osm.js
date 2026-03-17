/**
 * homeAImatch — OpenStreetMap Enrichment Module
 * 
 * Free enrichment using OpenStreetMap / Overpass API.
 * Works globally — Portugal, Ireland, UK, Spain, anywhere.
 * No API key needed. Rate limit: ~10 req/min (be polite).
 * 
 * Enriches properties with:
 *  - Walkability score (0-10)
 *  - Nearby schools (count + names + distances)
 *  - Nearby restaurants/cafes
 *  - Public transport stops
 *  - Supermarkets/shops
 *  - Parks and green spaces
 *  - Healthcare (pharmacies, hospitals)
 *  - Beach proximity (important for PT coastal)
 *  - Neighbourhood category (urban/suburban/rural)
 */

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// ─── Overpass query builder ─────────────────────────────────────────────────
function overpassQuery(lat, lng, radiusM, tags) {
  // tags = [["amenity","school"], ["shop","supermarket"], ...]
  const nodes = tags.map(([k, v]) =>
    `node["${k}"="${v}"](around:${radiusM},${lat},${lng});`
  ).join('\n  ');
  const ways = tags.map(([k, v]) =>
    `way["${k}"="${v}"](around:${radiusM},${lat},${lng});`
  ).join('\n  ');

  return `[out:json][timeout:25];
(
  ${nodes}
  ${ways}
);
out center body;`;
}

// ─── Haversine distance in km ───────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Parse Overpass results into sorted list with distances ─────────────────
function parseResults(elements, lat, lng) {
  return elements.map(el => {
    const elLat = el.lat || el.center?.lat;
    const elLng = el.lon || el.center?.lon;
    if (!elLat || !elLng) return null;
    return {
      name: el.tags?.name || el.tags?.operator || 'Unnamed',
      type: el.tags?.amenity || el.tags?.shop || el.tags?.leisure || el.tags?.natural || el.tags?.tourism || '',
      distance_km: Math.round(haversine(lat, lng, elLat, elLng) * 100) / 100,
      lat: elLat,
      lng: elLng,
    };
  }).filter(Boolean).sort((a, b) => a.distance_km - b.distance_km);
}

// ─── Main query: fetch all amenity categories in one Overpass call ──────────
async function fetchNearbyAmenities(lat, lng, radiusM = 2000) {
  const allTags = [
    // Education
    ['amenity', 'school'],
    ['amenity', 'kindergarten'],
    ['amenity', 'university'],
    ['amenity', 'college'],
    // Food & drink
    ['amenity', 'restaurant'],
    ['amenity', 'cafe'],
    ['amenity', 'bar'],
    ['amenity', 'pub'],
    ['amenity', 'nightclub'],
    ['amenity', 'fast_food'],
    // Shopping
    ['shop', 'supermarket'],
    ['shop', 'convenience'],
    ['shop', 'bakery'],
    // Transport
    ['amenity', 'bus_station'],
    ['highway', 'bus_stop'],
    ['railway', 'station'],
    ['railway', 'halt'],
    ['amenity', 'ferry_terminal'],
    ['amenity', 'bicycle_rental'],
    ['amenity', 'bicycle_parking'],
    // Health
    ['amenity', 'pharmacy'],
    ['amenity', 'hospital'],
    ['amenity', 'clinic'],
    ['amenity', 'doctors'],
    // Leisure & nature
    ['leisure', 'park'],
    ['leisure', 'playground'],
    ['leisure', 'sports_centre'],
    ['leisure', 'swimming_pool'],
    ['leisure', 'fitness_centre'],
    ['natural', 'beach'],
    // Tourism & culture (for historic/artsy vibe)
    ['tourism', 'museum'],
    ['tourism', 'attraction'],
    ['tourism', 'gallery'],
    ['historic', 'castle'],
    ['historic', 'monument'],
    // Other useful
    ['amenity', 'bank'],
    ['amenity', 'post_office'],
    ['amenity', 'library'],
    ['amenity', 'place_of_worship'],
    ['amenity', 'marketplace'],
  ];

  // Airport search uses a wider radius (50km) — separate query
  const airportQuery = overpassQuery(lat, lng, 50000, [
    ['aeroway', 'aerodrome'],
  ]);

  const query = overpassQuery(lat, lng, radiusM, allTags);

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
  });

  if (!res.ok) {
    console.error(`Overpass API error: ${res.status} ${res.statusText}`);
    return null;
  }

  const data = await res.json();
  const amenities = parseResults(data.elements || [], lat, lng);

  // Fetch airports separately (50km radius) — with small delay to be polite
  let airports = [];
  try {
    await new Promise(r => setTimeout(r, 1500));
    const airRes = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(airportQuery)}`,
    });
    if (airRes.ok) {
      const airData = await airRes.json();
      airports = parseResults(airData.elements || [], lat, lng)
        .filter(a => {
          if (!a.name || a.name === 'Unnamed') return false;
          const n = a.name.toLowerCase();
          // Include if name contains airport/aeroporto/aeropuerto or known commercial airport indicators
          if (n.includes('airport') || n.includes('aeroporto') || n.includes('aeropuerto') || n.includes('aéroport') || n.includes('flughafen')) return true;
          // Include if it has international in the name
          if (n.includes('international') || n.includes('internacional')) return true;
          // Exclude aerodromes, airfields, helipads, and private strips
          if (n.includes('aerodrom') || n.includes('aeroclub') || n.includes('aeródromo') || n.includes('airfield') || n.includes('heliport') || n.includes('helipad') || n.includes('ultralight') || n.includes('ultraligeiro') || n.includes('militar')) return false;
          // If name doesn't clearly indicate airport type, include only if within 60km (likely significant)
          return a.distance_km <= 60;
        }); // Only real commercial airports
    }
  } catch (e) {
    console.warn('Airport query failed:', e.message);
  }

  return { amenities, airports };
}

// ─── Categorise amenities ───────────────────────────────────────────────────
function categorise(amenities) {
  const cats = {
    schools: [],
    restaurants: [],
    cafes: [],
    bars: [],
    shops: [],
    transport: [],
    cycling: [],
    healthcare: [],
    parks: [],
    beaches: [],
    sports: [],
    tourism: [],
    other: [],
  };

  for (const a of amenities) {
    const t = a.type;
    if (['school', 'kindergarten', 'university', 'college'].includes(t)) cats.schools.push(a);
    else if (['restaurant', 'fast_food'].includes(t)) cats.restaurants.push(a);
    else if (['cafe'].includes(t)) cats.cafes.push(a);
    else if (['bar', 'pub', 'nightclub'].includes(t)) cats.bars.push(a);
    else if (['supermarket', 'convenience', 'bakery', 'marketplace'].includes(t)) cats.shops.push(a);
    else if (['bus_station', 'bus_stop', 'station', 'halt', 'ferry_terminal'].includes(t)) cats.transport.push(a);
    else if (['bicycle_rental', 'bicycle_parking'].includes(t)) cats.cycling.push(a);
    else if (['pharmacy', 'hospital', 'clinic', 'doctors'].includes(t)) cats.healthcare.push(a);
    else if (['park', 'playground'].includes(t)) cats.parks.push(a);
    else if (t === 'beach') cats.beaches.push(a);
    else if (['sports_centre', 'swimming_pool', 'fitness_centre'].includes(t)) cats.sports.push(a);
    else if (['museum', 'attraction', 'gallery', 'castle', 'monument'].includes(t)) cats.tourism.push(a);
    else cats.other.push(a);
  }

  return cats;
}

// ─── Calculate walkability score (0-10) ─────────────────────────────────────
function calcWalkability(cats) {
  let score = 0;
  const max = 10;

  // Shops within 500m = essential for walkability
  const nearShops = cats.shops.filter(s => s.distance_km <= 0.5);
  if (nearShops.length >= 3) score += 2;
  else if (nearShops.length >= 1) score += 1;

  // Restaurants/cafes within 500m
  const nearFood = [...cats.restaurants, ...cats.cafes].filter(f => f.distance_km <= 0.5);
  if (nearFood.length >= 5) score += 2;
  else if (nearFood.length >= 2) score += 1;

  // Public transport within 500m
  const nearTransport = cats.transport.filter(t => t.distance_km <= 0.5);
  if (nearTransport.length >= 3) score += 2;
  else if (nearTransport.length >= 1) score += 1;

  // Healthcare within 1km
  const nearHealth = cats.healthcare.filter(h => h.distance_km <= 1);
  if (nearHealth.length >= 1) score += 1;

  // Parks/green space within 500m
  const nearParks = cats.parks.filter(p => p.distance_km <= 0.5);
  if (nearParks.length >= 1) score += 1;

  // Schools within 1km
  const nearSchools = cats.schools.filter(s => s.distance_km <= 1);
  if (nearSchools.length >= 2) score += 1;
  else if (nearSchools.length >= 1) score += 0.5;

  // Bonus for general density (lots of stuff nearby)
  const total500m = cats.shops.filter(s => s.distance_km <= 0.5).length +
    [...cats.restaurants, ...cats.cafes].filter(f => f.distance_km <= 0.5).length +
    cats.transport.filter(t => t.distance_km <= 0.5).length;
  if (total500m >= 15) score += 0.5;

  return Math.min(Math.round(score * 10) / 10, max);
}

// ─── Determine neighbourhood type ──────────────────────────────────────────
function neighbourhoodType(cats, walkScore) {
  if (walkScore >= 7) return 'urban';
  if (walkScore >= 4) return 'suburban';
  return 'rural';
}

// ─── School quality estimate ────────────────────────────────────────────────
function schoolRating(cats) {
  const schools = cats.schools.filter(s => s.distance_km <= 2);
  if (schools.length >= 5) return 'excellent';
  if (schools.length >= 3) return 'good';
  if (schools.length >= 1) return 'average';
  return 'limited';
}

// ─── Format top N amenities for display ─────────────────────────────────────
function topN(arr, n = 3) {
  return arr.slice(0, n).map(a => ({
    name: a.name,
    distance_km: a.distance_km,
  }));
}

// ─── Compute neighbourhood vibe from amenity data ─────────────────────────
function computeVibe(cats, walkScore) {
  const vibes = [];

  // Family-friendly: schools + parks + playgrounds + low bar count
  const schoolsNear = cats.schools.filter(s => s.distance_km <= 1.5).length;
  const parksNear = cats.parks.filter(p => p.distance_km <= 1).length;
  const playgrounds = cats.parks.filter(p => p.type === 'playground' && p.distance_km <= 1).length;
  if (schoolsNear >= 2 && parksNear >= 1) vibes.push('family-friendly');

  // Nightlife: bars + restaurants in high density
  const barsNear = cats.bars.filter(b => b.distance_km <= 1).length;
  const restaurantsNear = cats.restaurants.filter(r => r.distance_km <= 1).length;
  if (barsNear >= 3 || (barsNear >= 1 && restaurantsNear >= 5)) vibes.push('nightlife');

  // Artsy/creative: museums, galleries, cultural attractions
  const tourismNear = cats.tourism.filter(t => t.distance_km <= 2).length;
  if (tourismNear >= 2) vibes.push('artsy');

  // Quiet/peaceful: low density, rural or suburban
  const totalNear = cats.restaurants.filter(r => r.distance_km <= 0.5).length +
    cats.shops.filter(s => s.distance_km <= 0.5).length +
    cats.bars.filter(b => b.distance_km <= 0.5).length;
  if (totalNear <= 2 && walkScore <= 4) vibes.push('quiet');

  // Close to nature: parks, beaches, rural
  if (parksNear >= 2 || cats.beaches.length > 0 || walkScore <= 3) vibes.push('nature-lovers');

  // Surf/laid-back: beach nearby + not too urban
  if (cats.beaches.length > 0 && walkScore <= 7) vibes.push('surf');

  // Upscale: harder to detect from OSM alone, skip for now

  // Local community: small village feel — some amenities but not a lot
  if (walkScore >= 3 && walkScore <= 6 && cats.shops.filter(s => s.distance_km <= 0.5).length >= 1 && totalNear <= 8) vibes.push('local-community');

  return vibes;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enrich a single property with OSM data.
 * @param {Object} property - must have latitude and longitude
 * @param {number} radiusM - search radius in metres (default 2000)
 * @returns {Object} enrichment data or null on error
 */
export async function enrichWithOSM(property, radiusM = 2000) {
  const { latitude, longitude } = property;
  if (!latitude || !longitude) {
    console.warn(`Skipping enrichment for ${property.id || 'unknown'}: no coordinates`);
    return null;
  }

  try {
    const result = await fetchNearbyAmenities(latitude, longitude, radiusM);
    if (!result) return null;

    const { amenities, airports } = result;
    const cats = categorise(amenities);
    const walkScore = calcWalkability(cats);

    return {
      property_id: property.id,
      walkability: walkScore,
      walkability_label: walkScore >= 8 ? 'Very Walkable' : walkScore >= 6 ? 'Walkable' : walkScore >= 4 ? 'Somewhat Walkable' : walkScore >= 2 ? 'Car-Dependent' : 'Very Car-Dependent',
      neighborhood_type: neighbourhoodType(cats, walkScore),
      schools: schoolRating(cats),
      schools_nearby: topN(cats.schools, 5),
      schools_count_2km: cats.schools.filter(s => s.distance_km <= 2).length,
      restaurants_count_1km: cats.restaurants.filter(r => r.distance_km <= 1).length,
      cafes_count_1km: cats.cafes.filter(c => c.distance_km <= 1).length,
      bars_count_1km: cats.bars.filter(b => b.distance_km <= 1).length,
      shops_count_1km: cats.shops.filter(s => s.distance_km <= 1).length,
      transport_count_500m: cats.transport.filter(t => t.distance_km <= 0.5).length,
      nearest_transport: topN(cats.transport, 3),
      cycling_count_500m: cats.cycling.filter(c => c.distance_km <= 0.5).length,
      healthcare_count_1km: cats.healthcare.filter(h => h.distance_km <= 1).length,
      nearest_healthcare: topN(cats.healthcare, 2),
      parks_count_1km: cats.parks.filter(p => p.distance_km <= 1).length,
      nearest_park: cats.parks[0] ? { name: cats.parks[0].name, distance_km: cats.parks[0].distance_km } : null,
      beach_nearby: cats.beaches.length > 0,
      nearest_beach: cats.beaches[0] ? { name: cats.beaches[0].name, distance_km: cats.beaches[0].distance_km } : null,
      sports_count_2km: cats.sports.filter(s => s.distance_km <= 2).length,
      tourism_count_2km: cats.tourism.filter(t => t.distance_km <= 2).length,
      nearest_airport: airports[0] ? { name: airports[0].name, distance_km: airports[0].distance_km } : null,
      airports_50km: topN(airports, 3),
      // Computed neighbourhood vibe tags based on surrounding amenities
      computed_vibe: computeVibe(cats, walkScore),
      enriched_at: new Date().toISOString(),
      enrichment_source: 'openstreetmap',
    };
  } catch (err) {
    console.error(`OSM enrichment error for ${property.id || 'unknown'}:`, err.message);
    return null;
  }
}

/**
 * Enrich multiple properties with rate limiting.
 * Overpass API asks for max ~10 requests/minute.
 * @param {Array} properties - array of property objects with lat/lng
 * @param {number} delayMs - delay between requests (default 6000 = 10/min)
 * @returns {Array} array of enrichment results
 */
export async function enrichBatch(properties, delayMs = 6000) {
  const results = [];
  console.log(`Starting OSM enrichment for ${properties.length} properties (${delayMs}ms between requests)...`);

  for (let i = 0; i < properties.length; i++) {
    const prop = properties[i];
    console.log(`  [${i + 1}/${properties.length}] Enriching: ${prop.title || prop.id} (${prop.latitude}, ${prop.longitude})`);

    const result = await enrichWithOSM(prop);
    results.push(result);

    // Rate limit: wait between requests (skip on last)
    if (i < properties.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  const success = results.filter(Boolean).length;
  console.log(`OSM enrichment complete: ${success}/${properties.length} successful`);
  return results;
}

/**
 * Quick check: is a location near a beach? (5km radius)
 * Useful for Portuguese coastal properties.
 */
export async function isNearBeach(lat, lng, radiusM = 5000) {
  const query = `[out:json][timeout:10];
node["natural"="beach"](around:${radiusM},${lat},${lng});
out count;`;

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    const data = await res.json();
    return (data.elements?.[0]?.tags?.total || 0) > 0;
  } catch {
    return null;
  }
}
