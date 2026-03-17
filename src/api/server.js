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
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { scoreProperties, generatePersona } from '../services/ai-scoring.js';
import { enrichWithOSM } from '../services/enrichment-osm.js';
import { fetchAllCasafariProperties, syncToSupabase, deactivateMissing, SILVER_COAST_CONCELHOS } from '../services/casafari-sync.js';
// Legacy UK-only enrichment (kept as fallback for UK properties with postcodes)
// import { enrichProperty } from '../services/enrichment.js';

// ============================================================
// SETUP
// ============================================================

const app = express();
app.use(cors({
  origin: true,  // reflects the requesting origin — works better than '*' with complex requests
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
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

// Diagnostic: check if agent tables exist
app.get('/api/agents/health', async (req, res) => {
  const checks = {};
  try {
    const { error: e1 } = await supabase.from('agents').select('id').limit(1);
    checks.agents_table = e1 ? e1.message : 'ok';
  } catch (e) { checks.agents_table = e.message; }
  try {
    const { error: e2 } = await supabase.from('agent_sessions').select('id').limit(1);
    checks.agent_sessions_table = e2 ? e2.message : 'ok';
  } catch (e) { checks.agent_sessions_table = e.message; }
  try {
    const { error: e3 } = await supabase.from('agent_notifications').select('id').limit(1);
    checks.agent_notifications_table = e3 ? e3.message : 'ok';
  } catch (e) { checks.agent_notifications_table = e.message; }
  try {
    const { error: e4 } = await supabase.from('listing_claims').select('id').limit(1);
    checks.listing_claims_table = e4 ? e4.message : 'ok';
  } catch (e) { checks.listing_claims_table = e.message; }
  try {
    // Check if email column exists on agents
    const { error: e5 } = await supabase.from('agents').select('email').limit(1);
    checks.agents_email_column = e5 ? e5.message : 'ok';
  } catch (e) { checks.agents_email_column = e.message; }
  res.json({ checks });
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

    // 2. Pre-filter properties from database
    const candidates = await getCandidates(profile);

    if (candidates.length === 0) {
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

    // 4. Quick rule-based pre-sort (instant, free) → take top 6 for AI scoring
    const preScored = propertiesWithEnrichment.map(pe => ({
      ...pe,
      preScore: quickPreScore(profile, pe.property, pe.enrichment) + Math.random() * 2, // small jitter for tie-breaking diversity
    }));
    preScored.sort((a, b) => b.preScore - a.preScore);
    const topCandidates = preScored.slice(0, 6);

    console.log(`[Match] Pre-sorted ${candidates.length} → top ${topCandidates.length} for AI scoring`);

    // 5. AI Score top candidates only (parallel) + persona in parallel
    const [topMatches, persona] = await Promise.all([
      scoreProperties(profile, topCandidates),
      generatePersona(profile),
    ]);

    // 6. Save search record
    const searchId = await saveSearch(profile, candidates.length, topMatches);

    const elapsed = Date.now() - startTime;
    console.log(`[Match] Done in ${elapsed}ms — ${topMatches.length} results`);

    res.json({
      persona,
      matches: topMatches.map((m, i) => ({
        rank: i + 1,
        property: formatProperty(m.property, m.enrichment),
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
    console.error('Match error:', err);
    res.status(500).json({ error: 'Matching failed. Please try again.' });
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
  const { buyer_name, buyer_email, buyer_message, property_id, match_score, buyer_profile } = req.body;

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
      agent_id: property?.agent_id || null,
      agency_id: property?.agents?.agency_id || null,
      match_score,
      buyer_profile: buyer_profile || null,
      status: 'new',
    })
    .select()
    .single();

  if (error) return res.status(400).json({ error: error.message });

  // TODO: Send email notification to agent
  console.log(`[Lead] New lead from ${buyer_name} for "${property?.title}"`);

  // Create in-app notification for agent
  if (property?.agent_id) {
    await supabase.from('agent_notifications').insert({
      agent_id: property.agent_id,
      type: 'new_lead',
      title: `New enquiry from ${buyer_name}`,
      message: `${buyer_name} is interested in "${property.title}". They sent: "${(buyer_message || '').substring(0, 100)}"`,
      data: { lead_id: lead.id, property_id, buyer_name, buyer_email },
    }).then(() => {}).catch(err => console.error('Notification error:', err.message));
  }
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
// CONTACT FORM
// ============================================================

app.post('/api/contact', async (req, res) => {
  const { name, email, type, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required' });
  }

  const { error } = await supabase
    .from('contact_messages')
    .insert({ name, email, type: type || 'other', message });

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Message received! We will get back to you within 24 hours.' });
});

app.get('/api/admin/contact-messages', async (req, res) => {
  const { data, error } = await supabase
    .from('contact_messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ messages: data });
});

// ============================================================
// ADMIN DASHBOARD ENDPOINTS
// ============================================================

app.get('/api/admin/stats', async (req, res) => {
  try {
    // Use separate count queries to avoid the 1000-row limit
    const [
      totalProperties, activeProperties, properties1, properties2,
      agents, leads, subscribers, contacts
    ] = await Promise.all([
      supabase.from('properties').select('id', { count: 'exact', head: true }),
      supabase.from('properties').select('id', { count: 'exact', head: true }).eq('listing_status', 'active'),
      // Fetch properties in 2 pages to overcome 1000-row limit on free tier
      supabase.from('properties').select('id, city, region, price, listing_status, created_at, latitude, longitude, agent_id, beds, baths, property_type, features, sqm, parking, condition').range(0, 999),
      supabase.from('properties').select('id, city, region, price, listing_status, created_at, latitude, longitude, agent_id, beds, baths, property_type, features, sqm, parking, condition').range(1000, 4999),
      supabase.from('agents').select('id, name, email, created_at, agency_id', { count: 'exact' }),
      supabase.from('leads').select('id, status, created_at, property_id, match_score, buyer_profile', { count: 'exact' }),
      supabase.from('subscribers').select('id, email, source, created_at', { count: 'exact' }),
      supabase.from('contact_messages').select('id, name, email, type, message, is_read, created_at', { count: 'exact' }),
    ]);

    // Combine paginated property data
    const allPropertyData = [...(properties1.data || []), ...(properties2.data || [])];

    res.json({
      properties: { data: allPropertyData, count: totalProperties.count || 0, activeCount: activeProperties.count || 0 },
      agents: { data: agents.data || [], count: agents.count || 0 },
      leads: { data: leads.data || [], count: leads.count || 0 },
      subscribers: { data: subscribers.data || [], count: subscribers.count || 0 },
      contacts: { data: contacts.data || [], count: contacts.count || 0 },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// BULK PROPERTY IMPORT
// ============================================================

app.post('/api/admin/bulk-import', async (req, res) => {
  const { properties } = req.body;
  if (!Array.isArray(properties) || properties.length === 0) {
    return res.status(400).json({ error: 'No properties provided' });
  }
  if (properties.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 properties per import' });
  }

  const results = { inserted: 0, errors: [], enriching: 0 };

  for (const p of properties) {
    try {
      // Validate required fields
      if (!p.title || !p.price || !p.beds || !p.property_type || !p.city) {
        results.errors.push({ title: p.title || 'Unknown', error: 'Missing required fields (title, price, beds, property_type, city)' });
        continue;
      }

      // Handle agent upsert if provided
      let agentId = null;
      if (p.agent_name) {
        agentId = await upsertAgent({
          name: p.agent_name,
          agency: p.agent_agency || 'Independent',
          phone: p.agent_phone || '',
        });
      }

      // Build image_urls array from individual fields
      const imageUrls = [p.image_url_1, p.image_url_2, p.image_url_3].filter(Boolean);

      // Parse comma-separated fields
      const features = p.features ? p.features.split(',').map(f => f.trim()).filter(Boolean) : [];
      const parking = p.parking ? p.parking.split(',').map(f => f.trim()).filter(Boolean) : [];

      const { data, error } = await supabase
        .from('properties')
        .insert({
          title: p.title,
          price: Number(p.price),
          currency: p.currency || 'EUR',
          beds: Number(p.beds),
          baths: Number(p.baths) || 1,
          sqm: Number(p.sqm) || null,
          sqft: p.sqm ? Math.round(Number(p.sqm) * 10.764) : null,
          property_type: p.property_type,
          style: p.style || 'traditional',
          condition: p.condition || 'move-in',
          city: p.city,
          region: p.region || p.city,
          county: p.county || '',
          postcode: p.postcode || '',
          country: p.country || 'PT',
          description: p.description || '',
          tagline: p.tagline || '',
          latitude: p.latitude ? Number(p.latitude) : null,
          longitude: p.longitude ? Number(p.longitude) : null,
          commute_city_center: p.commute_city_center ? Number(p.commute_city_center) : null,
          source_url: p.source_url || '',
          image_urls: imageUrls,
          features: features,
          parking: parking,
          pet_friendly: p.pet_friendly === 'yes' || p.pet_friendly === true || p.pet_friendly === 'true',
          nearby_dog_park: p.nearby_dog_park === 'yes' || p.nearby_dog_park === true || p.nearby_dog_park === 'true',
          walkability: p.walkability ? Number(p.walkability) : null,
          schools_quality: p.schools_quality || null,
          neighborhood_vibe: Array.isArray(p.neighborhood_vibe) ? p.neighborhood_vibe : (p.neighborhood_vibe ? p.neighborhood_vibe.split(',').map(v => v.trim()).filter(Boolean) : []),
          epc_rating: p.epc_rating || null,
          agent_id: agentId,
          source: 'bulk-import',
          listing_status: 'active',
        })
        .select()
        .single();

      if (error) {
        results.errors.push({ title: p.title, error: error.message });
      } else {
        results.inserted++;
        // Trigger enrichment in background
        enrichAndSave(data).catch(err => console.error('Enrichment failed for', p.title, err.message));
        results.enriching++;
      }
    } catch (err) {
      results.errors.push({ title: p.title || 'Unknown', error: err.message });
    }
  }

  res.json({
    message: `Imported ${results.inserted} of ${properties.length} properties. ${results.enriching} queued for AI enrichment.`,
    ...results,
  });
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

// Batch enrich: enrich all properties that don't have enrichment data yet
app.post('/api/admin/enrich-all', async (req, res) => {
  const { force } = req.body || {};
  try {
    // Get all properties with coordinates (paginated to overcome 1000-row limit)
    const [props1, props2] = await Promise.all([
      supabase.from('properties').select('id, title, latitude, longitude').not('latitude', 'is', null).not('longitude', 'is', null).range(0, 999),
      supabase.from('properties').select('id, title, latitude, longitude').not('latitude', 'is', null).not('longitude', 'is', null).range(1000, 4999),
    ]);
    const allProps = [...(props1.data || []), ...(props2.data || [])];

    if (!allProps || allProps.length === 0) {
      return res.json({ message: 'No properties with coordinates found', enriched: 0, total: 0 });
    }

    // Get properties with ACTUAL OSM enrichment (paginated)
    const [enr1, enr2] = await Promise.all([
      supabase.from('property_enrichment').select('property_id, enrichment_source, walkability').eq('enrichment_source', 'openstreetmap').range(0, 999),
      supabase.from('property_enrichment').select('property_id, enrichment_source, walkability').eq('enrichment_source', 'openstreetmap').range(1000, 4999),
    ]);
    const enriched = [...(enr1.data || []), ...(enr2.data || [])];
    
    const enrichedIds = new Set((enriched || []).map(e => e.property_id));
    const unenriched = force ? allProps : allProps.filter(p => !enrichedIds.has(p.id));

    if (unenriched.length === 0) {
      return res.json({ message: 'All properties already have OSM enrichment', enriched: 0, total: allProps.length, already_enriched: enrichedIds.size });
    }

    // Return immediately — run enrichment in background
    res.json({ 
      message: `Enrichment started for ${unenriched.length} properties. Runs in background (~5 per minute, ~${Math.ceil(unenriched.length / 5)} min total).`,
      queued: unenriched.length,
      already_enriched: enrichedIds.size,
      total: allProps.length
    });

    // Run in background with rate limiting
    // Each property = 2 Overpass queries (amenities + airports) with 1.5s between
    // Total per property ~4s + 8s pause = ~12s cycle = ~5 per minute
    for (let i = 0; i < unenriched.length; i++) {
      const prop = unenriched[i];
      console.log(`[Enrich ${i + 1}/${unenriched.length}] ${prop.title || prop.id}`);
      try {
        await enrichAndSave(prop);
        console.log(`  ✅ Done`);
      } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
      }
      // Wait 8 seconds between properties (polite rate for Overpass)
      if (i < unenriched.length - 1) {
        await new Promise(r => setTimeout(r, 10000));
      }
    }
    console.log(`✅ Batch enrichment complete: ${unenriched.length} properties processed`);
  } catch (err) {
    console.error('Batch enrich error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ============================================================
// CASAFARI SYNC ENDPOINTS
// ============================================================

app.post('/api/admin/casafari-sync', async (req, res) => {
  const token = process.env.CASAFARI_API_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'CASAFARI_API_TOKEN not set in environment variables' });
  }

  const { locationIds, concelhos, maxCalls } = req.body || {};

  let ids = locationIds || [];
  if (concelhos && Array.isArray(concelhos)) {
    ids = concelhos.map(name => SILVER_COAST_CONCELHOS[name.toLowerCase()]).filter(Boolean);
  }
  if (ids.length === 0) {
    ids = [SILVER_COAST_CONCELHOS.lourinha, SILVER_COAST_CONCELHOS.peniche];
  }

  try {
    res.json({
      message: `Casafari sync started for location IDs: ${ids.join(', ')}. Running in background — check Railway logs.`,
      locationIds: ids,
      estimated_calls: 'Depends on property count (~1 call per 100 properties)',
    });

    const { properties, totalCount, callCount } = await fetchAllCasafariProperties({
      token,
      locationIds: ids,
      maxCalls: maxCalls || 10,
    });

    console.log(`[Casafari Sync] Fetched ${properties.length} properties in ${callCount} API calls`);

    const results = await syncToSupabase(supabase, enrichAndSave, {
      casafariProperties: properties,
      upsertAgent,
    });

    console.log(`[Casafari Sync] Done: ${results.inserted} new, ${results.updated} updated, ${results.skipped} skipped, ${results.errors.length} errors`);

    if (results.errors.length > 0) {
      console.log(`[Casafari Sync] Errors:`, results.errors.slice(0, 5));
    }

    // DEACTIVATION DISABLED — was incorrectly marking properties from other concelhos as sold
    // when doing partial syncs. Will re-enable once Casafari confirms the proper incremental sync approach.
    // const activeCasafariIds = properties.map(p => String(p.property_id));
    // const deactivated = await deactivateMissing(supabase, activeCasafariIds, ids);
    console.log(`[Casafari Sync] Deactivation skipped (disabled until full-sync logic implemented)`);

    // Now run enrichment for new properties SEQUENTIALLY (not parallel)
    // Only enrich properties that don't have OSM data yet
    if (results.inserted > 0) {
      console.log(`[Casafari Sync] Starting sequential enrichment for new properties...`);
      const [up1, up2] = await Promise.all([
        supabase.from('properties').select('id, title, latitude, longitude').eq('source', 'casafari').not('latitude', 'is', null).not('longitude', 'is', null).range(0, 999),
        supabase.from('properties').select('id, title, latitude, longitude').eq('source', 'casafari').not('latitude', 'is', null).not('longitude', 'is', null).range(1000, 4999),
      ]);
      const unenriched = [...(up1.data || []), ...(up2.data || [])];

      const [ae1, ae2] = await Promise.all([
        supabase.from('property_enrichment').select('property_id').eq('enrichment_source', 'openstreetmap').range(0, 999),
        supabase.from('property_enrichment').select('property_id').eq('enrichment_source', 'openstreetmap').range(1000, 4999),
      ]);
      const alreadyEnriched = [...(ae1.data || []), ...(ae2.data || [])];

      const enrichedSet = new Set((alreadyEnriched || []).map(e => e.property_id));
      const toEnrich = (unenriched || []).filter(p => !enrichedSet.has(p.id));

      console.log(`[Casafari Enrich] ${toEnrich.length} properties need OSM enrichment`);

      // Run sequentially with 10 second delay between each
      for (let i = 0; i < toEnrich.length; i++) {
        try {
          console.log(`[Casafari Enrich] ${i + 1}/${toEnrich.length}: ${toEnrich[i].title || toEnrich[i].id}`);
          await enrichAndSave(toEnrich[i]);
        } catch (err) {
          console.error(`[Casafari Enrich] Failed: ${err.message}`);
        }
        // 10 second delay between enrichments (each does 2 Overpass queries)
        if (i < toEnrich.length - 1) {
          await new Promise(r => setTimeout(r, 10000));
        }
      }
      console.log(`[Casafari Enrich] Sequential enrichment complete`);
    }
  } catch (err) {
    console.error('[Casafari Sync] Error:', err.message);
  }
});

app.get('/api/admin/casafari-concelhos', (req, res) => {
  res.json(SILVER_COAST_CONCELHOS);
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// Quick rule-based pre-scorer for fast candidate filtering (no API calls)
function quickPreScore(profile, property, enrichment) {
  let score = 50;

  // Budget fit (20 pts) — now using exact min/max from form
  const price = property.price || 0;
  if (price >= (profile.budget_min || 0) && price <= (profile.budget_max || 9999999)) {
    score += 15;
    if (price <= (profile.budget_max || 9999999) * 0.85) score += 5; // well within budget bonus
  } else if (price <= (profile.budget_max || 9999999) * 1.15) {
    score += 5;
  } else {
    score -= 10;
  }

  // Size fit — if buyer specified min sqm
  if (profile.min_sqm && profile.min_sqm > 0 && property.sqm) {
    if (property.sqm >= profile.min_sqm) score += 5;
    else if (property.sqm >= profile.min_sqm * 0.8) score += 2;
    else score -= 3;
  }

  // Beds fit
  if (property.beds >= (profile.min_beds || 1)) score += 5;

  // Condition fit
  const cond = (profile.property_condition || '').toLowerCase();
  const pCond = (property.condition || '').toLowerCase();
  if (cond.includes("don't mind") || cond.includes('tanto faz') || !cond) {
    score += 3;
  } else if (cond.includes('move-in') || cond.includes('habitar')) {
    if (pCond === 'move-in') score += 8;
  } else if (cond.includes('new build') || cond.includes('nova')) {
    if (pCond === 'move-in' || pCond === 'new') score += 8;
  } else if (cond.includes('light') || cond.includes('ligeiras')) {
    if (pCond === 'move-in' || pCond === 'renovation-light') score += 6;
  } else if (cond.includes('full') || cond.includes('total')) {
    if (pCond === 'renovation-major' || pCond === 'renovation-light') score += 6;
  }

  // Transport & walkability alignment
  const transport = (profile.transport || '').toLowerCase();
  const walk = enrichment?.walkability ?? property.walkability;
  if (transport.includes('walking') || transport.includes('pé') || transport.includes('public') || transport.includes('público') || transport.includes('bicycle') || transport.includes('bicicleta')) {
    // Buyer relies on walkability/public transport — weight it heavily
    if (walk >= 7) score += 12;
    else if (walk >= 5) score += 6;
    else if (walk >= 3) score += 2;
    else score -= 5; // bad match for non-car user
    if (enrichment?.transport_count_500m >= 2) score += 4;
  } else {
    // Has a car — walkability nice but not essential
    if (walk >= 7) score += 5;
    else if (walk >= 5) score += 3;
  }

  // Setting/area type alignment
  const setting = (profile.setting || '').toLowerCase();
  const nType = enrichment?.neighborhood_type || '';
  if (setting.includes('beach') || setting.includes('praia')) {
    if (enrichment?.beach_nearby) score += 8;
  } else if (setting.includes('urban') || setting.includes('urbano')) {
    if (nType === 'urban') score += 6;
  } else if (setting.includes('country') || setting.includes('campo')) {
    if (nType === 'rural') score += 6;
  } else if (setting.includes('historic') || setting.includes('históric')) {
    // Historic towns like Óbidos — check city name
    const hCities = ['óbidos', 'obidos', 'alcobaça', 'alcobaca'];
    if (hCities.some(c => (property.city || '').toLowerCase().includes(c))) score += 6;
  }

  // Priorities alignment
  const prios = (profile.priorities || []).map(p => p.toLowerCase());
  if (prios.some(p => p.includes('beach') || p.includes('praia')) && enrichment?.beach_nearby) score += 4;
  if (prios.some(p => p.includes('school') || p.includes('escola')) && (enrichment?.schools === 'excellent' || enrichment?.schools === 'good')) score += 4;
  if (prios.some(p => p.includes('walkable') || p.includes('caminhável')) && walk >= 7) score += 4;
  if (prios.some(p => p.includes('restaurant') || p.includes('restaurante')) && enrichment?.restaurants_count_1km >= 3) score += 3;
  if (prios.some(p => p.includes('healthcare') || p.includes('saúde') || p.includes('saude')) && enrichment?.healthcare_count_1km >= 1) score += 3;
  if (prios.some(p => p.includes('transport') || p.includes('transporte')) && enrichment?.transport_count_500m >= 2) score += 3;
  if (prios.some(p => p.includes('peace') || p.includes('quiet') || p.includes('paz') || p.includes('sossego')) && walk <= 4) score += 3;
  if (prios.some(p => p.includes('nature') || p.includes('natureza')) && enrichment?.parks_count_1km >= 2) score += 3;

  // Feature matching
  const feats = (profile.features || []).map(f => f.toLowerCase().replace(/^[^\w]*/, '')); // strip emoji prefix
  const pFeats = (property.features || []).map(f => f.toLowerCase());
  const desc = (property.description || '').toLowerCase();
  let featMatch = 0;
  feats.forEach(f => {
    if (f.includes('garden') || f.includes('jardim')) { if (pFeats.some(pf => pf.includes('garden')) || desc.includes('jardim') || desc.includes('garden')) featMatch++; }
    else if (f.includes('pool') || f.includes('piscina')) { if (pFeats.some(pf => pf.includes('pool')) || desc.includes('piscina') || desc.includes('pool')) featMatch++; }
    else if (f.includes('sea view') || f.includes('vista mar')) { if (pFeats.some(pf => pf.includes('sea') || pf.includes('view') || pf.includes('ocean')) || desc.includes('vista mar') || desc.includes('sea view')) featMatch++; }
    else if (f.includes('country view') || f.includes('vista campo')) { if (desc.includes('vista') || desc.includes('view') || desc.includes('panoram')) featMatch++; }
    else if (f.includes('garage') || f.includes('garagem')) { if ((property.parking || []).some(pk => pk.includes('garage')) || desc.includes('garagem') || desc.includes('garage')) featMatch++; }
    else if (f.includes('office') || f.includes('escritório') || f.includes('escritorio')) { if (pFeats.some(pf => pf.includes('office')) || desc.includes('escritório') || desc.includes('office')) featMatch++; }
    else if (f.includes('solar') || f.includes('painéis')) { if (pFeats.some(pf => pf.includes('solar')) || desc.includes('solar') || desc.includes('painéis')) featMatch++; }
    else if (f.includes('fireplace') || f.includes('lareira')) { if (pFeats.some(pf => pf.includes('fireplace')) || desc.includes('lareira') || desc.includes('fireplace')) featMatch++; }
    else if (f.includes('terrace') || f.includes('terraço') || f.includes('terraco')) { if (pFeats.some(pf => pf.includes('terrace') || pf.includes('balcony')) || desc.includes('terraço') || desc.includes('terrace')) featMatch++; }
    else if (f.includes('balcony') || f.includes('varanda')) { if (pFeats.some(pf => pf.includes('balcony') || pf.includes('varanda')) || desc.includes('varanda') || desc.includes('balcony')) featMatch++; }
    else if (f.includes('energy') || f.includes('eficiência') || f.includes('eficiencia')) { if ((property.epc_rating && ['A', 'B', 'A+'].includes(property.epc_rating)) || desc.includes('eficien') || desc.includes('energy')) featMatch++; }
    else if (f.includes('wheelchair') || f.includes('acessível') || f.includes('acessivel') || f.includes('mobilidade')) { if (desc.includes('acessível') || desc.includes('acessivel') || desc.includes('wheelchair') || desc.includes('accessible') || desc.includes('mobilidade')) featMatch++; }
    else if (f.includes('smart') || f.includes('inteligente')) { if (pFeats.some(pf => pf.includes('smart')) || desc.includes('smart') || desc.includes('inteligente') || desc.includes('domótica')) featMatch++; }
    else if (f.includes('gated') || f.includes('condomínio') || f.includes('condominio')) { if (desc.includes('condomínio') || desc.includes('condominio') || desc.includes('gated') || desc.includes('closed')) featMatch++; }
    else if (f.includes('gym') || f.includes('ginásio') || f.includes('ginasio') || f.includes('sport')) { if (enrichment?.sports_count_2km >= 1) featMatch++; }
    else if (f.includes('large land') || f.includes('terreno grande')) { if (property.sqm >= 200 || desc.includes('terreno') || desc.includes('land') || desc.includes('quinta')) featMatch++; }
    else if (f.includes('kitchen') || f.includes('cozinha')) { if (desc.includes('cozinha equipada') || desc.includes('kitchen') || desc.includes('moderna')) featMatch++; }
    else if (f.includes('storage') || f.includes('arrecadação') || f.includes('arrecadacao')) { if (desc.includes('arrecadação') || desc.includes('arrecadacao') || desc.includes('arrumo') || desc.includes('storage')) featMatch++; }
    else if (f.includes('character') || f.includes('historic') || f.includes('traça')) { if (desc.includes('tradicional') || desc.includes('rústic') || desc.includes('rustic') || desc.includes('pedra') || desc.includes('stone') || desc.includes('character')) featMatch++; }
  });
  score += Math.min(featMatch * 3, 15); // increased cap from 12 to 15 for more features

  // Pets
  const pets = (profile.pets || '').toLowerCase();
  if (pets.includes('dog') || pets.includes('cão') || pets.includes('cao')) {
    if (property.pet_friendly) score += 4;
    else score -= 2;
  }

  // Neighbourhood vibe match (+6 max)
  const vibes = (profile.vibe || []).map(v => v.toLowerCase());
  const pVibes = (property.neighborhood_vibe || []).map(v => v.toLowerCase());
  let vibeHits = 0;
  vibes.forEach(v => {
    if (v.includes('family') || v.includes('familiar')) { if (pVibes.some(pv => pv.includes('family')) || desc.includes('familiar') || desc.includes('family') || desc.includes('tranquil')) vibeHits++; }
    else if (v.includes('nightlife') || v.includes('noturna')) { if (pVibes.some(pv => pv.includes('nightlife')) || enrichment?.restaurants_count_1km >= 5) vibeHits++; }
    else if (v.includes('quiet') || v.includes('calmo') || v.includes('tranquilo')) { if (pVibes.some(pv => pv.includes('quiet') || pv.includes('peaceful')) || (walk != null && walk <= 5)) vibeHits++; }
    else if (v.includes('nature') || v.includes('natureza')) { if (enrichment?.parks_count_1km >= 2 || enrichment?.neighborhood_type === 'rural') vibeHits++; }
    else if (v.includes('surf') || v.includes('laid-back') || v.includes('descontraído')) { if (enrichment?.beach_nearby || desc.includes('surf') || desc.includes('praia')) vibeHits++; }
    else if (v.includes('community') || v.includes('comunidade')) { if (desc.includes('aldeia') || desc.includes('village') || desc.includes('comunidade')) vibeHits++; }
  });
  score += Math.min(vibeHits * 3, 6);

  // Buyer type specific bonuses
  const bt = (profile.buyer_type || '').toLowerCase();
  if (bt.includes('retired') || bt.includes('reformado')) {
    if (enrichment?.healthcare_count_1km >= 1) score += 3;
    if (walk >= 5) score += 2; // walkability matters for retirees
  } else if (bt.includes('family') || bt.includes('família') || bt.includes('familia')) {
    if (enrichment?.schools === 'excellent') score += 4;
    if (enrichment?.parks_count_1km >= 1) score += 2;
  } else if (bt.includes('remote') || bt.includes('remoto')) {
    if (property.sqm >= 100) score += 2; // space for office
  } else if (bt.includes('investor') || bt.includes('investidor')) {
    // Investors care about location and price/sqm ratio
    if (property.price_per_sqm && property.price_per_sqm < 2000) score += 3;
  }

  return Math.min(100, Math.max(0, score));
}


function buildProfile(answers) {
  // Parse budget values from form fields
  const parseBudget = (s) => {
    if (!s || s.includes('minimum') || s.includes('mínimo')) return 0;
    const n = s.replace(/[^0-9.]/g, '');
    if (s.includes('M')) return parseFloat(n) * 1000000;
    if (s.includes('K')) return parseFloat(n) * 1000;
    return parseFloat(n) || 0;
  };

  return {
    // Location (hardcoded Silver Coast for now)
    city: answers.location || 'Silver Coast',
    country: 'PT',

    // Buyer profile (new)
    buyer_type: answers.buyerType || '',
    transport: answers.transport || '',

    // Property essentials (from form)
    min_beds: parseInt(answers.minBeds) || 1,
    min_baths: parseInt(answers.minBaths) || 1,
    min_sqm: parseInt(answers.minSqm) || 0,
    budget_min: parseBudget(answers.budgetMin),
    budget_max: parseBudget(answers.budgetMax) || 9999999,

    // Property preferences
    property_condition: answers.condition || '',
    outdoor_space: answers.outdoor || '',
    features: answers.features || [],

    // Lifestyle
    setting: answers.setting || '',
    vibe: answers.vibe || [],
    priorities: answers.priorities || [],

    // Pets & parking
    pets: answers.pets || '',
    parking: answers.parking || '',

    // Readiness (gold for agents)
    purpose: answers.purpose || '',
    mortgage: answers.mortgage || '',
    intent: answers.intent || '',
    timeline: answers.timeline || '',

    language: answers.language || 'en',
    raw_answers: answers,
  };
}

async function getCandidates(profile) {
  let query = supabase
    .from('properties')
    .select('*, agents(name, initials, phone, agency:agencies(name))')
    .eq('listing_status', 'active')
    .eq('country', 'PT');

  // If specific concelhos selected, filter by them
  const selectedConcelhos = profile.raw_answers?.concelhos;
  if (selectedConcelhos && Array.isArray(selectedConcelhos) && selectedConcelhos.length > 0) {
    // Strip emoji prefix from concelho names
    const cleanNames = selectedConcelhos.map(c => c.replace(/^[^\w]*/, '').trim());
    query = query.in('city', cleanNames);
  }
  // Otherwise: no city filter — include ALL active Silver Coast properties

  // Budget filter with 20% buffer
  const budgetMin = Math.max(0, (profile.budget_min || 0) * 0.8);
  const budgetMax = (profile.budget_max || 9999999) * 1.2;
  query = query.gte('price', budgetMin).lte('price', budgetMax);

  // Min bedrooms filter
  if (profile.min_beds && profile.min_beds > 1) {
    query = query.gte('beds', profile.min_beds);
  }

  // Min sqm filter (with buffer)
  if (profile.min_sqm && profile.min_sqm > 0) {
    query = query.gte('sqm', Math.round(profile.min_sqm * 0.8));
  }

  // Condition filter
  const condStr = (profile.property_condition || '').toLowerCase();
  if (condStr.includes('new build') || condStr.includes('nova')) {
    query = query.neq('condition', 'renovation-major');
  } else if ((condStr.includes('full renovation') || condStr.includes('total')) && !condStr.includes("don't") && !condStr.includes('tanto')) {
    query = query.neq('condition', 'move-in');
  }

  // Fetch with pagination
  const { data: page1, error: err1 } = await query.range(0, 999);
  if (err1) {
    console.error('Candidate query error:', err1);
    return [];
  }
  let allCandidates = page1 || [];

  if (allCandidates.length === 1000) {
    const { data: page2 } = await query.range(1000, 1999);
    if (page2 && page2.length > 0) {
      allCandidates = [...allCandidates, ...page2];
    }
  }

  console.log(`[getCandidates] ${allCandidates.length} candidates (budget: €${Math.round(budgetMin/1000)}K-€${Math.round(budgetMax/1000)}K, beds>=${profile.min_beds || 1}, sqm>=${profile.min_sqm || 'any'}${selectedConcelhos ? ', concelhos: ' + selectedConcelhos.join(',') : ''})`);
  return allCandidates;
}


async function getEnrichmentBatch(propertyIds) {
  if (!propertyIds.length) return {};

  // Batch into chunks of 200 to avoid query size limits
  const CHUNK = 200;
  const allData = [];
  for (let i = 0; i < propertyIds.length; i += CHUNK) {
    const chunk = propertyIds.slice(i, i + CHUNK);
    const { data } = await supabase
      .from('property_enrichment')
      .select('*')
      .in('property_id', chunk);
    if (data) allData.push(...data);
  }

  // If a property has both old (google+gov) and new (openstreetmap) rows,
  // prefer the openstreetmap one
  const map = {};
  allData.forEach(e => {
    const existing = map[e.property_id];
    if (!existing || e.enrichment_source === 'openstreetmap') {
      map[e.property_id] = e;
    }
  });
  return map;
}

async function enrichAndSave(property) {
  try {
    // Use OpenStreetMap enrichment (works globally — PT, IE, UK, anywhere)
    const enrichment = await enrichWithOSM(property);
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

function formatProperty(p, enrichment) {
  // Merge enrichment data so frontend cards show real data
  const e = enrichment || {};
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
    // Use enrichment walkability if available, else property field
    walkability: e.walkability ?? p.walkability,
    walkability_label: e.walkability_label || null,
    // Use enrichment schools if available
    schools_quality: e.schools || p.schools_quality,
    pet_friendly: p.pet_friendly,
    nearby_dog_park: p.nearby_dog_park,
    neighborhood_vibe: p.neighborhood_vibe,
    neighborhood_type: e.neighborhood_type || null,
    features: p.features,
    parking: p.parking,
    commute_city_center: p.commute_city_center,
    image_urls: p.image_urls,
    source_url: p.source_url,
    latitude: p.latitude,
    longitude: p.longitude,
    // Enrichment-derived amenity data (replaces old hardcoded fields)
    amenity_groceries_km: e.shops_count_1km > 0 ? Math.round((1 / Math.max(e.shops_count_1km, 1)) * 10) / 10 : p.amenity_groceries_km,
    amenity_parks_km: e.nearest_park?.distance_km || p.amenity_parks_km,
    amenity_hospitals_km: e.nearest_healthcare?.[0]?.distance_km || (e.healthcare_count_1km > 0 ? 0.8 : p.amenity_hospitals_km),
    // New enrichment fields for display
    shops_count_1km: e.shops_count_1km || 0,
    restaurants_count_1km: e.restaurants_count_1km || 0,
    transport_count_500m: e.transport_count_500m || 0,
    beach_nearby: e.beach_nearby || false,
    nearest_beach: e.nearest_beach || null,
    nearest_airport: e.nearest_airport || null,
    schools_count_2km: e.schools_count_2km || 0,
    parks_count_1km: e.parks_count_1km || 0,
    healthcare_count_1km: e.healthcare_count_1km || 0,
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
// AGENT AUTH HELPERS
// ============================================================

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const verify = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verify;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Auth middleware — validates agent session token
async function authAgent(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  const { data: session } = await supabase
    .from('agent_sessions')
    .select('agent_id, expires_at')
    .eq('token', token)
    .single();

  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.agentId = session.agent_id;
  next();
}

// ============================================================
// AGENT AUTH ENDPOINTS
// ============================================================

// Register new agent
app.post('/api/agents/register', async (req, res) => {
  try {
    const { name, email, password, phone, agency_name, license_number, areas_served } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('agents')
      .select('id')
      .eq('email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Find or create agency
    let agencyId = null;
    if (agency_name) {
      const { data: existingAgency } = await supabase
        .from('agencies')
        .select('id')
        .eq('name', agency_name)
        .single();

      if (existingAgency) {
        agencyId = existingAgency.id;
      } else {
        const { data: newAgency } = await supabase
          .from('agencies')
          .insert({ name: agency_name })
          .select('id')
          .single();
        agencyId = newAgency?.id;
      }
    }

    // Create agent
    const { data: agent, error } = await supabase
      .from('agents')
      .insert({
        name,
        email,
        password_hash: hashPassword(password),
        phone: phone || null,
        initials: name.split(' ').map(n => n[0]).join('').toUpperCase(),
        agency_id: agencyId,
        license_number: license_number || null,
        areas_served: areas_served || [],
      })
      .select('id, name, email')
      .single();

    if (error) throw error;

    // Create session
    const token = generateToken();
    await supabase.from('agent_sessions').insert({
      agent_id: agent.id,
      token,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
    });

    // Create welcome notification
    await supabase.from('agent_notifications').insert({
      agent_id: agent.id,
      type: 'system',
      title: 'Welcome to homeAImatch!',
      message: 'Your agent account is active. Start by claiming your existing listings or adding new properties.',
    });

    res.json({ agent, token });
  } catch (err) {
    console.error('Register error:', err.message, err.details || '', err.hint || '');
    res.status(500).json({ error: err.message || 'Registration failed' });
  }
});

// Login
app.post('/api/agents/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, email, password_hash, agency_id, agencies(name)')
      .eq('email', email)
      .single();

    if (!agent || !agent.password_hash || !verifyPassword(password, agent.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await supabase.from('agents').update({ last_login_at: new Date().toISOString() }).eq('id', agent.id);

    // Create session
    const token = generateToken();
    await supabase.from('agent_sessions').insert({
      agent_id: agent.id,
      token,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });

    res.json({
      agent: { id: agent.id, name: agent.name, email: agent.email, agency: agent.agencies?.name },
      token,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Logout
app.post('/api/agents/logout', authAgent, async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  await supabase.from('agent_sessions').delete().eq('token', token);
  res.json({ success: true });
});

// ============================================================
// AGENT DASHBOARD ENDPOINTS
// ============================================================

// Get dashboard overview
app.get('/api/agents/dashboard', authAgent, async (req, res) => {
  try {
    const agentId = req.agentId;

    // Get agent profile
    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, email, phone, initials, agency_id, agencies(name, logo_url), areas_served, specialties, bio, license_number')
      .eq('id', agentId)
      .single();

    // My properties (directly assigned)
    const { data: myProperties, count: propCount } = await supabase
      .from('properties')
      .select('*', { count: 'exact' })
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false });

    // My claimed listings
    const { data: claims } = await supabase
      .from('listing_claims')
      .select('id, status, claimed_at, property_id, properties(id, title, price, currency, city, image_urls)')
      .eq('agent_id', agentId)
      .order('claimed_at', { ascending: false });

    // My leads
    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .select('id, buyer_name, buyer_email, buyer_phone, buyer_message, buyer_profile, status, created_at, match_score, property_id, properties(title, price, currency, city, image_urls)')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (leadsError) {
      console.error('[Dashboard] Leads query error:', leadsError.message, leadsError.details);
    }
    console.log(`[Dashboard] Agent ${agentId} — found ${(leads || []).length} leads`);

    // Unread notifications count
    const { count: unreadCount } = await supabase
      .from('agent_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('agent_id', agentId)
      .eq('is_read', false);

    // Property views (last 30 days) for my properties
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const propertyIds = (myProperties || []).map(p => p.id);
    let totalViews = 0;
    if (propertyIds.length > 0) {
      const { count } = await supabase
        .from('property_views')
        .select('id', { count: 'exact', head: true })
        .in('property_id', propertyIds)
        .gte('created_at', thirtyDaysAgo);
      totalViews = count || 0;
    }

    res.json({
      agent,
      stats: {
        total_listings: propCount || 0,
        total_leads: (leads || []).length,
        new_leads: (leads || []).filter(l => l.status === 'new').length,
        total_views: totalViews,
        pending_claims: (claims || []).filter(c => c.status === 'pending').length,
      },
      properties: myProperties || [],
      claims: claims || [],
      leads: leads || [],
      unread_notifications: unreadCount || 0,
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LISTING CLAIMS
// ============================================================

// Get unclaimed properties (for agent to browse and claim)
app.get('/api/agents/unclaimed', authAgent, async (req, res) => {
  try {
    const { search } = req.query;
    
    let propertyIds = null;
    
    // If searching by agent/agency name, find matching agent_ids first
    if (search) {
      // Search agents by name
      const { data: matchingAgents } = await supabase
        .from('agents')
        .select('id, name, agency:agencies(name)')
        .or(`name.ilike.%${search}%`);
      
      // Search agencies by name and get their agents
      const { data: matchingAgencies } = await supabase
        .from('agencies')
        .select('id, name')
        .ilike('name', `%${search}%`);
      
      const agencyIds = (matchingAgencies || []).map(a => a.id);
      
      let agentsFromAgencies = [];
      if (agencyIds.length > 0) {
        const { data } = await supabase
          .from('agents')
          .select('id')
          .in('agency_id', agencyIds);
        agentsFromAgencies = data || [];
      }
      
      // Combine all matching agent IDs
      const allAgentIds = new Set([
        ...(matchingAgents || []).map(a => a.id),
        ...agentsFromAgencies.map(a => a.id),
      ]);
      
      // If we found agent matches, get their property IDs
      if (allAgentIds.size > 0) {
        const { data: agentProps } = await supabase
          .from('properties')
          .select('id')
          .in('agent_id', [...allAgentIds])
          .eq('listing_status', 'active');
        propertyIds = new Set((agentProps || []).map(p => p.id));
      }
    }

    // Fetch properties
    let query = supabase
      .from('properties')
      .select('id, title, price, currency, beds, baths, sqm, property_type, city, region, county, image_urls, source_url, agent_id, agents(name, agency:agencies(name))')
      .eq('listing_status', 'active')
      .order('created_at', { ascending: false })
      .limit(200);

    // Add text search filter for title/city/region
    if (search) {
      query = query.or(`title.ilike.%${search}%,region.ilike.%${search}%,city.ilike.%${search}%,county.ilike.%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    let claimable = (data || []).filter(p => p.agent_id !== req.agentId);
    
    // Merge in agent/agency search results (properties found via agent name search)
    if (propertyIds && propertyIds.size > 0) {
      // Get properties matching agent/agency that weren't in the text search
      const existingIds = new Set(claimable.map(p => p.id));
      const { data: agentMatchProps } = await supabase
        .from('properties')
        .select('id, title, price, currency, beds, baths, sqm, property_type, city, region, county, image_urls, source_url, agent_id, agents(name, agency:agencies(name))')
        .in('id', [...propertyIds])
        .eq('listing_status', 'active')
        .limit(100);
      
      for (const p of (agentMatchProps || [])) {
        if (!existingIds.has(p.id) && p.agent_id !== req.agentId) {
          claimable.push(p);
        }
      }
    }

    // Limit results to 50
    claimable = claimable.slice(0, 50);

    res.json({ properties: claimable });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Claim a listing
app.post('/api/agents/claims', authAgent, async (req, res) => {
  try {
    const { property_id, evidence_url, notes } = req.body;

    // Check if already claimed by this agent
    const { data: existing } = await supabase
      .from('listing_claims')
      .select('id')
      .eq('property_id', property_id)
      .eq('agent_id', req.agentId)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'You have already claimed this listing' });
    }

    const { data: claim, error } = await supabase
      .from('listing_claims')
      .insert({
        property_id,
        agent_id: req.agentId,
        evidence_url,
        notes,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw error;

    // Auto-approve if property has no agent_id (unclaimed)
    const { data: property } = await supabase
      .from('properties')
      .select('agent_id')
      .eq('id', property_id)
      .single();

    if (property && !property.agent_id) {
      // Auto-approve and assign
      await supabase.from('listing_claims').update({ status: 'approved', reviewed_at: new Date().toISOString() }).eq('id', claim.id);
      await supabase.from('properties').update({ agent_id: req.agentId }).eq('id', property_id);
      claim.status = 'approved';

      // Notify agent
      await supabase.from('agent_notifications').insert({
        agent_id: req.agentId,
        type: 'listing_claimed',
        title: 'Listing claimed!',
        message: 'Your claim has been auto-approved. The listing is now linked to your account.',
        data: { property_id },
      });
    }

    res.json({ claim });
  } catch (err) {
    console.error('Claim error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AGENT NOTIFICATIONS
// ============================================================

app.get('/api/agents/notifications', authAgent, async (req, res) => {
  try {
    const { data } = await supabase
      .from('agent_notifications')
      .select('*')
      .eq('agent_id', req.agentId)
      .order('created_at', { ascending: false })
      .limit(30);

    res.json({ notifications: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark notification as read
app.put('/api/agents/notifications/:id/read', authAgent, async (req, res) => {
  await supabase.from('agent_notifications').update({ is_read: true }).eq('id', req.params.id).eq('agent_id', req.agentId);
  res.json({ success: true });
});

// Mark all as read
app.put('/api/agents/notifications/read-all', authAgent, async (req, res) => {
  await supabase.from('agent_notifications').update({ is_read: true }).eq('agent_id', req.agentId).eq('is_read', false);
  res.json({ success: true });
});

// ============================================================
// AGENT LEAD MANAGEMENT
// ============================================================

// Update lead status
app.put('/api/agents/leads/:id', authAgent, async (req, res) => {
  try {
    const { status, agent_notes } = req.body;
    const { data, error } = await supabase
      .from('leads')
      .update({ status, agent_notes })
      .eq('id', req.params.id)
      .eq('agent_id', req.agentId)
      .select()
      .single();

    if (error) throw error;
    res.json({ lead: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AGENT PROFILE
// ============================================================

app.put('/api/agents/profile', authAgent, async (req, res) => {
  try {
    const { name, phone, bio, areas_served, specialties, license_number } = req.body;
    const { data, error } = await supabase
      .from('agents')
      .update({ name, phone, bio, areas_served, specialties, license_number })
      .eq('id', req.agentId)
      .select('id, name, email, phone, bio, areas_served, specialties, license_number')
      .single();

    if (error) throw error;
    res.json({ agent: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// AGENT PROPERTIES MANAGEMENT (add/edit/delete)
// ============================================================

// Add property as agent (auto-assigns agent_id)
app.post('/api/agents/properties', authAgent, async (req, res) => {
  try {
    const propertyData = req.body;
    propertyData.agent_id = req.agentId;
    propertyData.listing_status = propertyData.listing_status || 'active';

    const { data, error } = await supabase
      .from('properties')
      .insert(propertyData)
      .select()
      .single();

    if (error) throw error;
    res.json({ property: data });
  } catch (err) {
    console.error('Agent add property error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update own property
app.put('/api/agents/properties/:id', authAgent, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('properties')
      .update(req.body)
      .eq('id', req.params.id)
      .eq('agent_id', req.agentId)
      .select()
      .single();

    if (error) throw error;
    res.json({ property: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete own property
app.delete('/api/agents/properties/:id', authAgent, async (req, res) => {
  try {
    const { error } = await supabase
      .from('properties')
      .delete()
      .eq('id', req.params.id)
      .eq('agent_id', req.agentId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// PASSWORD MANAGEMENT
// ============================================================

// Change password (logged-in agent)
app.post('/api/agents/change-password', authAgent, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current password hash
    const { data: agent } = await supabase
      .from('agents')
      .select('password_hash')
      .eq('id', req.agentId)
      .single();

    if (!agent || !verifyPassword(current_password, agent.password_hash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
    await supabase
      .from('agents')
      .update({ password_hash: hashPassword(new_password) })
      .eq('id', req.agentId);

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// Forgot password — send reset link
app.post('/api/agents/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    // Always return success to prevent email enumeration
    const successMsg = 'If that email exists, a reset link has been sent.';

    if (!email) return res.json({ message: successMsg });

    const { data: agent } = await supabase
      .from('agents')
      .select('id, name, email')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (!agent) {
      // Don't reveal that the email doesn't exist
      return res.json({ message: successMsg });
    }

    // Generate reset token (expires in 1 hour)
    const resetToken = generateToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // Store reset token in agent_sessions with a special type
    await supabase.from('agent_sessions').insert({
      agent_id: agent.id,
      token: 'reset_' + resetToken,
      expires_at: expiresAt,
    });

    // Build reset link
    const resetLink = `https://homeaimatch.com/agent-dashboard.html#reset_token=${resetToken}`;

    // Send email via Resend or Formspree
    // For now, log it (replace with actual email sending)
    console.log(`[Password Reset] Agent: ${agent.email}, Link: ${resetLink}`);

    // Try to send via a simple email endpoint if available
    try {
      // If you have Resend configured:
      if (process.env.RESEND_API_KEY) {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: 'homeAImatch <noreply@homeaimatch.com>',
            to: agent.email,
            subject: 'Reset your homeAImatch password',
            html: `
              <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
                <h2 style="color:#1a2b3c">Reset your password</h2>
                <p>Hi ${agent.name},</p>
                <p>You requested a password reset for your homeAImatch agent account. Click the button below to set a new password:</p>
                <a href="${resetLink}" style="display:inline-block;background:#1e96d1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">Reset Password</a>
                <p style="color:#6b7b8d;font-size:13px">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
                <p style="color:#6b7b8d;font-size:12px;margin-top:24px">— homeAImatch team</p>
              </div>
            `,
          }),
        });
        console.log(`[Password Reset] Email sent to ${agent.email}`);
      } else {
        console.log(`[Password Reset] RESEND_API_KEY not set. Reset link logged above.`);
      }
    } catch (emailErr) {
      console.error('[Password Reset] Email send failed:', emailErr.message);
    }

    res.json({ message: successMsg });
  } catch (err) {
    console.error('Forgot password error:', err.message);
    res.json({ message: 'If that email exists, a reset link has been sent.' });
  }
});

// Reset password with token
app.post('/api/agents/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Find the reset session
    const { data: session } = await supabase
      .from('agent_sessions')
      .select('agent_id, expires_at')
      .eq('token', 'reset_' + token)
      .single();

    if (!session || new Date(session.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    // Update password
    await supabase
      .from('agents')
      .update({ password_hash: hashPassword(new_password) })
      .eq('id', session.agent_id);

    // Delete the reset token so it can't be reused
    await supabase
      .from('agent_sessions')
      .delete()
      .eq('token', 'reset_' + token);

    // Also invalidate all existing sessions for this agent (force re-login)
    await supabase
      .from('agent_sessions')
      .delete()
      .eq('agent_id', session.agent_id);

    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nhomeAImatch API running on port ${PORT}`);
  console.log(`AI scoring: ${process.env.ANTHROPIC_API_KEY ? 'ENABLED (Claude)' : 'DISABLED (rule-based)'}`);
  console.log(`Database: ${process.env.SUPABASE_URL ? 'CONNECTED' : 'NOT CONFIGURED'}\n`);
});
