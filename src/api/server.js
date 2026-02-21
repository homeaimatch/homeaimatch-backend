/**
 * homeAImatch MVP — API Server
 * 
 * Endpoints:
 * POST /api/match          — Run AI matching for a buyer
 * GET  /api/properties      — List properties (with filters)
 * GET  /api/properties/:id  — Single property with enrichment
 * POST /api/properties      — Add property (admin)
 * POST /api/leads           — Submit a lead (contact agent)
 * POST /api/subscribe       — Email signup
 * GET  /api/health          — Health check
 */

import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { scoreProperties, generatePersona } from '../services/ai-scoring.js';
import { enrichProperty } from '../services/enrichment.js';

// ============================================================
// SETUP
// ============================================================

const app = express();
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// ============================================================
// HEALTH CHECK
// ============================================================

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0-mvp',
    ai_enabled: !!process.env.ANTHROPIC_API_KEY,
    database: !!process.env.SUPABASE_URL,
  });
});

// ============================================================
// MATCHING — The core feature
// ============================================================

app.post('/api/match', async (req, res) => {
  const { answers } = req.body;
  const startTime = Date.now();

  try {
    // 1. Build buyer profile from quiz answers
    const profile = buildProfile(answers);

    console.log(`[Match] Profile: city=${profile.city}, country=${profile.country}, budget=${profile.budget_range}, family=${profile.family_size}`);

    // 2. Pre-filter properties from database
    const candidates = await getCandidates(profile);

    if (candidates.length === 0) {
      console.log(`[Match] NO candidates found for city=${profile.city}`);
      return res.json({
        matches: [],
        persona: null,
        message: 'No properties found matching your criteria. Try widening your search.',
      });
    }

    console.log(`[Match] ${candidates.length} candidates in ${profile.city}`);

    // 3. Get enrichment data for candidates
    const enrichmentMap = await getEnrichmentBatch(candidates.map(c => c.id));
    const propertiesWithEnrichment = candidates.map(p => ({
      property: p,
      enrichment: enrichmentMap[p.id] || null,
    }));

    // 4. AI Score all candidates → get top 5
    const topMatches = await scoreProperties(profile, propertiesWithEnrichment);

    // 5. Generate buyer persona
    const persona = await generatePersona(profile);

    // 6. Save search record
    const searchId = await saveSearch(profile, candidates.length, topMatches);

    const elapsed = Date.now() - startTime;
    console.log(`[Match] Done in ${elapsed}ms — ${topMatches.length} results`);

    res.json({
      persona,
      matches: topMatches.map((m, i) => ({
        rank: i + 1,
        property: formatProperty(m.property),
        enrichment: m.enrichment,
        score: m.score?.score || 0,
        highlights: m.score?.highlights || [],
        concerns: m.score?.concerns || [],
        reasoning: m.score?.reasoning || '',
      })),
      meta: {
        candidates: candidates.length,
        elapsed_ms: elapsed,
        ai_powered: !!process.env.ANTHROPIC_API_KEY,
      },
    });
  } catch (err) {
    console.error('Match error:', err.message, err.stack);
    res.status(500).json({ error: 'Matching failed: ' + err.message });
  }
});

// ============================================================
// PROPERTIES
// ============================================================

app.get('/api/properties', async (req, res) => {
  const { city, country, min_price, max_price, beds, status } = req.query;

  let query = supabase
    .from('properties')
    .select('*, agents(name, initials, phone, agency:agencies(name))')
    .eq('listing_status', status || 'active')
    .order('created_at', { ascending: false })
    .limit(100);

  if (city) query = query.eq('city', city);
  if (country) query = query.eq('country', country);
  if (min_price) query = query.gte('price', parseInt(min_price));
  if (max_price) query = query.lte('price', parseInt(max_price));
  if (beds) query = query.gte('beds', parseInt(beds));

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  res.json({ properties: data, count: data.length });
});

app.get('/api/properties/:id', async (req, res) => {
  const { data: property, error } = await supabase
    .from('properties')
    .select('*, agents(name, initials, phone, email, agency:agencies(name, website)), property_enrichment(*)')
    .eq('id', req.params.id)
    .single();

  if (error || !property) return res.status(404).json({ error: 'Property not found' });
  res.json(property);
});

