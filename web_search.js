'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// WEB SEARCH  –  Serper.dev (Google Search API)
//
// Used when guests ask for info not in the knowledge base:
//   • Hotel / venue phone numbers & addresses
//   • Google Maps links / directions
//   • Distance or travel time between locations
//   • Any other live, factual query
//
// Free tier: 2,500 searches / month  (no credit card required)
// Sign up :  https://serper.dev  →  copy your API key into .env as SERPER_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Search entry point ────────────────────────────────────────────────────────

/**
 * Searches Google via Serper.dev and returns a compact, GPT-readable string.
 * If SERPER_API_KEY is not configured, throws so the caller can fall back.
 *
 * @param {string} query  The search query string.
 * @returns {Promise<string>}  Formatted search result text.
 */
async function searchWeb(query) {
  const key = process.env.SERPER_API_KEY;

  if (!key || key === 'your_serper_key_here') {
    throw new Error('SERPER_API_KEY not configured');
  }

  // gl:'in' = India locale → gets relevant Indian results (prices in ₹, local businesses)
  // hl:'en' = response language; GPT translates to the user's language as needed
  const body = JSON.stringify({ q: query, num: 5, gl: 'in', hl: 'en' });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'google.serper.dev',
        path:     '/search',
        method:   'POST',
        headers: {
          'X-API-KEY':     key,
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data',  (chunk) => { raw += chunk; });
        res.on('end',   () => {
          try {
            resolve(formatResults(JSON.parse(raw), query));
          } catch (e) {
            reject(new Error('Failed to parse Serper response'));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Result formatter ──────────────────────────────────────────────────────────

/**
 * Extracts the most useful information from a Serper response.
 * Priority: answerBox → knowledgeGraph → organic snippets.
 *
 * @param {object} data   Parsed Serper JSON response.
 * @param {string} query  Original query (used in fallback message).
 * @returns {string}
 */
function formatResults(data, query) {
  const parts = [];

  // ── 1. Answer Box (direct factual answer — highest priority) ─────────────
  if (data.answerBox) {
    const ab = data.answerBox;
    if (ab.answer)      parts.push(`Answer: ${ab.answer}`);
    else if (ab.snippet) parts.push(`Answer: ${ab.snippet}`);
    if (ab.link)        parts.push(`Source: ${ab.link}`);
  }

  // ── 2. Knowledge Graph (ideal for businesses: phone, address, Maps link) ──
  if (data.knowledgeGraph) {
    const kg = data.knowledgeGraph;
    if (kg.title)            parts.push(`\n${kg.title}`);
    if (kg.type)             parts.push(`Type: ${kg.type}`);
    if (kg.description)      parts.push(kg.description);
    if (kg.address)          parts.push(`Address: ${kg.address}`);
    if (kg.phone)            parts.push(`Phone: ${kg.phone}`);
    if (kg.website)          parts.push(`Website: ${kg.website}`);
    if (kg.rating)           parts.push(`Rating: ${kg.rating} ⭐`);
    if (kg.attributes) {
      const useful = Object.entries(kg.attributes)
        .slice(0, 6)
        .map(([k, v]) => `${k}: ${v}`)
        .join(' | ');
      if (useful) parts.push(useful);
    }
  }

  // ── 3. Places (local business listings — ideal for "near me" queries) ───────
  // Serper returns this for searches like "makeup artists near InterContinental Jaipur".
  // Each entry has name, address, rating, phone, website.
  if (data.places && data.places.length > 0) {
    parts.push('\nNearby places found:');
    data.places.slice(0, 4).forEach((p, i) => {
      let line = `${i + 1}. *${p.title}*`;
      if (p.category)     line += ` (${p.category})`;
      if (p.rating)       line += ` — ⭐ ${p.rating}${p.ratingCount ? ` (${p.ratingCount} reviews)` : ''}`;
      parts.push(line);
      if (p.address)      parts.push(`   📍 ${p.address}`);
      if (p.phoneNumber)  parts.push(`   📞 ${p.phoneNumber}`);
      if (p.website)      parts.push(`   🌐 ${p.website}`);
    });
  }

  // ── 4. Organic search results (top 3 snippets) ────────────────────────────
  // Used as fallback when places data isn't available
  if (data.organic && data.organic.length > 0 && !(data.places && data.places.length > 0)) {
    if (parts.length > 0) parts.push('\nTop results:');
    data.organic.slice(0, 3).forEach((r, i) => {
      parts.push(`${i + 1}. ${r.title}: ${r.snippet}`);
      if (r.link) parts.push(`   ${r.link}`);
    });
  }

  // ── 5. People Also Ask (bonus context when results are thin) ─────────────
  if (data.peopleAlsoAsk && data.peopleAlsoAsk.length > 0 && parts.length < 3) {
    const paa = data.peopleAlsoAsk[0];
    if (paa.snippet) parts.push(`\nRelated: ${paa.question} → ${paa.snippet}`);
  }

  return parts.length > 0
    ? parts.join('\n').trim()
    : `No useful results found for: "${query}"`;
}

module.exports = { searchWeb };
