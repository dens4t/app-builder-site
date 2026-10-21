'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3570);
const HOST = process.env.HOST || '127.0.0.1';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'dens4t/webview-app-builder';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://builder.deni.ai.id').replace(/\/+$/, '');
const IP_SALT = process.env.IP_SALT || 'app-builder';
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 8);
const RATE_LIMIT = Number(process.env.RATE_LIMIT || 5);
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 20 * 60 * 1000);
const TICK_MS = 6000;

const DATA_DIR = path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const ICONS_DIR = path.join(DATA_DIR, 'icons');
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const ICON_MAX_BYTES = 700 * 1024;
const BODY_MAX_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ICONS_DIR, { recursive: true });

let jobs = loadJobs();
let ticking = false;

function loadJobs() {
  try {
    const raw = fs.readFileSync(JOBS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.jobs)) return parsed.jobs;
  } catch (_) {
  }
  return [];
}

function saveJobs() {
  const tmp = JOBS_FILE + '.tmp';
  const payload = JSON.stringify({ jobs }, null, 2);
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, JOBS_FILE);
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + ':' + ip).digest('hex').slice(0, 24);
}

function clientIp(req) {
  const forwarded = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 2048) return null;
  if (/[\r\n\t"<>]/.test(value)) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.toString();
}

function normalizeName(raw, url) {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 40);
  if (name) return name;
  try {
    return new URL(url).hostname.replace(/^www\./, '').slice(0, 40) || 'WebView App';
  } catch (_) {
    return 'WebView App';
  }
}

function newId() {
  return 'b' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
}

