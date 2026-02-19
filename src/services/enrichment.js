/**
 * homeAImatch — Free UK Government API Enrichment
 * EPC Register: Energy Performance Certificates
 * Land Registry: Price Paid Data
 * Both completely free, no API key needed.
 */

/**
 * Enrich a property with EPC data
 * API: https://epc.opendatacommunities.org
 */
export async function enrichWithEPC(postcode, addressLine1) {
  if (!postcode) return null;
  
  try {
    const url = `https://epc.opendatacommunities.org/api/v1/domestic/search?postcode=${encodeURIComponent(postcode)}&size=100`;
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.rows?.length) return null;

    // Try to match by address
    const normalise = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = normalise(addressLine1);
    let match = data.rows.find(r => normalise(r.address || '').includes(target));
    if (!match) match = data.rows[0]; // fallback to first result in postcode

    return {
      epc_rating_verified: match['current-energy-rating'],
      epc_score_verified: parseInt(match['current-energy-efficiency']) || null,
      epc_url: match['certificate-hash']
        ? `https://find-energy-certificate.service.gov.uk/energy-certificate/${match['certificate-hash']}`
        : null,
    };
  } catch (err) {
    console.error('EPC enrichment error:', err.message);
    return null;
  }
}

/**
 * Enrich with Land Registry Price Paid Data
 * API: https://landregistry.data.gov.uk (SPARQL endpoint)
 */
export async function enrichWithLandRegistry(postcode) {
  if (!postcode) return null;

  try {
    const query = `
      PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
      PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
      SELECT ?date ?price ?propertyType
      WHERE {
        ?tx lrppi:pricePaid ?price ;
            lrppi:transactionDate ?date ;
            lrppi:propertyAddress ?addr ;
            lrppi:propertyType ?propertyType .
        ?addr lrcommon:postcode "${postcode}" .
      }
      ORDER BY DESC(?date) LIMIT 20`;

    const url = `https://landregistry.data.gov.uk/app/root/qonsole/query?output=json&query=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results?.bindings?.length) return null;

    const txns = data.results.bindings.map(b => ({
      date: b.date?.value,
      price: parseInt(b.price?.value) || 0,
      type: b.propertyType?.value?.split('/').pop(),
    }));

    const prices = txns.map(t => t.price).filter(p => p > 0);
    const avgPrice = prices.length
      ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
      : null;

    // 1-year price trend
    const now = new Date();
    const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    const recent = txns.filter(t => new Date(t.date) >= yearAgo);
    const older = txns.filter(t => new Date(t.date) < yearAgo);
    let trend = null;
    if (recent.length && older.length) {
      const avgR = recent.reduce((a, b) => a + b.price, 0) / recent.length;
      const avgO = older.reduce((a, b) => a + b.price, 0) / older.length;
      trend = parseFloat(((avgR - avgO) / avgO * 100).toFixed(1));
    }

    return {
      last_sold_price: txns[0]?.price || null,
      last_sold_date: txns[0]?.date || null,
      avg_price_area: avgPrice,
      price_trend_1yr_pct: trend,
      price_history: txns.slice(0, 10),
    };
  } catch (err) {
    console.error('Land Registry enrichment error:', err.message);
    return null;
  }
}

/**
 * Run all free enrichments for a property
 */
export async function enrichProperty(property) {
  const [epc, landReg] = await Promise.all([
    enrichWithEPC(property.postcode, property.address_line1),
    enrichWithLandRegistry(property.postcode),
  ]);

  return {
    property_id: property.id,
    ...(epc || {}),
    ...(landReg || {}),
    enriched_at: new Date().toISOString(),
  };
}
