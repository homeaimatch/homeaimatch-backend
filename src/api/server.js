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
import { enrichProperty } from '../services/enrichment.js';

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
  let query = supabase
    .from('properties')
    .select('*, agents(name, initials, phone, agency:agencies(name))')
    .eq('listing_status', 'active');

  // Filter by city if specified (case-insensitive)
  if (profile.city) {
    query = query.ilike('city', profile.city);
  }

  // Filter by country (case-insensitive)
  if (profile.country) {
    query = query.ilike('country', profile.country);
  }

  // Budget filter with 30% buffer (let AI handle nuance)
  // Normalise budget string (handle en-dash vs hyphen)
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
  query = query.gte('price', minP).lte('price', maxP);

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
    console.error('Candidate query error:', error);
    return [];
  }
  return data || [];
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
    const { data: leads } = await supabase
      .from('leads')
      .select('id, buyer_name, buyer_email, buyer_phone, message, status, created_at, property_id, properties(title, price, city)')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(50);

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
    const { city, search } = req.query;
    let query = supabase
      .from('properties')
      .select('id, title, price, currency, beds, baths, sqm, city, region, county, image_urls, source_url, agent_id')
      .is('agent_id', null)
      .order('created_at', { ascending: false })
      .limit(50);

    if (city) query = query.ilike('city', `%${city}%`);
    if (search) query = query.or(`title.ilike.%${search}%,region.ilike.%${search}%,address_line1.ilike.%${search}%`);

    const { data, error } = await query;
    if (error) throw error;

    res.json({ properties: data || [] });
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
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\nhomeAImatch API running on port ${PORT}`);
  console.log(`AI scoring: ${process.env.ANTHROPIC_API_KEY ? 'ENABLED (Claude)' : 'DISABLED (rule-based)'}`);
  console.log(`Database: ${process.env.SUPABASE_URL ? 'CONNECTED' : 'NOT CONFIGURED'}\n`);
});
