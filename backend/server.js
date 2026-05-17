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
   PlaceToPay auth
   tranKey = Base64( SHA-256( nonce + seed + secretKey ) )
───────────────────────────────────────────────────────── */
function ptpAuth() {
  const rawNonce = crypto.randomBytes(16).toString('hex');
  const seed     = new Date().toISOString();
  const tranKey  = crypto
    .createHash('sha256')
    .update(rawNonce + seed + (process.env.PTP_SECRET || ''))
    .digest('base64');
  return {
    login:    process.env.PTP_LOGIN || '',
    tranKey,
    nonce:    Buffer.from(rawNonce).toString('base64'),
    seed,
  };
}

/* ── Simple HTTPS POST, no external deps ── */
function postJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); }
    catch(e) { return reject(new Error('Invalid PTP_ENDPOINT URL: "' + urlStr + '" — check your Coolify environment variables.')); }

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
        catch(e) { reject(new Error('Non-JSON response from Atlantic Bank: ' + raw.slice(0, 300))); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ── Derive our own return URL ── */
function getReturnUrl(req) {
  // Use explicit env var if set, otherwise build from request host
  if (process.env.PTP_RETURN_URL && process.env.PTP_RETURN_URL && !process.env.PTP_RETURN_URL.includes('yourdomain.com')) {
    return process.env.PTP_RETURN_URL;
  }
  // Auto-detect: same host as the request, /payment/return path
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
    returnUrl:   process.env.PTP_RETURN_URL || '(auto-detect from request)',
  });
});

/* ── Create PlaceToPay session ── */
app.post('/api/create-session', async (req, res) => {
  const {
    reference, description, amount, currency,
    customerName, customerEmail, customerPhone, customerAddress,
    expiryHours,
  } = req.body;

  /* Validate inputs */
  if (!reference || !description || !amount || !currency) {
    return res.status(400).json({ success: false, error: 'reference, description, amount and currency are required.' });
  }

  /* Validate env vars */
  const login    = process.env.PTP_LOGIN;
  const secret   = process.env.PTP_SECRET;
  const endpoint = (process.env.PTP_ENDPOINT || '').trim();

  if (!login)    return res.status(500).json({ success: false, error: 'PTP_LOGIN is not set in Coolify environment variables.' });
  if (!secret)   return res.status(500).json({ success: false, error: 'PTP_SECRET is not set in Coolify environment variables.' });
  if (!endpoint) return res.status(500).json({ success: false, error: 'PTP_ENDPOINT is not set in Coolify environment variables.' });

  const returnUrl  = getReturnUrl(req);
  const hours      = parseInt(expiryHours, 10) || 24;
  const expiration = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  /* Build payload — mirrors exactly what WooCommerce PlaceToPay plugin sends */
  const payload = {
    auth: ptpAuth(),
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

  console.log('[PTP] POST', endpoint);
  console.log('[PTP] payload', JSON.stringify({ ...payload, auth: { ...payload.auth, tranKey: '***' } }));

  try {
    const { status: httpStatus, body: data } = await postJSON(endpoint, payload);
    console.log('[PTP] response', httpStatus, JSON.stringify(data));

    /* Atlantic Bank returns status.status === 'OK' and a processUrl on success */
    if (data.status && data.status.status === 'OK') {
      return res.json({
        success:    true,
        processUrl: data.processUrl,   // e.g. https://abgateway.atlabank.com/spa/session/174018/9455cf...
        requestId:  data.requestId,
      });
    }

    return res.status(400).json({
      success: false,
      error:   (data.status && data.status.message) || 'Atlantic Bank rejected the session request.',
      raw:     data,
    });

  } catch (err) {
    console.error('[PTP] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Check session status ── */
app.post('/api/check-session/:requestId', async (req, res) => {
  const endpoint = (process.env.PTP_ENDPOINT || '').trim();
  if (!endpoint) return res.status(500).json({ success: false, error: 'PTP_ENDPOINT not set.' });

  const url = endpoint.replace(/\/$/, '') + '/' + req.params.requestId;
  try {
    const { body: data } = await postJSON(url, { auth: ptpAuth() });
    const raw       = (data.status && data.status.status) || 'PENDING';
    const statusMap = { APPROVED: 'paid', PENDING: 'pending', REJECTED: 'rejected', FAILED: 'rejected' };
    return res.json({ success: true, status: statusMap[raw] || 'pending', raw: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = 3000; // hardcoded — Coolify sets PORT=6680 which conflicts with nginx
app.listen(PORT, '0.0.0.0', () => {
  console.log('===========================================');
  console.log(' PayPortal backend on port', PORT);
  console.log(' PTP_LOGIN    :', process.env.PTP_LOGIN    ? 'SET ✓' : 'NOT SET ✗');
  console.log(' PTP_SECRET   :', process.env.PTP_SECRET   ? 'SET ✓' : 'NOT SET ✗');
  console.log(' PTP_ENDPOINT :', process.env.PTP_ENDPOINT || 'NOT SET ✗');
  console.log(' PTP_RETURN   :', process.env.PTP_RETURN_URL || '(auto-detect)');
  console.log('===========================================');
});
