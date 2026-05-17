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

/* ── PlaceToPay auth ── */
function ptpAuth() {
  const login     = process.env.PTP_LOGIN     || '';
  const secretKey = process.env.PTP_SECRET    || '';
  const rawNonce  = crypto.randomBytes(16).toString('hex');
  const seed      = new Date().toISOString();
  const tranKey   = crypto.createHash('sha256')
    .update(rawNonce + seed + secretKey)
    .digest('base64');
  const nonce = Buffer.from(rawNonce).toString('base64');
  return { login, tranKey, nonce, seed };
}

/* ── Simple fetch using Node built-ins (no external deps) ── */
function fetchJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const data    = Buffer.from(JSON.stringify(body));

    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
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
        catch(e) { reject(new Error('Bad JSON from PTP: ' + raw.slice(0, 300))); }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ── Health ── */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    ptpLogin:    !!process.env.PTP_LOGIN,
    ptpSecret:   !!process.env.PTP_SECRET,
    ptpEndpoint: process.env.PTP_ENDPOINT || '(not set)',
  });
});

/* ── Create PlaceToPay session ── */
app.post('/api/create-session', async (req, res) => {
  const { reference, description, amount, currency,
          customerName, customerEmail, customerPhone,
          customerAddress, expiryHours } = req.body;

  if (!reference || !description || !amount || !currency) {
    return res.status(400).json({ success: false, error: 'reference, description, amount and currency are required.' });
  }

  const login     = process.env.PTP_LOGIN;
  const secret    = process.env.PTP_SECRET;
  const endpoint  = process.env.PTP_ENDPOINT;
  const returnUrl = process.env.PTP_RETURN_URL || 'https://yourdomain.com/payment/return';

  if (!login || !secret) {
    return res.status(500).json({ success: false, error: 'PTP_LOGIN and PTP_SECRET are not configured. Add them in Coolify environment variables.' });
  }
  if (!endpoint) {
    return res.status(500).json({ success: false, error: 'PTP_ENDPOINT is not configured. Add it in Coolify environment variables.' });
  }

  const hours      = parseInt(expiryHours, 10) || 24;
  const expiration = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  const payload = {
    auth:    ptpAuth(),
    payment: {
      reference:   String(reference),
      description: String(description),
      amount: { currency: String(currency).toUpperCase(), total: parseFloat(amount) },
    },
    expiration,
    returnUrl,
    ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1').split(',')[0].trim(),
    userAgent: req.headers['user-agent'] || 'PayPortalBZ/1.0',
  };

  if (customerName || customerEmail || customerPhone) {
    payload.buyer = {};
    if (customerName)    payload.buyer.name   = customerName;
    if (customerEmail)   payload.buyer.email  = customerEmail;
    if (customerPhone)   payload.buyer.mobile = customerPhone;
    if (customerAddress) payload.buyer.address = { street: customerAddress };
  }

  console.log('[PTP] Creating session for', reference, amount, currency, endpoint);

  try {
    const { status: httpStatus, body: data } = await fetchJSON(endpoint, payload);
    console.log('[PTP] HTTP', httpStatus, JSON.stringify(data).slice(0, 400));

    if (data.status && data.status.status === 'OK') {
      return res.json({ success: true, processUrl: data.processUrl, requestId: data.requestId });
    }
    return res.status(400).json({
      success: false,
      error:   (data.status && data.status.message) || 'PlaceToPay rejected the request.',
      raw:     data,
    });
  } catch (err) {
    console.error('[PTP] Error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ── Check session status ── */
app.post('/api/check-session/:requestId', async (req, res) => {
  const endpoint = process.env.PTP_ENDPOINT;
  if (!endpoint) return res.status(500).json({ success: false, error: 'PTP_ENDPOINT not set.' });

  const url = endpoint.replace(/\/$/, '') + '/' + req.params.requestId;
  try {
    const { body: data } = await fetchJSON(url, { auth: ptpAuth() });
    const rawStatus  = (data.status && data.status.status) || 'PENDING';
    const statusMap  = { APPROVED: 'paid', PENDING: 'pending', REJECTED: 'rejected', FAILED: 'rejected' };
    return res.json({ success: true, status: statusMap[rawStatus] || 'pending', raw: data });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = 3000; // hardcoded — do not use process.env.PORT (Coolify sets that to the public port)
app.listen(PORT, '0.0.0.0', () => {
  console.log('===========================================');
  console.log('PayPortal backend running on port', PORT);
  console.log('PTP_LOGIN    :', process.env.PTP_LOGIN    ? 'SET' : 'NOT SET ⚠');
  console.log('PTP_SECRET   :', process.env.PTP_SECRET   ? 'SET' : 'NOT SET ⚠');
  console.log('PTP_ENDPOINT :', process.env.PTP_ENDPOINT || 'NOT SET ⚠');
  console.log('PTP_RETURN   :', process.env.PTP_RETURN_URL || 'NOT SET ⚠');
  console.log('===========================================');
});
