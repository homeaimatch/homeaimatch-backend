/**
 * homeAImatch — Casafari API Sync Service
 * 
 * Pulls properties from Casafari Properties API, maps to homeAImatch schema,
 * upserts into Supabase, and triggers OSM enrichment for new properties.
 * 
 * Usage:
 *   import { syncCasafariProperties, SILVER_COAST_CONCELHOS } from './casafari-sync.js';
 *   const result = await syncCasafariProperties({ locationIds: [3482, 3076], limit: 100 });
 */

const CASAFARI_BASE_URL = 'https://api.casafari.com/v1';

// ─── Silver Coast concelho IDs (from Casafari References) ────────────────────
export const SILVER_COAST_CONCELHOS = {
  // Leiria district
  peniche:        3482,
  obidos:         3076,
  bombarral:      3523,
  caldas_rainha:  3516,
  nazare:         4117,
  alcobaca:       4030,
  // Lisboa district
  lourinha:       2846,
  torres_vedras:  2897,
  cadaval:        2807,
  mafra:          1870,
  sobral_monte_agraco: 2892,
  alenquer:       2758,
  arruda_vinhos:  2789,
};

// ─── Property type mapping: Casafari type → homeAImatch type ─────────────────
const TYPE_MAP = {
  apartment: 'flat',
  duplex: 'flat',
  penthouse: 'flat',
  studio: 'flat',
  loft: 'flat',
  house: 'detached',
  villa: 'villa',
  townhouse: 'townhouse',
  semi_detached_house: 'semi-detached',
  terraced_house: 'terraced',
  country_house: 'farmhouse',
  farm: 'farmhouse',
  chalet: 'cottage',
  bungalow: 'bungalow',
};

// ─── Condition mapping ───────────────────────────────────────────────────────
const CONDITION_MAP = {
  new: 'new-build',
  good: 'move-in',
  renovated: 'move-in',
  used: 'move-in',
  to_renovate: 'renovation-light',
  to_rebuild: 'renovation-major',
  under_construction: 'new-build',
  other: 'move-in',
};

// ─── Style mapping (best guess from type) ────────────────────────────────────
function guessStyle(type, constructionYear) {
  if (type === 'villa' || type === 'country_house') return 'mediterranean';
  if (type === 'farm') return 'rustic';
  if (constructionYear && constructionYear >= 2010) return 'contemporary';
  if (constructionYear && constructionYear >= 1990) return 'modern';
  return 'traditional';
}

// ─── Extract best contact from listings ──────────────────────────────────────
function extractContact(listings) {
  for (const listing of listings) {
    const c = listing.contacts_info;
    if (c && (c.phone || c.email)) {
      return {
        name: c.name || null,
        email: c.email || null,
        phone: c.phone || null,
        agency: listing.agency || listing.source_name || 'Independent',
      };
    }
  }
  // Fallback: use first listing's agency
  if (listings.length > 0) {
    return {
      name: null,
      email: null,
      phone: null,
      agency: listings[0].agency || listings[0].source_name || 'Independent',
    };
  }
  return null;
}

// ─── Extract best images (prefer thumbnails for reliability) ─────────────────
function extractImages(property) {
  // thumbnails = Casafari CDN (reliable), pictures = original source (higher res but may break)
  const thumbs = property.thumbnails || [];
  const pics = property.pictures || [];
  // Use up to 5 images, prefer thumbnails
  const images = thumbs.length >= 3 ? thumbs.slice(0, 5) : [...thumbs, ...pics].slice(0, 5);
  return images;
}

// ─── Extract location info from locations_structure ──────────────────────────
function extractLocation(property) {
  const struct = property.locations_structure || [];
  const loc = {
    city: '',
    region: '',
    county: '',
    postcode: '',
    country: 'PT',
  };

  for (const level of struct) {
    switch (level.administrative_level) {
      case 'País':
        loc.country = level.name === 'Portugal' ? 'PT' : level.name === 'Spain' ? 'ES' : 'IE';
        break;
      case 'Distrito':
        loc.county = level.name;
        break;
      case 'Concelho':
        loc.city = level.name;
        break;
      case 'Freguesia':
        loc.region = level.name;
        break;
      case 'Localidade':
        // More specific than freguesia — use as region if available
        if (level.name) loc.region = level.name;
        break;
    }
  }

  // Use location zip_codes if available
  const zipCodes = property.location?.zip_codes || [];
  if (zipCodes.length > 0) {
    loc.postcode = zipCodes.find(z => z.includes('-')) || zipCodes[0] || '';
  }
  if (!loc.postcode && property.zip_code) {
    loc.postcode = property.zip_code;
  }

  return loc;
}