// Add property (admin/manual entry)
app.post('/api/properties', async (req, res) => {
  const property = req.body;

  // Create agent/agency if provided
  let agentId = null;
  if (property.agent) {
    agentId = await upsertAgent(property.agent);
  }

  const { data, error } = await supabase
    .from('properties')
    .insert({
      ...property,
      agent: undefined, // remove nested object
      agent_id: agentId,
      source: 'manual',
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // Trigger enrichment in background
  enrichAndSave(data).catch(err => console.error('Enrichment failed:', err.message));

  res.json({ property: data, message: 'Property added. Enrichment running in background.' });
});

// ============================================================
// LEADS (Contact Agent)
// ============================================================

app.post('/api/leads', async (req, res) => {
  const { buyer_name, buyer_email, buyer_message, property_id, match_score } = req.body;

  // Get property and its agent
  const { data: property } = await supabase
    .from('properties')
    .select('id, title, agent_id, agents(id, name, email, agency_id)')
    .eq('id', property_id)
    .single();

  const { data: lead, error } = await supabase
    .from('leads')
    .insert({
      buyer_name,
      buyer_email,
      buyer_message,
      property_id,
      agent_id: property?.agents?.id || null,
      agency_id: property?.agents?.agency_id || null,
      match_score,
      status: 'new',
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // TODO: Send email notification to agent
  console.log(`[Lead] New lead from ${buyer_name} for "${property?.title}"`);

  res.json({ lead_id: lead.id, message: 'Your message has been sent to the agent.' });
});

// ============================================================
// EMAIL SUBSCRIBERS
// ============================================================

app.post('/api/subscribe', async (req, res) => {
  const { email, source } = req.body;

  const { error } = await supabase
    .from('subscribers')
    .upsert({ email, source: source || 'landing_page' }, { onConflict: 'email' });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Subscribed!' });
});

// ============================================================
// ENRICHMENT ENDPOINT (manual trigger)
// ============================================================

app.post('/api/enrich/:id', async (req, res) => {
  const { data: property } = await supabase
    .from('properties')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (!property) return res.status(404).json({ error: 'Property not found' });

  const enrichment = await enrichAndSave(property);
  res.json({ enrichment });
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function buildProfile(answers) {
  return {
    city: answers.location || answers.city,
    country: (answers.market || 'UK').toUpperCase(),
    radius: answers.radius,
    budget_range: answers.budget,
    family_size: answers.family,
    work_location: answers.workLocation,
    commute_priority: answers.commutePriority,
    property_condition: answers.condition,
    outdoor_space: answers.outdoor,
    vibe: answers.vibe || [],
    pets: answers.pets,
    parking: answers.parking,
    dealbreakers: answers.dealbreakers || [],
    priorities: answers.priorities || [],
    lifestyle: answers.lifestyle || [],
    raw_answers: answers,
  };
}

async function getCandidates(profile) {
  try {
    // Simple query first — no joins, no complex filters
    let query = supabase
      .from('properties')
      .select('*');

    // Filter by location — search across city, region, and county
    if (profile.city) {
      const loc = profile.city;
      query = query.or(`city.ilike.%${loc}%,region.ilike.%${loc}%,county.ilike.%${loc}%`);
    }

    // Budget filter with 30% buffer
    const normBudget = (profile.budget_range || '').replace(/\s*[–—-]\s*/g, '-');
    const budgetMap = {
      'Under £200K': [0, 260000], '£200K-£400K': [140000, 520000],
      '£400K-£600K': [280000, 780000], '£600K-£800K': [420000, 1040000],
      '£800K+': [560000, 99999999],
      'Under €200K': [0, 260000], '€200K-€400K': [140000, 520000],
      '€400K-€600K': [280000, 780000], '€600K-€800K': [420000, 1040000],
      '€800K+': [560000, 99999999],
    };
    const [minP, maxP] = budgetMap[normBudget] || [0, 99999999];
    if (minP > 0) query = query.gte('price', minP);
    if (maxP < 99999999) query = query.lte('price', maxP);

    // Beds based on family size
    const bedsMap = {
      'Just me': 1, 'Me and a partner': 1, 'Couple': 1,
      'Small family (1-2 kids)': 2, 'Large family (3+ kids)': 3,
      'Larger family (3+ kids)': 3, 'Sharing with friends': 2, 'Housemates': 2,
    };
    const minBeds = bedsMap[profile.family_size] || 1;
    query = query.gte('beds', minBeds);

    const { data, error } = await query.limit(50);
    
    if (error) {
      console.error('[Match] Query error:', error.message);
      // Ultimate fallback — just get ALL properties
      const { data: all } = await supabase.from('properties').select('*').limit(50);
      return all || [];
    }
    
    console.log(`[Match] Query returned ${(data || []).length} results`);
    return data || [];
  } catch (err) {
    console.error('[Match] getCandidates exception:', err.message);
    return [];
  }
}

async function getEnrichmentBatch(propertyIds) {
  if (!propertyIds.length) return {};

  const { data } = await supabase
    .from('property_enrichment')
    .select('*')
    .in('property_id', propertyIds);

  const map = {};
  (data || []).forEach(e => { map[e.property_id] = e; });
  return map;
}

async function enrichAndSave(property) {
  try {
    const enrichment = await enrichProperty(property);
    if (!enrichment) return null;

    const { error } = await supabase
      .from('property_enrichment')
      .upsert(enrichment, { onConflict: 'property_id' });

    if (error) console.error('Save enrichment error:', error);
    return enrichment;
  } catch (err) {
    console.error('Enrichment error:', err.message);
    return null;
  }
}

async function upsertAgent(agentData) {
  // Find or create agency
  let agencyId = null;
  if (agentData.agency) {
    const { data: existing } = await supabase
      .from('agencies')
      .select('id')
      .eq('name', agentData.agency)
      .single();

    if (existing) {
      agencyId = existing.id;
    } else {
      const { data: newAgency } = await supabase
        .from('agencies')
        .insert({ name: agentData.agency })
        .select('id')
        .single();
      agencyId = newAgency?.id;
    }
  }

  // Find or create agent
  const { data: existingAgent } = await supabase
    .from('agents')
    .select('id')
    .eq('name', agentData.name)
    .eq('agency_id', agencyId)
    .single();

  if (existingAgent) return existingAgent.id;

  const { data: newAgent } = await supabase
    .from('agents')
    .insert({
      name: agentData.name,
      phone: agentData.phone,
      initials: agentData.initials || agentData.name.split(' ').map(n => n[0]).join(''),
      agency_id: agencyId,
    })
    .select('id')
    .single();

  return newAgent?.id;
}

function formatProperty(p) {
  return {
    id: p.id,
    title: p.title,
    tagline: p.tagline,
    description: p.description,
    price: p.price,
    currency: p.currency,
    beds: p.beds,
    baths: p.baths,
    sqm: p.sqm,
    sqft: p.sqft,
    property_type: p.property_type,
    style: p.style,
    condition: p.condition,
    city: p.city,
    region: p.region,
    postcode: p.postcode,
    country: p.country,
    epc_rating: p.epc_rating,
    walkability: p.walkability,
    schools_quality: p.schools_quality,
    pet_friendly: p.pet_friendly,
    nearby_dog_park: p.nearby_dog_park,
    neighborhood_vibe: p.neighborhood_vibe,
    features: p.features,
    parking: p.parking,
    commute_city_center: p.commute_city_center,
    image_urls: p.image_urls,
    source_url: p.source_url,
    agent: p.agents ? {
      name: p.agents.name,
      initials: p.agents.initials,
      phone: p.agents.phone,
      agency: p.agents.agency?.name,
    } : null,
  };
}

async function saveSearch(profile, candidateCount, topMatches) {
  try {
    const { data } = await supabase
      .from('searches')
      .insert({
        search_type: 'free',
        candidates_count: candidateCount,
        results_count: topMatches.length,
        top_score: topMatches[0]?.score?.score || 0,
        scoring_model: process.env.ANTHROPIC_API_KEY ? 'claude-sonnet-4.5' : 'rule-based',
      })
      .select('id')
      .single();
    return data?.id;
  } catch (err) {
    console.error('Save search error:', err.message);
    return null;
  }
}

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nhomeAImatch API running on port ${PORT}`);
  console.log(`AI scoring: ${process.env.ANTHROPIC_API_KEY ? 'ENABLED (Claude)' : 'DISABLED (rule-based)'}`);
  console.log(`Database: ${process.env.SUPABASE_URL ? 'CONNECTED' : 'NOT CONFIGURED'}\n`);
});
