'use strict';

const express  = require('express');
const crypto   = require('crypto');
const https    = require('https');
const http     = require('http');
const { URL }  = require('url');

const app = express();
app.use(express.json());

/* ── CORS: only allow requests from the nginx frontend ── */
app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─────────────────────────────────────────────────────────────
   PlaceToPay auth header generator
   Algorithm (from PlaceToPay docs):
     nonce   = random bytes (hex string)
     seed    = ISO 8601 UTC datetime
     tranKey = Base64( SHA-256( nonce + seed + secretKey ) )
     send    auth.nonce = Base64( nonce )
───────────────────────────────────────────────────────────── */
function ptpAuth() {
  const login     = process.env.PTP_LOGIN;
  const secretKey = process.env.PTP_SECRET;

  if (!login || !secretKey) {
    throw new Error('PTP_LOGIN and PTP_SECRET environment variables are not set.');
  }

  const rawNonce = crypto.randomBytes(16).toString('hex');
  const seed     = new Date().toISOString();
  const tranKey  = crypto
    .createHash('sha256')
    .update(rawNonce + seed + secretKey)
    .digest('base64');
  const nonce    = Buffer.from(rawNonce).toString('base64');

  return { login, tranKey, nonce, seed };
}

/* ── Simple HTTP/HTTPS fetch (no external deps) ── */
function fetchJSON(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const body = options.body ? Buffer.from(options.body) : null;

    const reqOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        ...(body ? { 'Content-Length': body.length } : {}),
      },
    };

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Invalid JSON response: ' + data.slice(0, 200))); }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ─────────────────────────────────────────────────────────────
   POST /api/create-session
   Creates a PlaceToPay hosted checkout session.
   Returns { success, processUrl, requestId } or { success, error }
───────────────────────────────────────────────────────────── */
app.post('/api/create-session', async (req, res) => {
  const {
    reference,        // invoice / order reference
    description,      // payment description
    amount,           // numeric amount
    currency,         // BZD, USD, etc.
    customerName,
    customerEmail,
    customerPhone,
    customerAddress,
    expiryHours,      // how many hours until the link expires (default 24)
  } = req.body;

  /* Validate required fields */
  if (!reference || !description || !amount || !currency) {
    return res.status(400).json({ success: false, error: 'reference, description, amount and currency are required.' });
  }

  const endpoint  = process.env.PTP_ENDPOINT;
  const returnUrl = process.env.PTP_RETURN_URL || 'https://yourdomain.com/payment/return';

  if (!endpoint) {
    return res.status(500).json({ success: false, error: 'PTP_ENDPOINT environment variable is not set.' });
  }

  /* Build expiration date */
  const hours      = parseInt(expiryHours, 10) || 24;
  const expiration = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  /* Build request payload */
  const payload = {
    auth:    ptpAuth(),
    payment: {
      reference:   String(reference),
      description: String(description),
      amount: {
        currency: String(currency).toUpperCase(),
        total:    parseFloat(amount),
      },
    },
    expiration,
    returnUrl,
    ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || 'PayPortalBZ/1.0',
  };

  /* Optional buyer info */
  if (customerName || customerEmail || customerPhone) {
    payload.buyer = {};
    if (customerName)   payload.buyer.name   = customerName;
    if (customerEmail)  payload.buyer.email  = customerEmail;
    if (customerPhone)  payload.buyer.mobile = customerPhone;
    if (customerAddress) payload.buyer.address = { street: customerAddress };
  }

  console.log('[PTP] Creating session →', endpoint, JSON.stringify({ reference, amount, currency }));

  try {
    const { status: httpStatus, body: data } = await fetchJSON(endpoint, {
      method: 'POST',
      body:   JSON.stringify(payload),
    });

    console.log('[PTP] Response', httpStatus, JSON.stringify(data).slice(0, 300));

    if (data.status && data.status.status === 'OK') {
      return res.json({
        success:    true,
        processUrl: data.processUrl,
        requestId:  data.requestId,
      });
    }

    return res.status(400).json({
      success: false,
      error:   (data.status && data.status.message) || 'PlaceToPay rejected the session request.',
      raw:     data,
    });

  } catch (err) {
    console.error('[PTP] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────
   POST /api/check-session/:requestId
   Queries the status of an existing session.
───────────────────────────────────────────────────────────── */
app.post('/api/check-session/:requestId', async (req, res) => {
  const endpoint  = process.env.PTP_ENDPOINT;
  const sessionUrl = endpoint.replace(/\/$/, '') + '/' + req.params.requestId;

  try {
    const { body: data } = await fetchJSON(sessionUrl, {
      method: 'POST',
      body:   JSON.stringify({ auth: ptpAuth() }),
    });

    /* Normalise status to our portal's values */
    const rawStatus = (data.status && data.status.status) || 'PENDING';
    const statusMap = { APPROVED: 'paid', PENDING: 'pending', REJECTED: 'rejected', FAILED: 'rejected' };
    const portalStatus = statusMap[rawStatus] || 'pending';

    return res.json({ success: true, status: portalStatus, raw: data });
  } catch (err) {
    console.error('[PTP] Check session error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Health check ── */
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'payportal-backend' }));

/* ── Start ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PayPortal backend listening on port ${PORT}`);
  console.log(`PTP_ENDPOINT : ${process.env.PTP_ENDPOINT || '(not set)'}`);
  console.log(`PTP_LOGIN    : ${process.env.PTP_LOGIN    || '(not set)'}`);
  console.log(`PTP_RETURN   : ${process.env.PTP_RETURN_URL || '(not set)'}`);
});