// ─── Map a single Casafari property to homeAImatch schema ────────────────────
export function mapCasafariProperty(cp) {
  const loc = extractLocation(cp);
  const contact = extractContact(cp.listings || []);
  const images = extractImages(cp);
  const listing = cp.listings?.[0];

  return {
    // Core
    title: cp.title || `${cp.type_group} in ${loc.city}`,
    price: cp.sale_price || 0,
    currency: cp.sale_currency || 'EUR',
    beds: cp.bedrooms || 0,
    baths: cp.bathrooms || 0,
    sqm: cp.total_area || null,
    sqft: cp.total_area ? Math.round(cp.total_area * 10.764) : null,
    property_type: TYPE_MAP[cp.type] || cp.type_group || 'detached',
    style: guessStyle(cp.type, cp.construction_year),
    condition: CONDITION_MAP[cp.condition] || 'move-in',

    // Location
    city: loc.city,
    region: loc.region,
    county: loc.county,
    postcode: loc.postcode,
    country: loc.country,
    latitude: cp.coordinates?.latitude || null,
    longitude: cp.coordinates?.longitude || null,

    // Content
    description: cp.description || listing?.description || '',
    tagline: '',  // Generated later or from title
    image_urls: images,
    source_url: listing?.listing_url || cp.property_url || '',
    epc_rating: (cp.energy_rating && cp.energy_rating !== 'Unknown') ? cp.energy_rating : null,

    // Features (basic — enrichment fills the rest)
    features: extractFeatures(cp),
    parking: [],
    pet_friendly: false,
    neighborhood_vibe: [],

    // Casafari metadata
    casafari_id: String(cp.property_id),
    casafari_listing_id: String(cp.primary_listing_id),
    listing_status: cp.sale_status === 'active' ? 'active' : 'inactive',
    source: 'casafari',
    construction_year: cp.construction_year || null,
    days_on_market: cp.sale_time_on_market?.days_on_market || null,
    price_per_sqm: cp.sale_price_per_sqm || null,

    // Agent
    agent_name: contact?.name || null,
    agent_agency: contact?.agency || null,
    agent_phone: contact?.phone || null,
    agent_email: contact?.email || null,
  };
}

// ─── Extract features from Casafari data ─────────────────────────────────────
function extractFeatures(cp) {
  const features = [];
  const chars = cp.features?.characteristics || [];
  const views = cp.features?.views || [];

  if (views.includes('sea') || views.includes('ocean')) features.push('sea view');
  if (views.includes('mountain')) features.push('mountain view');
  if (views.includes('landscape') || views.includes('garden')) features.push('garden view');
  if (chars.includes('pool') || chars.includes('swimming_pool')) features.push('pool');
  if (chars.includes('garage')) features.push('garage');
  if (chars.includes('garden')) features.push('garden');
  if (chars.includes('terrace')) features.push('terrace');
  if (chars.includes('balcony')) features.push('balcony');
  if (chars.includes('elevator') || chars.includes('lift')) features.push('elevator');
  if (chars.includes('air_conditioning')) features.push('air conditioning');
  if (chars.includes('central_heating')) features.push('central heating');
  if (chars.includes('fireplace')) features.push('fireplace');
  if (cp.terrace_area > 0) features.push('terrace');

  return [...new Set(features)]; // Deduplicate
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CASAFARI API CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch properties from Casafari API
 * @param {Object} options
 * @param {string} options.token - Casafari API token
 * @param {number[]} options.locationIds - Concelho IDs
 * @param {number} options.limit - Results per page (max 100)
 * @param {number} options.offset - Pagination offset
 * @returns {Object} { count, results, next }
 */
export async function fetchCasafariProperties({
  token,
  locationIds,
  limit = 100,
  offset = 0,
}) {
  const url = `${CASAFARI_BASE_URL}/properties/search?limit=${limit}&offset=${offset}`;

  const body = {
    search_operations: ['sale'],
    location_ids: locationIds,
    // Residential only — confirmed by Casafari support (parameter: "types")
    types: [
      'apartment', 'studio', 'duplex', 'penthouse',
      'country_house', 'house', 'palace', 'townhouse',
      'villa', 'country_estate', 'chalet', 'bungalow', 'family_house',
    ],
  };

  console.log(`[Casafari] Fetching: locations=${locationIds.join(',')}, limit=${limit}, offset=${offset}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Casafari API error ${res.status}: ${err}`);
  }

  return res.json();
}

/**
 * Fetch ALL properties for given locations (handles pagination)
 * Each page of 100 = 1 API call
 */