function slugify(raw) {
  const slug = String(raw || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'app';
}

function decodeIcon(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  let mime = match[1] === 'jpg' ? 'jpeg' : match[1];
  let buffer;
  try {
    buffer = Buffer.from(match[2], 'base64');
  } catch (_) {
    return null;
  }
  if (buffer.length < 16 || buffer.length > ICON_MAX_BYTES) return null;

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { buffer, ext: 'png', mime: 'image/png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { buffer, ext: 'jpg', mime: 'image/jpeg' };
  }
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { buffer, ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

function queueIndex(job) {
  if (job.status !== 'queued') return 0;
  const queued = jobs
    .filter(j => j.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt);
  const index = queued.findIndex(j => j.id === job.id);
  return index + 1;
}

function publicJob(job) {
  const isBuilding = jobs.some(j => j.status === 'building');
  const position = queueIndex(job);
  const etaSeconds = job.status === 'queued'
    ? Math.max(30, (position - 1) * 180 + (isBuilding ? 180 : 30))
    : job.status === 'building' ? 180 : 0;
  return {
    id: job.id,
    name: job.name,
    url: job.url,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    apkUrl: job.apkUrl || null,
    runUrl: job.runUrl || null,
    iconUrl: job.iconUrl || null,
    error: job.error || null,
    position,
    etaSeconds
  };
}

async function github(pathname, options = {}) {
  const response = await fetch('https://api.github.com' + pathname, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + GITHUB_TOKEN,
      'User-Agent': 'webview-app-builder',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = text;
    }
  }
  return { ok: response.ok, status: response.status, body };
}

async function dispatch(job) {
  const result = await github(`/repos/${GITHUB_REPO}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({
      event_type: 'build_webview',
      client_payload: {
        job_id: job.id,
        url: job.url,
        name: job.name,
        slug: job.slug || slugify(job.name),
        icon_url: job.iconUrl || ''
      }
    })
  });

  if (result.ok) {
    job.status = 'building';
    job.startedAt = Date.now();
    job.attempts = (job.attempts || 0) + 1;
    job.error = null;
    saveJobs();
    console.log('dispatched', job.id);
    return;
  }

  job.attempts = (job.attempts || 0) + 1;
  const message = result.body && result.body.message ? result.body.message : `HTTP ${result.status}`;
  if (job.attempts >= 3) {
    job.status = 'failed';
    job.error = 'Gagal mengirim build ke GitHub: ' + message;
    job.finishedAt = Date.now();
    console.log('dispatch failed', job.id, message);
  } else {
    job.error = 'Menunggu pengiriman ulang: ' + message;
    console.log('dispatch retry', job.id, message);
  }
  saveJobs();
}

async function findRun(job) {
  if (job.runId) {
    const run = await github(`/repos/${GITHUB_REPO}/actions/runs/${job.runId}`);
    if (run.ok && run.body) return run.body;
  }
  const list = await github(`/repos/${GITHUB_REPO}/actions/runs?event=repository_dispatch&per_page=50`);
  if (!list.ok || !list.body || !Array.isArray(list.body.workflow_runs)) return null;
  const expected = 'build-' + job.id;
  return list.body.workflow_runs.find(run =>
    run.display_title === expected || run.name === expected
  ) || null;
}

async function refreshJob(job) {
  const run = await findRun(job);
  if (run) {
    job.runId = run.id;
    job.runUrl = run.html_url || job.runUrl;
  }

  if (run && run.status === 'completed') {
    if (run.conclusion === 'success') {
      const release = await github(`/repos/${GITHUB_REPO}/releases/tags/build-${job.id}`);
      const assets = release.ok && release.body && Array.isArray(release.body.assets)
        ? release.body.assets
        : [];
      const apk = assets.find(asset => typeof asset.name === 'string' && asset.name.endsWith('.apk'));
      if (apk) {
        job.status = 'done';
        job.apkUrl = apk.browser_download_url;
        job.finishedAt = Date.now();
        job.error = null;
        saveJobs();
        console.log('done', job.id);
        return;
      }
      job.error = 'Build selesai tetapi APK belum tersedia. Mencoba lagi...';
    } else {
      job.status = 'failed';
      job.error = 'Build gagal: ' + (run.conclusion || 'unknown');
      job.finishedAt = Date.now();
      saveJobs();
      console.log('failed', job.id, run.conclusion);
      return;
    }
  }

  if (job.status === 'building' && Date.now() - job.startedAt > BUILD_TIMEOUT_MS) {
    job.status = 'failed';
    job.error = 'Build melebihi batas waktu 20 menit.';
    job.finishedAt = Date.now();
    saveJobs();
    console.log('timeout', job.id);
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const building = jobs.filter(job => job.status === 'building');
    for (const job of building) {
      await refreshJob(job);
    }

    if (!jobs.some(job => job.status === 'building')) {
      const next = jobs
        .filter(job => job.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (next) await dispatch(next);
    }
  } catch (error) {
    console.error('tick error', error.message);
  } finally {
    ticking = false;
  }
}

function json(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_MAX_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname) {
  const iconMatch = pathname.match(/^\/api\/icons\/([a-z0-9]+\.(?:png|jpg|webp))$/);
  if (req.method === 'GET' && iconMatch) {
    const fileName = iconMatch[1];
    const filePath = path.join(ICONS_DIR, fileName);
    try {
      const data = fs.readFileSync(filePath);
      const mime = fileName.endsWith('.png')
        ? 'image/png'
        : fileName.endsWith('.jpg') ? 'image/jpeg' : 'image/webp';
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': data.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(data);
    } catch (_) {
      return json(res, 404, { error: 'Ikon tidak ditemukan.' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      building: jobs.some(job => job.status === 'building'),
      queued: jobs.filter(job => job.status === 'queued').length
    });
  }

  if (req.method === 'GET' && pathname === '/api/jobs') {
    const recent = jobs
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 12)
      .map(job => ({
        id: job.id,
        name: job.name,
        url: job.url,
        status: job.status,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt || null,
        apkUrl: job.apkUrl || null,
        iconUrl: job.iconUrl || null
      }));
    return json(res, 200, { jobs: recent });
  }

  const match = pathname.match(/^\/api\/jobs\/([a-z0-9]+)$/);
  if (req.method === 'GET' && match) {
    const job = jobs.find(item => item.id === match[1]);
    if (!job) return json(res, 404, { error: 'Job tidak ditemukan.' });
    return json(res, 200, { job: publicJob(job) });
  }

  if (req.method === 'POST' && pathname === '/api/jobs') {
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return json(res, 400, { error: error.message === 'body too large' ? 'Payload terlalu besar.' : 'JSON tidak valid.' });
    }

    const url = normalizeUrl(body.url);
    if (!url) return json(res, 400, { error: 'URL tidak valid. Gunakan http:// atau https://.' });
    const name = normalizeName(body.name, url);

    let icon = null;
    if (body.icon) {
      icon = decodeIcon(body.icon);
      if (!icon) {
        return json(res, 400, { error: 'Ikon tidak valid. Gunakan PNG, JPG, atau WebP maksimal 700 KB.' });
      }
    }

    const ipHash = hashIp(clientIp(req));
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recentCount = jobs.filter(job => job.ipHash === ipHash && job.createdAt > hourAgo).length;
    if (recentCount >= RATE_LIMIT) {
      return json(res, 429, { error: `Batas ${RATE_LIMIT} build per jam tercapai. Coba lagi nanti.` });
    }

    const pending = jobs.filter(job => job.status === 'queued' || job.status === 'building').length;
    if (pending >= MAX_QUEUE) {
      return json(res, 429, { error: `Antrian penuh (${MAX_QUEUE}). Coba lagi beberapa menit lagi.` });
    }

    const id = newId();
    const job = {
      id,
      url,
      name,
      slug: slugify(name),
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      apkUrl: null,
      runUrl: null,
      runId: null,
      iconUrl: null,
      error: null,
      attempts: 0,
      ipHash
    };

    if (icon) {
      const fileName = `${id}.${icon.ext}`;
      fs.writeFileSync(path.join(ICONS_DIR, fileName), icon.buffer, { mode: 0o644 });
      job.iconUrl = `${PUBLIC_BASE_URL}/api/icons/${fileName}`;
    }

    jobs.push(job);
    saveJobs();
    console.log('queued', job.id, url);
    setImmediate(tick);
    return json(res, 201, { job: publicJob(job) });
  }

  return json(res, 405, { error: 'Method not allowed.' });
}

let indexCache = null;

function serveIndex(res) {
  try {
    if (!indexCache) indexCache = fs.readFileSync(INDEX_FILE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Frame-Options': 'DENY'
    });
    res.end(indexCache);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      return await handleApi(req, res, pathname);
    }
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveIndex(res);
    }
    if (req.method === 'GET' && pathname === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (error) {
    console.error('request error', error);
    if (!res.headersSent) {
      json(res, 500, { error: 'Internal server error.' });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`app-builder listening on http://${HOST}:${PORT}`);
  tick();
  setInterval(tick, TICK_MS);
});

process.on('SIGTERM', () => {
  saveJobs();
  server.close(() => process.exit(0));
});
