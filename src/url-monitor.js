/**
 * URL Monitor — checks pages for content changes or price drops.
 * Uses fetch + crypto hash for change detection. No external dependencies.
 */
import { createHash } from 'crypto';
import {
  getActiveMonitors,
  updateMonitorHash,
  updateMonitorPrice,
} from './db.js';

/**
 * Fetch a URL and return its text content (stripped of scripts/styles).
 */
async function isUrlSafe(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const hostname = parsed.hostname;
    if (['localhost', 'metadata.google.internal', 'instance-data'].includes(hostname)) return false;
    const { lookup } = await import('dns/promises');
    const { address } = await lookup(hostname);
    const parts = address.split('.').map(Number);
    if (parts[0] === 127 || parts[0] === 10) return false;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (address === '0.0.0.0' || address === '::1') return false;
    return true;
  } catch { return false; }
}

async function fetchPageContent(url) {
  try {
    if (!await isUrlSafe(url)) { console.warn(`[URL Monitor] Blocked private URL: ${url}`); return null; }
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReminderBot/1.0)' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    let text = await res.text();
    // Strip scripts, styles, and HTML tags for cleaner comparison
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    return text;
  } catch (err) {
    console.error(`[URL Monitor] Failed to fetch ${url}:`, err.message);
    return null;
  }
}

/**
 * Hash content for change detection.
 */
function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extract price-like numbers from text (basic pattern matching).
 */
function extractPrice(text) {
  // Match common price formats: $99.99, 99.99$, USD 99.99, 99,99€, etc.
  const patterns = [
    /(?:\$|USD|usd)\s*(\d{1,7}(?:[.,]\d{2})?)/,
    /(\d{1,7}(?:[.,]\d{2})?)\s*(?:\$|USD|usd|€|EUR|eur)/,
    /price[:\s]*(?:\$|USD)?\s*(\d{1,7}(?:[.,]\d{2})?)/i,
  ];
  for (const p of patterns) {
    const match = text.match(p);
    if (match) return parseFloat(match[1].replace(',', '.'));
  }
  return null;
}

/**
 * Check all active monitors for changes.
 * Returns an array of { monitor, changeType, details } for alerts.
 */
export async function checkAllMonitors() {
  const monitors = await getActiveMonitors();
  const alerts = [];

  for (const monitor of monitors) {
    const content = await fetchPageContent(monitor.url);
    if (!content) continue;

    if (monitor.check_type === 'price') {
      const price = extractPrice(content);
      if (price !== null) {
        if (monitor.last_price !== null && price < monitor.last_price) {
          alerts.push({
            monitor,
            changeType: 'price_drop',
            details: `Price dropped from ${monitor.last_price} to ${price}`,
          });
        }
        await updateMonitorPrice(monitor.id, price);
      }
    } else {
      // Content change detection
      const hash = hashContent(content);
      if (monitor.last_hash && hash !== monitor.last_hash) {
        alerts.push({
          monitor,
          changeType: 'content_changed',
          details: 'Page content has changed',
        });
      }
      await updateMonitorHash(monitor.id, hash);
    }
  }

  return alerts;
}