export async function fetchAllCasafariProperties({ token, locationIds, maxCalls = 10 }) {
  const allProperties = [];
  let offset = 0;
  const limit = 100;
  let totalCount = 0;
  let callCount = 0;

  do {
    const data = await fetchCasafariProperties({ token, locationIds, limit, offset });
    totalCount = data.count;
    callCount++;

    const results = data.results || [];
    allProperties.push(...results);
    console.log(`[Casafari] Call #${callCount}: got ${results.length} properties (${allProperties.length}/${totalCount} total)`);

    offset += limit;

    // Safety cap
    if (callCount >= maxCalls) {
      console.warn(`[Casafari] Reached max ${maxCalls} calls, stopping at ${allProperties.length} properties`);
      break;
    }

    // Small delay between paginated calls
    if (data.next) {
      await new Promise(r => setTimeout(r, 500));
    }
  } while (offset < totalCount);

  console.log(`[Casafari] Total: ${allProperties.length} properties in ${callCount} API calls`);
  return { properties: allProperties, totalCount, callCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SYNC TO SUPABASE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sync Casafari properties to Supabase
 * - Maps Casafari format → homeAImatch format
 * - Upserts properties (update if casafari_id exists, insert if new)
 * - Triggers OSM enrichment for new properties
 * - Marks missing properties as inactive
 *
 * @param {Object} supabase - Supabase client
 * @param {Function} enrichAndSave - Enrichment function
 * @param {Object} options
 * @returns {Object} sync results
 */
export async function syncToSupabase(supabase, enrichAndSave, { casafariProperties, upsertAgent }) {
  const results = {
    total: casafariProperties.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
    enriching: 0,
  };

  // Get existing casafari_ids to detect updates vs inserts
  const { data: existing } = await supabase
    .from('properties')
    .select('id, casafari_id')
    .eq('source', 'casafari')
    .not('casafari_id', 'is', null);

  const existingMap = new Map((existing || []).map(e => [e.casafari_id, e.id]));

  for (const cp of casafariProperties) {
    try {
      // Skip non-residential (extra safety filter)
      if (cp.type_group === 'plot' || cp.type_group === 'commercial' || cp.type_group === 'parking') {
        results.skipped++;
        continue;
      }

      // Skip properties that are not actively for sale
      if (cp.sale_status !== 'active') {
        results.skipped++;
        continue;
      }

      // Skip properties with no price
      if (!cp.sale_price || cp.sale_price <= 0) {
        results.skipped++;
        continue;
      }

      const mapped = mapCasafariProperty(cp);

      // Upsert agent if contact info exists
      let agentId = null;
      if (mapped.agent_agency && upsertAgent) {
        agentId = await upsertAgent({
          name: mapped.agent_name || mapped.agent_agency,
          agency: mapped.agent_agency,
          phone: mapped.agent_phone || '',
          email: mapped.agent_email || '',
        });
      }

      const propertyData = {
        title: mapped.title,
        price: mapped.price,
        currency: mapped.currency,
        beds: mapped.beds,
        baths: mapped.baths,
        sqm: mapped.sqm,
        sqft: mapped.sqft,
        property_type: mapped.property_type,
        style: mapped.style,
        condition: mapped.condition,
        city: mapped.city,
        region: mapped.region,
        county: mapped.county,
        postcode: mapped.postcode,
        country: mapped.country,
        latitude: mapped.latitude,
        longitude: mapped.longitude,
        description: mapped.description,
        tagline: mapped.tagline,
        image_urls: mapped.image_urls,
        source_url: mapped.source_url,
        epc_rating: mapped.epc_rating,
        features: mapped.features,
        parking: mapped.parking,
        pet_friendly: mapped.pet_friendly,
        neighborhood_vibe: mapped.neighborhood_vibe,
        casafari_id: mapped.casafari_id,
        listing_status: mapped.listing_status,
        source: 'casafari',
        agent_id: agentId,
      };

      const existingId = existingMap.get(mapped.casafari_id);

      if (existingId) {
        // Update existing property
        const { error } = await supabase
          .from('properties')
          .update(propertyData)
          .eq('id', existingId);

        if (error) {
          results.errors.push({ title: mapped.title, error: error.message });
        } else {
          results.updated++;
        }
      } else {
        // Insert new property
        const { data: inserted, error } = await supabase
          .from('properties')
          .insert(propertyData)
          .select()
          .single();

        if (error) {
          results.errors.push({ title: mapped.title, error: error.message });
        } else {
          results.inserted++;
          // Don't trigger enrichment here — it will be queued after sync completes
          // to avoid overwhelming OSM Overpass API with parallel requests
          if (inserted.latitude && inserted.longitude) {
            results.enriching++;
          }
        }
      }
    } catch (err) {
      results.errors.push({ title: cp.title || cp.property_id, error: err.message });
    }
  }

  return results;
}

/**
 * Mark properties as inactive if they're no longer in Casafari results
 * (call this after sync to clean up delisted properties)
 */
export async function deactivateMissing(supabase, activeCasafariIds, locationIds) {
  // Get all casafari properties in our DB for these locations
  const { data: dbProperties } = await supabase
    .from('properties')
    .select('id, casafari_id, city')
    .eq('source', 'casafari')
    .eq('listing_status', 'active');

  if (!dbProperties) return { deactivated: 0 };

  const activeSet = new Set(activeCasafariIds.map(String));
  const toDeactivate = dbProperties.filter(p => p.casafari_id && !activeSet.has(p.casafari_id));

  if (toDeactivate.length > 0) {
    const ids = toDeactivate.map(p => p.id);
    await supabase
      .from('properties')
      .update({ listing_status: 'sold' })
      .in('id', ids);

    console.log(`[Casafari] Deactivated ${toDeactivate.length} properties no longer in Casafari`);
  }

  return { deactivated: toDeactivate.length };
}
