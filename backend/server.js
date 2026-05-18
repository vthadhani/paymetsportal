'use strict';

const express = require('express');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

const app = express();
app.use(express.json());

app.use(function(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ─────────────────────────────────────────────────────────
   PlaceToPay auth — matches exactly what WooCommerce sends
   The WooCommerce plugin uses:
     nonce    = base64( random_bytes )
     tranKey  = base64( sha256( base64_decoded_nonce + seed + secret ) )
───────────────────────────────────────────────────────── */
function ptpAuth() {
  const login     = process.env.PTP_LOGIN   || '';
  const secretKey = process.env.PTP_SECRET  || '';

  // Generate nonce as raw bytes then base64 encode — same as WooCommerce PHP:
  // $nonce = base64_encode(Str::random(16));
  const rawBytes  = crypto.randomBytes(16);
  const nonce     = rawBytes.toString('base64');
  const seed      = new Date().toISOString();

  // WooCommerce tranKey: base64(sha256(base64_decode(nonce) . seed . secret))
  // base64_decode(nonce) gives back the raw bytes
  const tranKey = crypto
    .createHash('sha256')
    .update(Buffer.concat([rawBytes, Buffer.from(seed), Buffer.from(secretKey)]))
    .digest('base64');

  return { login, tranKey, nonce, seed };
}

function postJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); }
    catch(e) { return reject(new Error('Invalid URL: "' + urlStr + '"')); }

    const lib  = parsed.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'Content-Length': data.length,
      },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { reject(new Error('Non-JSON from bank: ' + raw.slice(0, 500))); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getReturnUrl(req) {
  const env = process.env.PTP_RETURN_URL || '';
  if (env && !env.includes('yourdomain.com')) return env;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers['host'] || 'localhost:6680';
  return proto + '://' + host + '/payment/return.html';
}

/* ── Health ── */
app.get('/api/health', (_req, res) => {
  res.json({
    ok:          true,
    ptpLogin:    !!process.env.PTP_LOGIN,
    ptpSecret:   !!process.env.PTP_SECRET,
    ptpEndpoint: process.env.PTP_ENDPOINT || '(not set)',
    returnUrl:   process.env.PTP_RETURN_URL || '(auto)',
  });
});

/* ── Debug: test auth only ── */
app.get('/api/debug-auth', (_req, res) => {
  const auth = ptpAuth();
  res.json({
    login:    auth.login    ? auth.login.slice(0,8) + '...' : 'NOT SET',
    tranKey:  auth.tranKey  ? auth.tranKey.slice(0,8) + '...' : 'empty',
    nonce:    auth.nonce    ? auth.nonce.slice(0,8) + '...' : 'empty',
    seed:     auth.seed,
    endpoint: process.env.PTP_ENDPOINT || 'NOT SET',
  });
});

/* ── Create session ── */
app.post('/api/create-session', async (req, res) => {
  const {
    reference, description, amount, currency,
    customerName, customerEmail, customerPhone, customerAddress,
    expiryHours,
  } = req.body;

  const login    = process.env.PTP_LOGIN;
  const secret   = process.env.PTP_SECRET;
  const endpoint = (process.env.PTP_ENDPOINT || '').trim();

  if (!login)    return res.status(500).json({ success: false, error: 'PTP_LOGIN is not set.' });
  if (!secret)   return res.status(500).json({ success: false, error: 'PTP_SECRET is not set.' });
  if (!endpoint) return res.status(500).json({ success: false, error: 'PTP_ENDPOINT is not set.' });
  if (!reference || !amount || !currency) {
    return res.status(400).json({ success: false, error: 'reference, amount and currency are required.' });
  }

  const returnUrl  = getReturnUrl(req);
  const hours      = parseInt(expiryHours, 10) || 24;
  const expiration = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const auth       = ptpAuth();

  const payload = {
    auth,
    payment: {
      reference:   String(reference),
      description: String(description || 'Payment'),
      amount: {
        currency: String(currency).toUpperCase(),
        total:    parseFloat(amount),
      },
    },
    expiration,
    returnUrl,
    ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1')
                 .split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || 'PayPortalBZ/1.0',
  };

  if (customerName || customerEmail || customerPhone) {
    payload.buyer = {};
    if (customerName)    payload.buyer.name   = customerName;
    if (customerEmail)   payload.buyer.email  = customerEmail;
    if (customerPhone)   payload.buyer.mobile = customerPhone;
    if (customerAddress) payload.buyer.address = { street: customerAddress };
  }

  // Log everything (mask secret)
  console.log('[PTP] ── create-session ──────────────────');
  console.log('[PTP] endpoint  :', endpoint);
  console.log('[PTP] login     :', login);
  console.log('[PTP] returnUrl :', returnUrl);
  console.log('[PTP] payload   :', JSON.stringify({
    ...payload,
    auth: { ...auth, tranKey: auth.tranKey.slice(0,8) + '...', nonce: auth.nonce.slice(0,8) + '...' }
  }, null, 2));

  try {
    const { status: httpStatus, body: data } = await postJSON(endpoint, payload);

    console.log('[PTP] ── response ───────────────────────');
    console.log('[PTP] HTTP status:', httpStatus);
    console.log('[PTP] body       :', JSON.stringify(data, null, 2));

    if (data.status && data.status.status === 'OK') {
      return res.json({ success: true, processUrl: data.processUrl, requestId: data.requestId });
    }

    // Return full bank response so we can see exactly what they say
    return res.status(400).json({
      success:  false,
      error:    (data.status && data.status.message) || 'Atlantic Bank rejected the request.',
      bankCode: (data.status && data.status.reason)  || null,
      raw:      data,
    });

  } catch (err) {
    console.error('[PTP] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Check session ── */
app.post('/api/check-session/:requestId', async (req, res) => {
  const endpoint = (process.env.PTP_ENDPOINT || '').trim();
  if (!endpoint) return res.status(500).json({ success: false, error: 'PTP_ENDPOINT not set.' });

  const url = endpoint.replace(/\/$/, '') + '/' + req.params.requestId;
  try {
    const { body: data } = await postJSON(url, { auth: ptpAuth() });
    const raw      = (data.status && data.status.status) || 'PENDING';
    const statusMap = { APPROVED: 'paid', PENDING: 'pending', REJECTED: 'rejected', FAILED: 'rejected' };
    return res.json({ success: true, status: statusMap[raw] || 'pending', raw: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('===========================================');
  console.log(' PayPortal backend on port', PORT);
  console.log(' PTP_LOGIN    :', process.env.PTP_LOGIN    ? 'SET ✓' : 'NOT SET ✗');
  console.log(' PTP_SECRET   :', process.env.PTP_SECRET   ? 'SET ✓' : 'NOT SET ✗');
  console.log(' PTP_ENDPOINT :', process.env.PTP_ENDPOINT || 'NOT SET ✗');
  console.log(' PTP_RETURN   :', process.env.PTP_RETURN_URL || '(auto-detect)');
  console.log('===========================================');
});
