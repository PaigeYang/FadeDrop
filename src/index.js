const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use('/media', express.static(path.join(__dirname, '..', 'uploads')));

const uploadRoot = path.join(__dirname, '..', 'uploads');
const mediaDirs = {
  images: path.join(uploadRoot, 'images'),
  video: path.join(uploadRoot, 'videos'),
  audio: path.join(uploadRoot, 'audio'),
};

Object.values(mediaDirs).forEach((dir) => {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error('Failed to ensure upload directory:', dir, err);
  }
});

app.post('/dashboard/:id/views', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?viewError=notfound');
  }

  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard view limit change attempt', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    return res.status(401).send('Unauthorized');
  }

  const mode = (req.body && req.body.mode) || 'set';

  if (mode === 'remove') {
    record.maxViews = null;
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&viewMessage=removed');
  }

  const raw = (req.body && req.body.maxViews) || '';
  const trimmed = raw.trim();
  const value = Number.parseInt(trimmed, 10);

  if (!trimmed || Number.isNaN(value) || value <= 0 || value > 100000) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&viewError=invalid');
  }

  record.maxViews = value;

  return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&viewMessage=updated');
});

app.post('/dashboard/:id/expiration', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?expError=notfound');
  }

  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard expiration change attempt', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    return res.status(401).send('Unauthorized');
  }

   if (record.deleted) {
     return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&expError=deleted');
   }

  const rawExtend = (req.body && req.body.extendBy) || '';
  const trimmedExtend = rawExtend.trim();
  const extendByMs = Number.parseInt(trimmedExtend, 10);

  const allowedIncrements = new Set([
    1 * 60 * 60 * 1000, // +1 hour
    2 * 60 * 60 * 1000, // +2 hours
    6 * 60 * 60 * 1000, // +6 hours
    12 * 60 * 60 * 1000, // +12 hours
    24 * 60 * 60 * 1000, // +1 day
    3 * 24 * 60 * 60 * 1000, // +3 days
    7 * 24 * 60 * 60 * 1000, // +7 days
    30 * 24 * 60 * 60 * 1000, // +30 days
  ]);

  if (!trimmedExtend || Number.isNaN(extendByMs) || !allowedIncrements.has(extendByMs)) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&expError=invalid');
  }

  const now = Date.now();
  const currentExpiresMs = Date.parse(record.expiration?.expiresAt || record.createdAt || new Date().toISOString());
  const base = Number.isFinite(currentExpiresMs) ? Math.max(currentExpiresMs, now) : now;
  const newExpiresMs = base + extendByMs;
  const maxFutureMs = now + 30 * 24 * 60 * 60 * 1000;

  if (newExpiresMs > maxFutureMs) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&expError=tooFar');
  }

  const createdAtMs = Date.parse(record.createdAt || new Date().toISOString());

  record.expiration = record.expiration || {};
  record.expiration.expiresAt = new Date(newExpiresMs).toISOString();
  record.expiration.autoDeleteAt = new Date(newExpiresMs + AUTO_DELETE_GRACE_PERIOD_MS).toISOString();
  if (Number.isFinite(createdAtMs)) {
    record.expiration.durationMs = newExpiresMs - createdAtMs;
  }

  // Clear legacy flags so an upload can be reactivated after extension.
  record.expired = false;
  record.deleted = false;

  return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&expMessage=extended');
});

app.post('/dashboard/:id/countdown', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?cdError=notfound');
  }

  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard countdown setting change attempt', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    return res.status(401).send('Unauthorized');
  }

  const mode = (req.body && req.body.countdownMode) || '';
  const trimmed = mode.trim();

  if (trimmed === 'show') {
    record.countdownVisible = true;
  } else if (trimmed === 'hide') {
    record.countdownVisible = false;
  } else {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&cdError=invalid');
  }

  return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&cdMessage=updated');
});

app.post('/dashboard/:id/delete', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?delError=notfound');
  }

  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard delete attempt', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    return res.status(401).send('Unauthorized');
  }

  if (record.deleted) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&delMessage=alreadyDeleted');
  }

  try {
    console.log('Deleting upload at uploader request', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    deleteStoredFiles(record.files || []);
  } catch (err) {
    console.error('Error deleting files for uploader-initiated delete:', err);
  }

  record.deleted = true;
  record.deletedAt = new Date().toISOString();
  record.deletedReason = 'manual';

  // Once deleted, password and view limits are irrelevant.
  record.password = null;
  record.passwordVersion = null;
  record.maxViews = null;

  return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&delMessage=deleted');
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let targetDir = uploadRoot;
    if (file.fieldname === 'images') {
      targetDir = mediaDirs.images;
    } else if (file.fieldname === 'video') {
      targetDir = mediaDirs.video;
    } else if (file.fieldname === 'audio') {
      targetDir = mediaDirs.audio;
    }
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const id = crypto.randomBytes(12).toString('hex');
    cb(null, `${Date.now()}-${id}${ext}`);
  },
});

const upload = multer({
  storage,
});

const uploadsStore = [];

// 24-hour grace period after expiration before automatic deletion.
const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

 const AUTO_DELETE_GRACE_PERIOD_MS = (() => {
   const raw = process.env.FADEDROP_GRACE_PERIOD_MS_OVERRIDE;
   if (!raw) return GRACE_PERIOD_MS;
   const parsed = Number.parseInt(raw, 10);
   return Number.isFinite(parsed) && parsed >= 0 ? parsed : GRACE_PERIOD_MS;
 })();

 function getExpiresAtMs(record) {
   if (!record) return NaN;
   return Date.parse(record.expiration?.expiresAt || record.createdAt || '');
 }

 function getAutoDeleteAtMs(record) {
   if (!record) return NaN;
   const direct = Date.parse(record.expiration?.autoDeleteAt || '');
   if (Number.isFinite(direct)) return direct;
   const expiresAtMs = getExpiresAtMs(record);
   if (!Number.isFinite(expiresAtMs)) return NaN;
   return expiresAtMs + AUTO_DELETE_GRACE_PERIOD_MS;
 }

 function autoDeleteUploadIfNeeded(record) {
   if (!record) return false;
   if (record.deleted) return false;
 
   const now = Date.now();
   const autoDeleteAtMs = getAutoDeleteAtMs(record);
   if (!Number.isFinite(autoDeleteAtMs) || now < autoDeleteAtMs) return false;

   try {
     console.log('Auto-deleting expired upload', {
       uploadId: record.id,
       at: new Date(now).toISOString(),
     });
     deleteStoredFiles(record.files || []);
   } catch (err) {
     console.error('Error auto-deleting expired upload:', err);
   }

   record.deleted = true;
   record.deletedReason = 'auto';
   record.deletedAt = new Date(now).toISOString();

   record.password = null;
   record.passwordVersion = null;
   record.maxViews = null;

   return true;
 }

function parseCookies(req) {
  const header = (req && req.headers && req.headers.cookie) || '';
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!key) return acc;
    try {
      acc[key] = decodeURIComponent(raw);
    } catch {
      acc[key] = raw;
    }
    return acc;
  }, {});
}

function getViewCookieName(id) {
  return `fadedrop_view_${id}`;
}

function setViewAuthCookie(res, record) {
  if (!res || !record || !record.id || !record.passwordVersion) return;

  const cookieName = getViewCookieName(record.id);
  const cookieValue = encodeURIComponent(record.passwordVersion);

  let maxAgeSeconds = 6 * 60 * 60;
  const autoDeleteAtMs = Date.parse(record.expiration?.autoDeleteAt || record.expiration?.expiresAt || '');
  if (Number.isFinite(autoDeleteAtMs)) {
    const diffSeconds = Math.floor((autoDeleteAtMs - Date.now()) / 1000);
    if (diffSeconds > 60) maxAgeSeconds = diffSeconds;
  }

  const parts = [
    `${cookieName}=${cookieValue}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  res.setHeader('Set-Cookie', parts.join('; '));
}

// Dev/test: always enable the 1-minute expiration shortcut.
// If you want to hide this in production, change this to read from process.env instead.
const ONE_MINUTE_EXPIRATION_ENABLED = true;

function getWarmCss() {
  return `
    :root {
      --bg-1: #fbf6ee;
      --bg-2: #f4ede1;
      --card: #fffaf2;
      --border: rgba(60, 45, 30, 0.12);
      --text: #2a2116;
      --muted: rgba(42, 33, 22, 0.68);
      --muted-2: rgba(42, 33, 22, 0.55);
      --shadow: 0 18px 48px -30px rgba(42, 33, 22, 0.55);
      --shadow-soft: 0 10px 30px -24px rgba(42, 33, 22, 0.4);
      --radius-lg: 26px;
      --radius-md: 18px;
      --accent: #2f6b4f;
      --accent-bg: rgba(47, 107, 79, 0.12);
      --accent-border: rgba(47, 107, 79, 0.18);
    }
    * { box-sizing: border-box; }
    img, video, audio, canvas, svg { max-width: 100%; }
    html, body { height: 100%; }
    body {
      margin: 0;
      padding: 2.5rem 1.5rem 3.5rem;
      color: var(--text);
      background: radial-gradient(1200px 700px at 20% 0%, rgba(255, 255, 255, 0.9), transparent 60%),
        radial-gradient(1000px 600px at 90% 10%, rgba(255, 245, 225, 0.9), transparent 55%),
        linear-gradient(180deg, var(--bg-1), var(--bg-2));
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 16px;
      line-height: 1.5;
      overflow-x: hidden;
    }
    .page { max-width: 980px; margin: 0 auto; width: 100%; }
    .top-header { margin-bottom: 1.5rem; }
    .status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.65rem; border-radius: 999px; background: var(--accent-bg); border: 1px solid var(--accent-border); color: var(--accent); font-size: 0.8rem; }
    .status-dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 3px rgba(47, 107, 79, 0.12); }
    .brand { margin-top: 0.75rem; font-family: ui-serif, Georgia, 'Times New Roman', Times, serif; font-weight: 650; letter-spacing: 0.01em; font-size: 1.15rem; }
    .tagline { margin: 0.25rem 0 0.9rem; color: var(--muted); font-size: 0.95rem; }
    h1 { margin: 0; font-family: ui-serif, Georgia, 'Times New Roman', Times, serif; font-weight: 650; font-size: clamp(1.55rem, 4.8vw, 2rem); letter-spacing: 0.01em; line-height: 1.15; }
    h2 { margin: 0 0 0.35rem; font-size: 0.95rem; font-weight: 650; }
    p { margin: 0.25rem 0; color: var(--muted); }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .subtitle { margin: 0.45rem 0 0; color: var(--muted); font-size: 1rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 1.25rem;
      max-width: 100%;
    }
    .card-narrow { max-width: 720px; margin: 0 auto; }
    .hint { margin: 0; color: var(--muted); font-size: 0.85rem; }
    .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.75rem 1.25rem;
      border-radius: 999px;
      border: 1px solid rgba(47, 107, 79, 0.25);
      background: var(--accent);
      color: #fffaf2;
      font-weight: 650;
      font-size: 0.95rem;
      min-height: 44px;
      cursor: pointer;
      text-decoration: none;
      box-shadow: 0 14px 30px -24px rgba(47, 107, 79, 0.8);
    }
    .btn-primary:hover { filter: brightness(1.02); text-decoration: none; }
    .btn-secondary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.6rem 1.1rem;
      border-radius: 999px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      color: var(--text);
      background: rgba(255, 255, 255, 0.6);
      text-decoration: none;
      font-size: 0.9rem;
      min-height: 44px;
      cursor: pointer;
    }
    .btn-secondary:hover { background: rgba(255, 255, 255, 0.8); text-decoration: none; }
    .input, select {
      width: 100%;
      padding: 0.5rem 0.6rem;
      border-radius: 14px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      background: rgba(255, 255, 255, 0.85);
      color: var(--text);
      font-size: 1rem;
      min-height: 44px;
    }
    .layout { display: grid; gap: 1rem; margin-top: 1rem; }
    @media (min-width: 900px) {
      .layout { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
    }
    .section { padding: 0.9rem 0.9rem 1rem; border-radius: var(--radius-md); border: 1px solid rgba(60, 45, 30, 0.12); background: rgba(255, 255, 255, 0.55); }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
    th, td { padding: 0.4rem 0.45rem; text-align: left; border-bottom: 1px solid rgba(60, 45, 30, 0.12); }
    th { color: var(--muted); font-weight: 650; }
    tbody tr:last-child td { border-bottom: none; }
    .pill { display: inline-flex; align-items: center; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid rgba(60, 45, 30, 0.14); color: var(--text); background: rgba(255, 255, 255, 0.65); }
    .status-pill { display: inline-flex; align-items: center; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid rgba(60, 45, 30, 0.14); }
    .status-valid { background: rgba(47, 107, 79, 0.12); border-color: rgba(47, 107, 79, 0.22); color: var(--accent); }
    .status-expired { background: rgba(134, 57, 57, 0.08); border-color: rgba(134, 57, 57, 0.22); color: rgba(134, 57, 57, 0.92); }
    .status-deleted { background: rgba(60, 45, 30, 0.06); border-color: rgba(60, 45, 30, 0.14); color: var(--muted); }
    .actions { margin-top: 1.25rem; display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: flex-end; }
    .back-link { margin-top: 1.25rem; font-size: 0.85rem; }
    .error { color: rgba(134, 57, 57, 0.92); }
    .ok { color: var(--accent); }

    @media (max-width: 768px) {
      body { padding: 1.5rem 1.5rem 2.25rem; }
      .actions { justify-content: stretch; }
    }

    @media (max-width: 480px) {
      body { padding: 1rem 1rem 2rem; }
      .card { padding: 1rem; }
      .actions { flex-direction: column; align-items: stretch; }
      .actions .btn-primary, .actions .btn-secondary { width: 100%; }
      table { display: block; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      th, td { white-space: nowrap; }
    }
  `;
}

function deleteStoredFiles(filesMeta) {
  (filesMeta || []).forEach((file) => {
    if (!file.storedPath) return;
    fs.unlink(file.storedPath, (err) => {
      if (err && err.code !== 'ENOENT') {
        console.error('Failed to remove stored file after validation error:', file.storedPath, err);
      }
    });
  });
}

function sendValidationError(res, title, message) {
  return res.status(400).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title} • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>${title}</h1>
      <p class="error">${message}</p>
      <div class="actions">
        <a href="/" class="btn-secondary">Back to upload</a>
      </div>
    </main>
  </div>
</body>
</html>`);
}

function sendNotFoundPage(res) {
  return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Not found • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>Page not found</h1>
      <p>The page you’re looking for doesn’t exist.</p>
      <div class="actions">
        <a href="/" class="btn-primary">Go to upload</a>
      </div>
    </main>
  </div>
</body>
</html>`);
}

function getStatusPageHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="status"><span class="status-dot"></span><span>Service is running</span></div>
      <div class="brand">FadeDrop</div>
      <p class="tagline">Temporary media links for images, video, and audio.</p>
      <h1>Service status</h1>
      <p class="subtitle">Everything looks good. You can create a new upload any time.</p>
    </header>

    <main class="card card-narrow">
      <h2>Current status</h2>
      <p class="hint">FadeDrop is online and ready to accept uploads.</p>
      <div class="actions">
        <a class="btn-primary" href="/">Create a link</a>
      </div>
    </main>
  </div>
</body>
</html>`;
}

function getUploadPageHtml(options = {}) {
  const showStatusBadge = options.showStatusBadge === true;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload • FadeDrop</title>
  <style>
    :root {
      --bg-1: #fbf6ee;
      --bg-2: #f4ede1;
      --card: #fffaf2;
      --border: rgba(60, 45, 30, 0.12);
      --text: #2a2116;
      --muted: rgba(42, 33, 22, 0.68);
      --muted-2: rgba(42, 33, 22, 0.55);
      --shadow: 0 18px 48px -30px rgba(42, 33, 22, 0.55);
      --shadow-soft: 0 10px 30px -24px rgba(42, 33, 22, 0.4);
      --radius-lg: 26px;
      --radius-md: 18px;
      --accent: #2f6b4f;
      --accent-bg: rgba(47, 107, 79, 0.12);
      --accent-border: rgba(47, 107, 79, 0.18);
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      padding: 2.5rem 1.25rem 3.5rem;
      color: var(--text);
      background: radial-gradient(1200px 700px at 20% 0%, rgba(255, 255, 255, 0.9), transparent 60%),
        radial-gradient(1000px 600px at 90% 10%, rgba(255, 245, 225, 0.9), transparent 55%),
        linear-gradient(180deg, var(--bg-1), var(--bg-2));
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .page { max-width: 980px; margin: 0 auto; }
    .top-header { margin-bottom: 2.25rem; }
    .status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.65rem; border-radius: 999px; background: var(--accent-bg); border: 1px solid var(--accent-border); color: var(--accent); font-size: 0.8rem; }
    .status-dot { width: 0.45rem; height: 0.45rem; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 3px rgba(47, 107, 79, 0.12); }
    .brand { margin-top: 0.75rem; font-family: ui-serif, Georgia, 'Times New Roman', Times, serif; font-weight: 650; letter-spacing: 0.01em; font-size: 1.15rem; }
    .tagline { margin: 0.25rem 0 0.9rem; color: var(--muted); font-size: 0.95rem; }
    .headline {
      margin: 0;
      font-family: ui-serif, Georgia, 'Times New Roman', Times, serif;
      font-weight: 650;
      font-size: clamp(2.15rem, 4.6vw, 2.7rem);
      letter-spacing: 0.01em;
      line-height: 1.06;
      max-width: none;
    }
    .headline .headline-main { display: block; }
    .headline .headline-sub {
      display: block;
      margin-top: 0.08em;
      font-size: 0.86em;
      font-weight: 600;
      color: rgba(42, 33, 22, 0.78);
    }
    .subtitle { margin: 0.75rem 0 0; color: var(--muted); font-size: 1.08rem; max-width: 56ch; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow);
      padding: 1.25rem;
      transition: transform 180ms ease, box-shadow 180ms ease;
    }
    .card:hover { transform: translateY(-1px); box-shadow: 0 22px 60px -34px rgba(42, 33, 22, 0.6); }
    .form-grid { display: grid; gap: 1rem; }
    @media (min-width: 900px) {
      .form-grid { grid-template-columns: 1.3fr 0.7fr; align-items: start; }
    }
    .section { padding: 0.25rem 0.25rem 0.5rem; }
    .section-primary .section-title { font-size: 1.05rem; }
    .section-secondary .section-title { font-size: 0.92rem; color: rgba(42, 33, 22, 0.85); }
    .section-secondary .hint { color: rgba(42, 33, 22, 0.6); }
    .section-title { font-size: 0.95rem; font-weight: 650; margin: 0 0 0.35rem; }
    .hint { margin: 0; color: var(--muted); font-size: 0.85rem; }
    .divider { height: 1px; background: rgba(60, 45, 30, 0.08); margin: 0.85rem 0; }

    .dropzone {
      margin-top: 0.65rem;
      border-radius: var(--radius-md);
      border: 2px dashed rgba(60, 45, 30, 0.26);
      background: rgba(255, 255, 255, 0.7);
      padding: 1.1rem;
      display: grid;
      gap: 0.45rem;
      cursor: pointer;
      transition: background 180ms ease, border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
      box-shadow: 0 10px 22px -20px rgba(42, 33, 22, 0.35);
    }
    .dropzone:hover { background: rgba(255, 255, 255, 0.85); border-color: rgba(60, 45, 30, 0.32); transform: translateY(-1px); }
    .dropzone.is-dragover { background: rgba(47, 107, 79, 0.1); border-color: rgba(47, 107, 79, 0.42); box-shadow: 0 18px 40px -30px rgba(47, 107, 79, 0.8); }
    .dz-primary { font-weight: 650; font-size: 1rem; }
    .dz-secondary { color: var(--muted); font-size: 0.85rem; }
    .dz-rules { color: var(--muted-2); font-size: 0.8rem; }

    input[type="file"] { display: none; }

    .file-chips { list-style: none; padding: 0; margin: 0.75rem 0 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .file-chip { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.55rem; border-radius: 999px; border: 1px solid rgba(60, 45, 30, 0.14); background: rgba(255, 255, 255, 0.75); box-shadow: var(--shadow-soft); max-width: 100%; }
    .file-chip .name { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-chip .meta { color: var(--muted-2); font-size: 0.8rem; }
    .file-chip button { border: none; background: transparent; cursor: pointer; color: rgba(134, 57, 57, 0.9); font-size: 0.95rem; line-height: 1; padding: 0.15rem 0.25rem; border-radius: 8px; }
    .file-chip button:hover { background: rgba(134, 57, 57, 0.1); }
    .warning { margin: 0.6rem 0 0; color: rgba(134, 57, 57, 0.92); font-size: 0.85rem; }

    .segmented { margin-top: 0.65rem; display: inline-flex; border-radius: 999px; border: 1px solid rgba(60, 45, 30, 0.16); background: rgba(255, 255, 255, 0.7); overflow: hidden; }
    .segmented label { position: relative; }
    .segmented input { position: absolute; opacity: 0; inset: 0; }
    .segment { padding: 0.45rem 0.75rem; font-size: 0.85rem; color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; }
    .segmented input:checked + .segment { background: rgba(47, 107, 79, 0.12); color: var(--accent); }

    .chips { margin-top: 0.65rem; display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .chip { border-radius: 999px; border: 1px solid rgba(60, 45, 30, 0.16); background: rgba(255, 255, 255, 0.7); padding: 0.35rem 0.65rem; cursor: pointer; font-size: 0.85rem; color: var(--muted); transition: background 180ms ease, border-color 180ms ease; }
    .chip[aria-pressed="true"] { background: rgba(47, 107, 79, 0.12); border-color: rgba(47, 107, 79, 0.22); color: var(--accent); }
    .chip:hover { background: rgba(255, 255, 255, 0.85); }

    .custom-exp { margin-top: 0.75rem; display: none; gap: 0.6rem; align-items: center; }
    .custom-exp.is-open { display: flex; }
    .custom-exp input, .custom-exp select {
      padding: 0.45rem 0.55rem;
      border-radius: 14px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      background: rgba(255, 255, 255, 0.85);
      color: var(--text);
      font-size: 0.9rem;
    }
    .timing { margin-top: 0.75rem; font-size: 0.85rem; color: var(--muted); display: grid; gap: 0.25rem; }
    .timing strong { color: var(--text); font-weight: 650; }

    details.advanced { margin-top: 0.75rem; border-radius: var(--radius-md); border: 1px solid rgba(60, 45, 30, 0.12); background: rgba(255, 255, 255, 0.65); padding: 0.75rem 0.85rem; }
    details.advanced summary { cursor: pointer; font-weight: 650; color: var(--text); }
    details.advanced summary::marker { color: var(--muted); }
    .adv-inner { margin-top: 0.75rem; display: grid; gap: 0.65rem; }
    .input { width: 100%; padding: 0.5rem 0.6rem; border-radius: 14px; border: 1px solid rgba(60, 45, 30, 0.18); background: rgba(255, 255, 255, 0.85); color: var(--text); font-size: 0.95rem; }
    .label { font-size: 0.85rem; font-weight: 650; }
    .helper { font-size: 0.82rem; color: var(--muted); }

    .cta-bar { margin-top: 1.15rem; padding-top: 1.15rem; border-top: 1px solid rgba(60, 45, 30, 0.1); display: flex; gap: 1rem; align-items: flex-start; justify-content: flex-end; flex-wrap: wrap; }
    .cta-right { display: grid; gap: 0.35rem; justify-items: end; }
    .btn-primary { padding: 0.9rem 1.55rem; border-radius: 999px; border: 1px solid rgba(47, 107, 79, 0.25); background: var(--accent); color: #fffaf2; font-weight: 650; font-size: 1.02rem; cursor: pointer; box-shadow: 0 18px 38px -30px rgba(47, 107, 79, 0.95); }
    .btn-primary:hover { filter: brightness(1.03); }
    .btn-primary:focus-visible { outline: 3px solid rgba(47, 107, 79, 0.25); outline-offset: 2px; }
    .reassure { font-size: 0.82rem; color: var(--muted); text-align: right; max-width: 360px; }
    .trust { margin-top: 0.15rem; font-size: 0.82rem; color: rgba(42, 33, 22, 0.62); text-align: right; }

    @media (max-width: 768px) {
      body { padding: 1.75rem 1.5rem 2.75rem; }
      .headline { font-size: clamp(1.95rem, 6.6vw, 2.35rem); line-height: 1.08; max-width: 34ch; }
      .headline .headline-sub { font-size: 0.88em; }
      .top-header { margin-bottom: 1.6rem; }
      .form-grid { grid-template-columns: 1fr; }
      .section[style*="grid-column"] { grid-column: auto !important; }
      .cta-bar { justify-content: stretch; }
      .cta-right { width: 100%; justify-items: stretch; }
      .cta-right .btn-primary { width: 100%; }
      .reassure, .trust { text-align: left; max-width: none; }
      .custom-exp { flex-wrap: wrap; }
      .segmented { width: 100%; }
      .segment { flex: 1 1 auto; justify-content: center; }
    }

    @media (max-width: 480px) {
      body { padding: 1rem 1rem 2.25rem; }
      .headline { font-size: clamp(1.7rem, 8vw, 2.1rem); line-height: 1.12; max-width: 19ch; }
      .headline .headline-sub { margin-top: 0.12em; font-size: 0.9em; }
      .card { padding: 1rem; }
      .dropzone { padding: 1rem; }
      .chip { padding: 0.55rem 0.8rem; min-height: 44px; }
      .segment { min-height: 44px; }
      .file-chip .name { max-width: 180px; }
    }

    @media (max-width: 420px) {
      .headline { max-width: 18ch; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      ${
        showStatusBadge
          ? '<div class="status"><span class="status-dot"></span><span>Service is running</span></div>'
          : ''
      }
      <div class="brand">FadeDrop</div>
      <h1 class="headline">Create links that disappear automatically</h1>
      <p class="subtitle">Temporary links for images, video, and audio — automatically deleted.</p>
    </header>

    <form action="/upload" method="post" enctype="multipart/form-data">
      <section class="card" aria-label="Upload form">
        <div class="form-grid">
          <div class="section section-primary" style="grid-column:1;">
            <h2 class="section-title">Files</h2>
            <p class="hint">Start here. We’ll auto-detect media type from your files.</p>

            <div id="dropzone" class="dropzone" role="button" tabindex="0" aria-label="File dropzone">
              <div class="dz-primary">Drop files to create a temporary link</div>
              <div class="dz-secondary">or choose files</div>
              <div class="dz-rules" id="file-rules">Images: up to 10 • Video: 1 • Audio: up to 2</div>
            </div>

            <input type="file" id="files-input" accept="image/*,video/*,audio/*" multiple />
            <input type="file" id="images-hidden" name="images" accept="image/*" multiple style="display:none;" />
            <input type="file" id="video-hidden" name="video" accept="video/*" style="display:none;" />
            <input type="file" id="audio-hidden" name="audio" accept="audio/*" multiple style="display:none;" />

            <ul class="file-chips" id="files-list"></ul>
            <p class="warning" id="files-warning" style="display:none;"></p>
          </div>

          <div class="section section-secondary" style="grid-column:2;">
            <h2 class="section-title">Expiration</h2>
            <p class="hint">Default is 1 day. Files auto-delete after a 24-hour grace period.</p>

            <div class="chips" id="expiration-chips">
              <button type="button" class="chip" data-preset="1d" aria-pressed="true">1 day</button>
              <button type="button" class="chip" data-preset="3d" aria-pressed="false">3 days</button>
              <button type="button" class="chip" data-preset="7d" aria-pressed="false">7 days</button>
              <button type="button" class="chip" data-preset="30d" aria-pressed="false">30 days</button>
              <button type="button" class="chip" data-preset="custom" aria-pressed="false">Custom…</button>
            </div>

            <div class="custom-exp" id="custom-exp">
              <input type="number" id="expiresValue" name="expiresValue" min="1" max="30" value="1" />
              <select id="expiresUnit" name="expiresUnit">
                <option value="hours">Hours</option>
                ${ONE_MINUTE_EXPIRATION_ENABLED ? '<option value="minutes">Minutes</option>' : ''}
                <option value="days" selected>Days</option>
              </select>
            </div>

            <div class="timing" aria-live="polite">
              <div>Expires at: <strong id="expires-at">—</strong></div>
              <div>Auto-deletes at: <strong id="autodelete-at">—</strong></div>
            </div>
          </div>

          <div class="section section-secondary" style="grid-column:1;">
            <h2 class="section-title">Media type</h2>
            <p class="hint">We’ll auto-detect this from your files.</p>

            <div class="segmented" aria-label="Media type">
              <label>
                <input type="radio" name="mediaType" value="images" checked />
                <span class="segment">Images</span>
              </label>
              <label>
                <input type="radio" name="mediaType" value="video" />
                <span class="segment">Video</span>
              </label>
              <label>
                <input type="radio" name="mediaType" value="audio" />
                <span class="segment">Audio</span>
              </label>
            </div>
          </div>

          <div class="section section-secondary" style="grid-column:2;">
            <details class="advanced" open="false">
              <summary>Advanced options</summary>
              <div class="adv-inner">
                <div>
                  <div class="label">Password protection (optional)</div>
                  <div class="helper">Share the password separately for extra privacy.</div>
                </div>
                <input class="input" type="password" name="password" autocomplete="new-password" placeholder="Leave blank for no password" />
              </div>
            </details>
          </div>
        </div>

        <div class="cta-bar">
          <div class="cta-right">
            <button type="submit" class="btn-primary">Create link</button>
            <div class="reassure">
              Files are automatically deleted after expiration.
            </div>
            <div class="trust">Private &amp; unlisted • Auto-deleted • No signup required</div>
          </div>
        </div>
      </section>
    </form>
  </div>

  <script>
    const mediaInputs = document.querySelectorAll('input[name="mediaType"]');
    const visibleFilesInput = document.getElementById('files-input');
    const dropzone = document.getElementById('dropzone');
    const expirationChips = document.getElementById('expiration-chips');
    const customExp = document.getElementById('custom-exp');
    const expiresValueInput = document.getElementById('expiresValue');
    const expiresUnitSelect = document.getElementById('expiresUnit');
    const expiresAtEl = document.getElementById('expires-at');
    const autoDeleteAtEl = document.getElementById('autodelete-at');

    const hiddenInputs = {
      images: document.getElementById('images-hidden'),
      video: document.getElementById('video-hidden'),
      audio: document.getElementById('audio-hidden'),
    };

    const listEl = document.getElementById('files-list');
    const warningEl = document.getElementById('files-warning');

    const GRACE_PERIOD_MS = ${AUTO_DELETE_GRACE_PERIOD_MS};

    const state = {
      images: [],
      video: [],
      audio: [],
      max: {
        images: 10,
        video: 1,
        audio: 2,
      },
    };

    function setSelectedMediaType(type) {
      const input = document.querySelector('input[name="mediaType"][value="' + type + '"]');
      if (input) {
        input.checked = true;
      }
    }

    function getSelectedMediaType() {
      const selected = document.querySelector('input[name="mediaType"]:checked');
      return selected ? selected.value : 'images';
    }

    function inferMediaTypeFromFiles(files) {
      const first = (files && files[0]) || null;
      if (!first) return 'images';
      const mime = (first.type || '').toLowerCase();
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.startsWith('image/')) return 'images';
      return 'images';
    }

    function formatTimestamp(date) {
      try {
        return date.toLocaleString(undefined, {
          year: 'numeric',
          month: 'short',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch (e) {
        return date.toISOString();
      }
    }

    function getDurationMsFromForm() {
      const value = parseInt((expiresValueInput && expiresValueInput.value) || '1', 10);
      const unit = (expiresUnitSelect && expiresUnitSelect.value) || 'days';
      if (!Number.isFinite(value) || value <= 0) return 24 * 60 * 60 * 1000;
      if (unit === 'hours') return value * 60 * 60 * 1000;
      if (unit === 'days') return value * 24 * 60 * 60 * 1000;
      if (unit === 'minutes') return value * 60 * 1000;
      return value * 24 * 60 * 60 * 1000;
    }

    function updateTimingPreview() {
      const now = new Date();
      const durationMs = getDurationMsFromForm();
      const expiresAt = new Date(now.getTime() + durationMs);
      const autoDeleteAt = new Date(now.getTime() + durationMs + GRACE_PERIOD_MS);
      if (expiresAtEl) expiresAtEl.textContent = formatTimestamp(expiresAt);
      if (autoDeleteAtEl) autoDeleteAtEl.textContent = formatTimestamp(autoDeleteAt);
    }

    function clearHiddenInputs() {
      Object.keys(hiddenInputs).forEach((type) => {
        const hidden = hiddenInputs[type];
        if (!hidden) return;
        hidden.files = new DataTransfer().files;
      });
    }

    function syncHiddenInput(type) {
      const hidden = hiddenInputs[type];
      if (!hidden) return;
      const dt = new DataTransfer();
      (state[type] || []).forEach((file) => dt.items.add(file));
      hidden.files = dt.files;
    }

    function renderList(type) {
      if (!listEl) return;
      const files = state[type] || [];
      listEl.innerHTML = '';
      files.forEach((file, index) => {
        const li = document.createElement('li');
        li.className = 'file-chip';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = file.name || '(unnamed file)';
        const metaSpan = document.createElement('span');
        metaSpan.className = 'meta';
        metaSpan.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          state[type].splice(index, 1);
          syncHiddenInput(type);
          renderList(type);
          if (warningEl) warningEl.style.display = 'none';
        });
        li.appendChild(nameSpan);
        li.appendChild(metaSpan);
        li.appendChild(removeBtn);
        listEl.appendChild(li);
      });
    }

    function handleFilesAdded(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const inferred = inferMediaTypeFromFiles(files);
      setSelectedMediaType(inferred);

      const max = state.max[inferred];
      const allowedPrefix = inferred === 'images' ? 'image/' : inferred === 'video' ? 'video/' : 'audio/';
      const filtered = files.filter((f) => (f.type || '').toLowerCase().startsWith(allowedPrefix));

      const current = state[inferred] || [];
      const next = [...current];
      filtered.forEach((f) => {
        const duplicate = next.some((existing) => {
          return existing.name === f.name && existing.size === f.size && existing.lastModified === f.lastModified;
        });
        if (duplicate) return;
        if (inferred === 'video') {
          // Single video: replace
          next.splice(0, next.length, f);
          return;
        }
        if (next.length < max) {
          next.push(f);
        }
      });

      state.images = inferred === 'images' ? next : [];
      state.video = inferred === 'video' ? next : [];
      state.audio = inferred === 'audio' ? next : [];
      clearHiddenInputs();
      state[inferred] = next;
      syncHiddenInput(inferred);
      renderList(inferred);

      if (warningEl) {
        warningEl.style.display = 'none';
      }

      if (files.length > max) {
        if (warningEl) {
          const messages = {
            images: 'You can upload up to 10 images per upload.',
            audio: 'You can upload up to 2 audio files per upload.',
            video: 'You can upload only 1 video file per upload.',
          };
          warningEl.textContent = messages[inferred] || 'Too many files selected.';
          warningEl.style.display = 'block';
        }
      }
    }

    function setExpirationPreset(preset) {
      if (!expiresValueInput || !expiresUnitSelect) return;
      if (customExp) customExp.classList.remove('is-open');
      if (preset === 'custom') {
        if (customExp) customExp.classList.add('is-open');
        updateTimingPreview();
        return;
      }
      if (preset === '1d') {
        expiresValueInput.value = '1';
        expiresUnitSelect.value = 'days';
      } else if (preset === '3d') {
        expiresValueInput.value = '3';
        expiresUnitSelect.value = 'days';
      } else if (preset === '7d') {
        expiresValueInput.value = '7';
        expiresUnitSelect.value = 'days';
      } else if (preset === '30d') {
        expiresValueInput.value = '30';
        expiresUnitSelect.value = 'days';
      }
      updateTimingPreview();
    }

    if (visibleFilesInput) {
      visibleFilesInput.addEventListener('change', (event) => {
        handleFilesAdded(event.target.files);
        event.target.value = '';
      });
    }

    function preventDefaults(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (dropzone && visibleFilesInput) {
      dropzone.addEventListener('click', () => visibleFilesInput.click());
      dropzone.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          visibleFilesInput.click();
        }
      });

      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((eventName) => {
        dropzone.addEventListener(eventName, preventDefaults, false);
      });

      ['dragenter', 'dragover'].forEach((eventName) => {
        dropzone.addEventListener(eventName, () => dropzone.classList.add('is-dragover'), false);
      });
      ['dragleave', 'drop'].forEach((eventName) => {
        dropzone.addEventListener(eventName, () => dropzone.classList.remove('is-dragover'), false);
      });

      dropzone.addEventListener('drop', (event) => {
        const dt = event.dataTransfer;
        if (!dt) return;
        handleFilesAdded(dt.files);
      });
    }

    if (expirationChips) {
      expirationChips.addEventListener('click', (event) => {
        const btn = event.target && event.target.closest && event.target.closest('button[data-preset]');
        if (!btn) return;
        const preset = btn.getAttribute('data-preset');
        Array.from(expirationChips.querySelectorAll('button[data-preset]')).forEach((b) => {
          b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
        });
        setExpirationPreset(preset);
      });
    }

    if (expiresValueInput) {
      expiresValueInput.addEventListener('input', updateTimingPreview);
    }
    if (expiresUnitSelect) {
      expiresUnitSelect.addEventListener('change', updateTimingPreview);
    }

    mediaInputs.forEach((input) => {
      input.addEventListener('change', () => {
        state.images = [];
        state.video = [];
        state.audio = [];
        clearHiddenInputs();
        if (listEl) listEl.innerHTML = '';
        if (warningEl) warningEl.style.display = 'none';
      });
    });

    setSelectedMediaType(getSelectedMediaType());
    updateTimingPreview();
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.status(200).send(getUploadPageHtml({ showStatusBadge: false }));
});

app.get('/status', (req, res) => {
  res.status(200).send(getStatusPageHtml());
});

app.post(
  '/upload',
  upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 2 },
  ]),
  (req, res) => {
    try {
      const uploadedFiles = []
        .concat((req.files && req.files.images) || [])
        .concat((req.files && req.files.video) || [])
        .concat((req.files && req.files.audio) || []);

      const mediaType = (req.body && req.body.mediaType) || 'images';
      const expiresValueRaw = (req.body && req.body.expiresValue) || '1';
      const expiresUnitRaw = (req.body && req.body.expiresUnit) || 'days';

      if (!uploadedFiles.length) {
        return sendValidationError(res, 'No files selected', 'Please choose at least one file to upload.');
      }

      const requestedUnit = String(expiresUnitRaw);
      const expiresUnit =
        requestedUnit === 'hours'
          ? 'hours'
          : requestedUnit === 'minutes' && ONE_MINUTE_EXPIRATION_ENABLED
          ? 'minutes'
          : 'days';
      const expiresValue = Math.max(1, Math.min(30, parseInt(String(expiresValueRaw), 10) || 1));
      const durationMs =
        expiresUnit === 'minutes'
          ? expiresValue * 60 * 1000
          : expiresUnit === 'hours'
          ? expiresValue * 60 * 60 * 1000
          : expiresValue * 24 * 60 * 60 * 1000;

      const now = Date.now();
      const expiresAt = new Date(now + durationMs);
      const autoDeleteAt = new Date(now + durationMs + AUTO_DELETE_GRACE_PERIOD_MS);

      const id = crypto.randomBytes(10).toString('hex');
      const dashboardKey = crypto.randomBytes(12).toString('base64url');

      const passwordRaw = (req.body && req.body.password) || '';
      const trimmedPassword = String(passwordRaw).trim();
      let password = null;
      let passwordVersion = null;
      if (trimmedPassword) {
        const salt = crypto.randomBytes(16).toString('hex');
        const iterations = 100000;
        const keylen = 64;
        const digest = 'sha512';
        const hash = crypto.pbkdf2Sync(trimmedPassword, salt, iterations, keylen, digest).toString('hex');
        password = { algorithm: 'pbkdf2', iterations, keylen, digest, salt, hash };
        passwordVersion = crypto.randomBytes(8).toString('hex');
      }

      const files = uploadedFiles.map((f) => ({
        fieldName: f.fieldname,
        storedFilename: f.filename,
        storedPath: f.path,
        originalFilename: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
      }));

      const record = {
        id,
        mediaType,
        files,
        expiration: {
          value: expiresValue,
          unit: expiresUnit,
          durationMs,
          expiresAt: expiresAt.toISOString(),
          autoDeleteAt: autoDeleteAt.toISOString(),
        },
        password,
        createdAt: new Date(now).toISOString(),
        countdownVisible: false,
        viewCount: 0,
        maxViews: null,
        deleted: false,
        expired: false,
        deletedReason: null,
        dashboardKey,
        passwordVersion,
      };

      uploadsStore.push(record);

      const viewPath = `/v/${id}`;
      const viewUrl = `${req.protocol}://${req.get('host')}${viewPath}`;
      const dashboardPath = `/dashboard/${id}?key=${encodeURIComponent(dashboardKey)}`;
      const dashboardUrl = `${req.protocol}://${req.get('host')}${dashboardPath}`;

      return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Link ready • FadeDrop</title>
  <style>
    ${getWarmCss()}
    .link-box {
      margin-top: 0.95rem;
      border-radius: var(--radius-md);
      border: 1px solid rgba(47, 107, 79, 0.22);
      background: rgba(47, 107, 79, 0.08);
      padding: 0.85rem;
      display: grid;
      gap: 0.65rem;
    }
    .link-actions { display: grid; gap: 0.6rem; }
    .link-action-row { display: grid; gap: 0.6rem; }
    @media (min-width: 720px) { .link-action-row { grid-template-columns: 1fr auto; align-items: center; } }
    .link-input {
      width: 100%;
      padding: 0.65rem 0.75rem;
      border-radius: 14px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      background: rgba(255, 255, 255, 0.88);
      color: var(--text);
      font-size: 0.95rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    }
    .btn-copy { padding: 0.7rem 1.05rem; font-size: 0.92rem; }
    .btn-manage {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.7rem 1.05rem;
      border-radius: 999px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      background: rgba(255, 255, 255, 0.6);
      color: var(--text);
      text-decoration: none;
      font-weight: 650;
      font-size: 0.92rem;
      min-height: 44px;
      white-space: nowrap;
    }
    .btn-manage:hover { background: rgba(255, 255, 255, 0.8); text-decoration: none; }
    .copy-status { font-size: 0.85rem; color: var(--muted); }
    @media (max-width: 480px) {
      .btn-copy { width: 100%; min-height: 48px; font-size: 1rem; }
      .btn-manage { width: 100%; min-height: 48px; font-size: 1rem; }
      .link-input { font-size: 1rem; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
      <p class="tagline">Temporary media links for images, video, and audio.</p>
    </header>
    <main class="card card-narrow">
      <h1>Link ready</h1>
      <p>Your temporary link is ready. It will disappear automatically after expiration.</p>
      <div class="link-box" aria-label="Generated link">
        <div class="link-actions">
          <div class="link-action-row">
            <input id="view-link" class="link-input" type="text" value="${viewUrl}" readonly />
            <button id="copy-link" class="btn-primary btn-copy" type="button">Copy link</button>
          </div>
          <div class="link-action-row">
            <input class="link-input" type="text" value="${dashboardUrl}" readonly />
            <a class="btn-manage" href="${dashboardPath}" target="_blank" rel="noopener noreferrer">Link settings</a>
          </div>
        </div>
        <div id="copy-status" class="copy-status" aria-live="polite">Private &amp; unlisted • Auto-deleted • No signup required</div>
      </div>
      <div class="actions">
        <a href="/" class="btn-secondary">Upload more</a>
      </div>
    </main>
  </div>

  <script>
    const input = document.getElementById('view-link');
    const inputs = Array.from(document.querySelectorAll('.link-input'));
    const btn = document.getElementById('copy-link');
    const status = document.getElementById('copy-status');

    function setStatus(text) {
      if (status) status.textContent = text;
    }

    async function copyText(value) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(value);
        return;
      }
      if (input) {
        input.focus();
        input.select();
        document.execCommand('copy');
      }
    }

    if (btn && input) {
      btn.addEventListener('click', async () => {
        try {
          await copyText(input.value);
          setStatus('Copied to clipboard. Private & unlisted • Auto-deleted • No signup required');
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy link'; }, 1400);
        } catch (e) {
          setStatus('Copy failed. You can manually select the link and copy it.');
        }
      });
      inputs.forEach((el) => el.addEventListener('click', () => el.select()));
    }
  </script>
</body>
</html>`);
    } catch (err) {
      console.error('Error handling upload:', err);
      return res.status(500).send('Upload failed');
    }
  }
);

app.post('/dashboard/:id/password', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?pwError=notfound');
  }

  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard password change attempt', {
      uploadId: id,
      at: new Date().toISOString(),
    });
    return res.status(401).send('Unauthorized');
  }

  const mode = (req.body && req.body.mode) || 'set';

  if (mode === 'remove') {
    if (record.password) {
      const currentPassword = (req.body && req.body.currentPassword) || '';
      const trimmedCurrent = currentPassword.trim();
      if (!trimmedCurrent) {
        return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=current_required');
      }

      try {
        const { salt, iterations, keylen, digest, hash } = record.password;
        const candidate = crypto
          .pbkdf2Sync(trimmedCurrent, salt, iterations, keylen, digest)
          .toString('hex');

        if (candidate !== hash) {
          return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=current_invalid');
        }
      } catch (err) {
        console.error('Error verifying current dashboard password for removal:', err);
        return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=update');
      }
    }

    record.password = null;
    record.passwordVersion = null;
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwMessage=removed');
  }

  const newPassword = (req.body && req.body.password) || '';
  const trimmedNew = newPassword.trim();
  if (!trimmedNew) {
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=empty');
  }

  // If a password already exists and the mode is change, require current password verification
  if (mode === 'change' && record.password) {
    const currentPassword = (req.body && req.body.currentPassword) || '';
    const trimmedCurrent = currentPassword.trim();
    if (!trimmedCurrent) {
      return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=current_required');
    }

    try {
      const { salt, iterations, keylen, digest, hash } = record.password;
      const candidate = crypto
        .pbkdf2Sync(trimmedCurrent, salt, iterations, keylen, digest)
        .toString('hex');

      if (candidate !== hash) {
        return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=current_invalid');
      }
    } catch (err) {
      console.error('Error verifying current dashboard password:', err);
      return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=update');
    }
  }

  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = 100000;
    const keylen = 64;
    const digest = 'sha512';
    const hash = crypto.pbkdf2Sync(trimmedNew, salt, iterations, keylen, digest).toString('hex');

    record.password = {
      algorithm: 'pbkdf2',
      iterations,
      keylen,
      digest,
      salt,
      hash,
    };
    record.passwordVersion = crypto.randomBytes(8).toString('hex');

    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwMessage=updated');
  } catch (err) {
    console.error('Error updating dashboard password:', err);
    return res.redirect('/dashboard/' + encodeURIComponent(id) + '?key=' + encodeURIComponent(key) + '&pwError=update');
  }
});

 app.get('/dashboard/:id', (req, res) => {
  const { id } = req.params;
  const key = req.query.key;

  const record = uploadsStore.find((r) => r.id === id);

  if (!record) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Invalid link • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>Invalid link</h1>
      <p>This link is invalid or no longer available.</p>
      <p class="back-link"><a href="/">Back to upload</a></p>
    </main>
  </div>
</body>
</html>`);
  }
  if (!key || key !== record.dashboardKey) {
    console.warn('Unauthorized dashboard access', {
      uploadId: id,
      at: new Date().toISOString(),
    });

    return res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unauthorized • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>Unauthorized</h1>
      <p class="error">Unauthorized  invalid dashboard key.</p>
      <p class="back-link"><a href="/">Back to upload</a></p>
    </main>
  </div>
</body>
</html>`);
  }

  autoDeleteUploadIfNeeded(record);

  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiration?.expiresAt || record.createdAt || new Date().toISOString());
  const isExpired = Number.isFinite(expiresAtMs) ? now >= expiresAtMs : false;

  const createdAt = record.createdAt;
  const expiresAt = record.expiration?.expiresAt || 'n/a';
  const autoDeleteAt = (() => {
    const direct = record.expiration?.autoDeleteAt;
    if (direct) return direct;
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs)) return 'n/a';
    return new Date(expiresMs + AUTO_DELETE_GRACE_PERIOD_MS).toISOString();
  })();

  let timeRemainingLabel = 'n/a';
  if (Number.isFinite(expiresAtMs)) {
    const diff = expiresAtMs - now;
    if (diff <= 0) {
      timeRemainingLabel = 'Expired';
    } else {
      const minutes = Math.round(diff / (60 * 1000));
      const hours = Math.round(diff / (60 * 60 * 1000));
      const days = Math.round(diff / (24 * 60 * 60 * 1000));

      if (days >= 2) {
        timeRemainingLabel = days + ' days left';
      } else if (hours >= 2) {
        timeRemainingLabel = hours + ' hours left';
      } else {
        const mins = Math.max(1, minutes);
        timeRemainingLabel = mins + ' minutes left';
      }
    }
  }

  const passwordStatus = record.password ? 'Password enabled' : 'No password set';

  const views = Number.isFinite(record.viewCount) ? record.viewCount : 0;
  const maxViews = record.maxViews;
  const maxViewsLabel = Number.isInteger(maxViews) && maxViews > 0 ? String(maxViews) : 'none';
  const overViewLimit = Number.isInteger(maxViews) && maxViews > 0 && views >= maxViews;
  const countdownVisible = record.countdownVisible !== false;

  const viewPath = `/v/${id}`;
  const viewUrl = `${req.protocol}://${req.get('host')}${viewPath}`;

  const status = record.deleted
    ? record.deletedReason === 'auto'
      ? 'Automatically deleted'
      : 'Deleted by uploader'
    : isExpired
    ? 'Expired'
    : overViewLimit
    ? 'View limit reached'
    : 'Active';

  const pwMessage = req.query.pwMessage;
  const pwError = req.query.pwError;
  const viewMessage = req.query.viewMessage;
  const viewError = req.query.viewError;
  const expMessage = req.query.expMessage;
  const expError = req.query.expError;
  const delMessage = req.query.delMessage;
  const delError = req.query.delError;
  const cdMessage = req.query.cdMessage;
  const cdError = req.query.cdError;

  let feedbackHtml = '';
  if (pwMessage === 'updated') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Password updated.</p>';
  } else if (pwMessage === 'removed') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Password removed. This link is now accessible without a password.</p>';
  } else if (pwError === 'empty') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Password cannot be empty.</p>';
  } else if (pwError === 'current_required') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Current password is required to change it.</p>';
  } else if (pwError === 'current_invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Current password is incorrect.</p>';
  } else if (viewMessage === 'updated') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">View limit updated.</p>';
  } else if (viewMessage === 'removed') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">View limit removed. This link now has no maximum view limit.</p>';
  } else if (viewError === 'invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Please enter a positive whole number up to 100000 for max viewers.</p>';
  } else if (expMessage === 'extended') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Expiration extended successfully.</p>';
  } else if (expError === 'invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Please choose a valid extension amount.</p>';
  } else if (expError === 'tooFar') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Expiration cannot be extended beyond 30 days from today.</p>';
  } else if (delMessage === 'deleted') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Link deleted. Content is no longer available.</p>';
  } else if (delMessage === 'alreadyDeleted') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#9ca3af;">This link was already deleted.</p>';
  } else if (delError === 'notfound') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Link not found for deletion.</p>';
  } else if (cdMessage === 'updated') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Expiration visibility updated.</p>';
  } else if (cdError === 'invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Please choose a valid countdown visibility option.</p>';
  }

  const files = record.files || [];
  const filesListHtml = record.deleted
    ? '<tr><td colspan="4">No files — upload deleted.</td></tr>'
    : files
        .map(
          (f) => `
        <tr>
          <td>${record.mediaType}</td>
          <td>${f.originalFilename || '(unnamed file)'}</td>
          <td>${(f.size / (1024 * 1024)).toFixed(2)} MB</td>
          <td>${f.mimeType}</td>
        </tr>`
        )
        .join('');

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Manage link • FadeDrop</title>
  <style>
    ${getWarmCss()}
    dl.meta { margin: 0.35rem 0 0; display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr); gap: 0.3rem 0.85rem; font-size: 0.85rem; }
    dl.meta dt { color: var(--muted); }
    dl.meta dd { margin: 0; color: var(--text); }
    .link-copy { display: grid; grid-template-columns: 1fr auto; gap: 0.6rem; align-items: center; }
    .link-copy input {
      width: 100%;
      padding: 0.5rem 0.6rem;
      border-radius: 12px;
      border: 1px solid rgba(60, 45, 30, 0.18);
      background: rgba(255, 255, 255, 0.85);
      color: var(--text);
      font-size: 0.85rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .link-copy .btn-secondary { padding: 0.5rem 0.85rem; font-size: 0.85rem; min-height: 44px; white-space: nowrap; }
    .copy-feedback { margin-top: 0.35rem; font-size: 0.8rem; color: var(--muted); }
    @media (max-width: 768px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
    }

    @media (max-width: 480px) {
      dl.meta { grid-template-columns: 1fr; gap: 0.2rem; }
      dl.meta dt { margin-top: 0.55rem; }
      dl.meta dt:first-child { margin-top: 0; }
      dl.meta dd { word-break: break-word; }
      .link-copy { grid-template-columns: 1fr; }
      .link-copy .btn-secondary { width: 100%; }
      .danger-btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
      <p class="tagline">Temporary media links for images, video, and audio.</p>
    </header>

    <main class="card">
      <h1>Manage link</h1>
      <p>Private controls for this temporary link. Share this page only with people you trust.</p>
      ${feedbackHtml}

      <div class="layout">
      <section class="section">
        <h2>Link details</h2>
        <dl class="meta">
          <dt>Link</dt>
          <dd>
            <div class="link-copy">
              <input id="public-link" type="text" value="${viewUrl}" readonly />
              <button id="copy-public-link" class="btn-secondary" type="button">Copy</button>
            </div>
            <div id="copy-public-status" class="copy-feedback" aria-live="polite"></div>
          </dd>
          <dt>Link ID</dt>
          <dd>${record.id}</dd>
          <dt>Media type</dt>
          <dd>${record.mediaType}</dd>
          <dt>Created</dt>
          <dd>${createdAt}</dd>
          <dt>Expires</dt>
          <dd>${expiresAt}</dd>
          <dt>Auto-deletes at</dt>
          <dd>${autoDeleteAt}</dd>
          ${record.deleted ? '<dt>Deleted at</dt><dd>' + (record.deletedAt || 'n/a') + '</dd>' : ''}
          <dt>Time remaining</dt>
          <dd>${timeRemainingLabel}</dd>
          <dt>Link status</dt>
          <dd>
            <span class="status-pill ${
              status === 'Active' ? 'status-valid' : status === 'Expired' ? 'status-expired' : 'status-deleted'
            }">${status}</span>
          </dd>
        </dl>
      </section>

      <section class="section">
        <h2>Link settings</h2>
        ${
          record.deleted
            ? '<p style="font-size:0.85rem;color:#fca5a5;margin:0 0 0.6rem;">This link is read-only because it was ' +
              (record.deletedReason === 'auto' ? 'deleted automatically after expiration' : 'deleted by the uploader') +
              '.</p>'
            : '<div style="margin-bottom:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(60,45,30,0.12);background:rgba(255,255,255,0.6);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Expiration</h3>\n' +
              '  <p style="margin:0 0 0.35rem;font-size:0.8rem;color:var(--muted);">This link will disappear automatically after expiration. You can extend it up to 30 days from now.</p>\n' +
              '  <p style="margin:0 0 0.3rem;font-size:0.8rem;">Expires: <span style="color:var(--text);">' +
              expiresAt +
              '</span></p>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;">Time remaining: <span style="color:var(--text);">' +
              timeRemainingLabel +
              '</span></p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/expiration?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.4rem;max-width:260px;margin-top:0.35rem;">\n' +
              '    <label for="dashboard-extend-expiration" style="font-size:0.8rem;color:var(--text);font-weight:650;">Extend expiration</label>\n' +
              '    <select\n' +
              '      id="dashboard-extend-expiration"\n' +
              '      name="extendBy"\n' +
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(60,45,30,0.18);background:rgba(255,255,255,0.85);color:var(--text);font-size:0.85rem;"\n' +
              '    >\n' +
              '      <option value="3600000">+1 hour</option>\n' +
              '      <option value="7200000">+2 hours</option>\n' +
              '      <option value="21600000">+6 hours</option>\n' +
              '      <option value="43200000">+12 hours</option>\n' +
              '      <option value="86400000">+1 day</option>\n' +
              '      <option value="259200000">+3 days</option>\n' +
              '      <option value="604800000">+7 days</option>\n' +
              '      <option value="2592000000">+30 days</option>\n' +
              '    </select>\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:1px solid rgba(47,107,79,0.25);background:var(--accent);color:#fffaf2;font-size:0.8rem;font-weight:650;cursor:pointer;justify-self:flex-start;">Extend expiration</button>\n' +
              '  </form>\n' +
              '</div>'
        }

        <p class="pill">Max viewers: ${maxViewsLabel}</p>
        <p style="margin-top:0.5rem; font-size:0.85rem;">Views: ${views}</p>
        ${
          overViewLimit && !record.deleted
            ? '<p style="margin-top:0.15rem;font-size:0.8rem;color:#fca5a5;">This link has reached its view limit. New visitors will see a view-limit message until you increase or remove the limit.</p>'
            : ''
        }
        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(60,45,30,0.12);background:rgba(255,255,255,0.6);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">View limit</h3>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;color:var(--muted);">Optionally limit how many times this link can be opened.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/views?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.35rem;max-width:260px;margin-bottom:0.8rem;">\n' +
              '    <input type="hidden" name="mode" value="set" />\n' +
              '    <label for="dashboard-max-views" style="font-size:0.8rem;color:var(--text);font-weight:650;">View limit</label>\n' +
              '    <input\n' +
              '      id="dashboard-max-views"\n' +
              '      name="maxViews"\n' +
              '      type="number"\n' +
              '      min="1"\n' +
              '      max="100000"\n' +
              '      step="1"\n' +
              '      value="' +
              (maxViews && maxViews > 0 ? maxViews : '') +
              '"\n' +
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(60,45,30,0.18);background:rgba(255,255,255,0.85);color:var(--text);font-size:0.85rem;"\n' +
              '    />\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:1px solid rgba(47,107,79,0.25);background:var(--accent);color:#fffaf2;font-size:0.8rem;font-weight:650;cursor:pointer;justify-self:flex-start;">Save view limit</button>\n' +
              '  </form>\n' +
              (maxViews && maxViews > 0
                ? '  <form method="post" action="/dashboard/' +
                  record.id +
                  '/views?key=' +
                  encodeURIComponent(key) +
                  '" style="margin:0;">\n' +
                  '    <input type="hidden" name="mode" value="remove" />\n' +
                  '    <button type="submit" style="padding:0.35rem 0.9rem;border-radius:999px;border:1px solid rgba(60,45,30,0.2);background:transparent;color:var(--text);font-size:0.75rem;cursor:pointer;">Remove view limit</button>\n' +
                  '  </form>\n'
                : '') +
              '</div>'
        }

        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(60,45,30,0.12);background:rgba(255,255,255,0.6);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Password protection</h3>\n' +
              '  <p style="margin:0 0 0.4rem;font-size:0.8rem;display:flex;align-items:center;gap:0.35rem;">\n' +
              '    <span class="pill" style="border-color:' +
              (record.password ? 'rgba(34,197,94,0.7)' : 'rgba(148,163,184,0.8)') +
              ';background:' +
              (record.password ? 'rgba(22,163,74,0.15)' : 'rgba(255,255,255,0.7)') +
              ';"><span style="font-size:0.8rem;">' +
              (record.password ? '🔐' : '🔓') +
              '</span> ' +
              passwordStatus +
              '</span>\n' +
              '  </p>\n' +
              '  <p style="margin:0.2rem 0 0.6rem;font-size:0.8rem;color:var(--muted);">Use these controls to add, change, or remove the password for the public view link.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/password?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.4rem;max-width:260px;">\n' +
              '    <input type="hidden" name="mode" value="' +
              (record.password ? 'change' : 'set') +
              '" />\n' +
              (record.password
                ? '    <label for="dashboard-current-password" style="font-size:0.8rem;color:var(--text);font-weight:650;">Current password</label>\n' +
                  '    <input id="dashboard-current-password" name="currentPassword" type="password" autocomplete="current-password" style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(60,45,30,0.18);background:rgba(255,255,255,0.85);color:var(--text);font-size:0.85rem;" />\n'
                : '') +
              '    <label for="dashboard-password" style="font-size:0.8rem;color:var(--text);font-weight:650;">' +
              (record.password ? 'New password' : 'Password') +
              '</label>\n' +
              '    <input\n' +
              '      id="dashboard-password"\n' +
              '      name="password"\n' +
              '      type="password"\n' +
              '      autocomplete="new-password"\n' +
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(60,45,30,0.18);background:rgba(255,255,255,0.85);color:var(--text);font-size:0.85rem;"\n' +
              '    />\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:1px solid rgba(47,107,79,0.25);background:var(--accent);color:#fffaf2;font-size:0.8rem;font-weight:650;cursor:pointer;justify-self:flex-start;">' +
              (record.password ? 'Change password' : 'Save password') +
              '</button>\n' +
              '  </form>\n' +
              (record.password
                ? '  <form method="post" action="/dashboard/' +
                  record.id +
                  '/password?key=' +
                  encodeURIComponent(key) +
                  '" style="margin-top:0.75rem;display:grid;gap:0.35rem;max-width:260px;">\n' +
                  '    <input type="hidden" name="mode" value="remove" />\n' +
                  '    <label for="dashboard-remove-current" style="font-size:0.8rem;color:var(--text);font-weight:650;">Current password</label>\n' +
                  '    <input id="dashboard-remove-current" name="currentPassword" type="password" autocomplete="current-password" style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(60,45,30,0.18);background:rgba(255,255,255,0.85);color:var(--text);font-size:0.85rem;" />\n' +
                  '    <button type="submit" style="padding:0.35rem 0.9rem;border-radius:999px;border:1px solid rgba(248,113,113,0.85);background:transparent;color:rgba(134,57,57,0.95);font-size:0.75rem;cursor:pointer;justify-self:flex-start;">Remove password</button>\n' +
                  '  </form>\n'
                : '') +
              '</div>'
        }

        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(60,45,30,0.12);background:rgba(255,255,255,0.6);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Expiration visibility</h3>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;color:var(--muted);">Choose whether viewers can see the expiration time.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/countdown?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.35rem;max-width:260px;">\n' +
              '    <label style="font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;color:var(--text);">\n' +
              '      <input type="radio" name="countdownMode" value="show" ' +
              (countdownVisible ? 'checked' : '') +
              ' />\n' +
              '      <span>Show expiration time to viewers</span>\n' +
              '    </label>\n' +
              '    <label style="font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;color:var(--text);">\n' +
              '      <input type="radio" name="countdownMode" value="hide" ' +
              (countdownVisible ? '' : 'checked') +
              ' />\n' +
              '      <span>Hide expiration time from viewers</span>\n' +
              '    </label>\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:1px solid rgba(47,107,79,0.25);background:var(--accent);color:#fffaf2;font-size:0.8rem;font-weight:650;cursor:pointer;justify-self:flex-start;">Save changes</button>\n' +
              '  </form>\n' +
              '</div>'
        }
      </section>
    </div>

    <section class="section" style="margin-top:1.25rem;">
      <h2>Files</h2>
      <p>These are the files attached to this link. File paths and internal identifiers are hidden.</p>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>File name</th>
            <th>Size</th>
            <th>MIME type</th>
          </tr>
        </thead>
        <tbody>
          ${filesListHtml || '<tr><td colspan="4">No files recorded for this upload.</td></tr>'}
        </tbody>
      </table>
    </section>

    <section class="section" style="margin-top:1.25rem;">
      <h2>Delete link</h2>
      <p style="font-size:0.85rem;color:#9ca3af;">Use this section to permanently delete this link. This cannot be undone.</p>
      ${
        record.deleted
          ? '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">This link was ' +
            (record.deletedReason === 'auto' ? 'deleted automatically after expiration.' : 'deleted by the uploader.') +
            ' The public link now shows a deletion message.</p>'
          : '<form method="post" action="/dashboard/' +
            record.id +
            '/delete?key=' +
            encodeURIComponent(key) +
            '" onsubmit="return confirm(\'Are you sure you want to delete this link? This action cannot be undone.\');" style="margin-top:0.75rem;">\n' +
            '  <button type="submit" class="danger-btn" style="padding:0.55rem 1.1rem;border-radius:999px;border:1px solid rgba(248,113,113,0.9);background:transparent;color:#fecaca;font-size:0.85rem;cursor:pointer;">Delete link</button>\n' +
            '</form>'
      }
    </section>

    <p class="back-link"><a href="/">Back to upload</a></p>
  </main>
</div>

<script>
  const publicLinkInput = document.getElementById('public-link');
  const copyPublicBtn = document.getElementById('copy-public-link');
  const copyPublicStatus = document.getElementById('copy-public-status');

  function setStatus(text) {
    if (copyPublicStatus) copyPublicStatus.textContent = text;
  }

  async function copyText(value) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    if (publicLinkInput) {
      publicLinkInput.focus();
      publicLinkInput.select();
      document.execCommand('copy');
    }
  }

  if (publicLinkInput) {
    publicLinkInput.addEventListener('click', () => publicLinkInput.select());
  }

  if (copyPublicBtn && publicLinkInput) {
    copyPublicBtn.addEventListener('click', async () => {
      try {
        await copyText(publicLinkInput.value);
        setStatus('Copied');
        copyPublicBtn.textContent = 'Copied';
        setTimeout(() => {
          copyPublicBtn.textContent = 'Copy';
          setStatus('');
        }, 1400);
      } catch (e) {
        setStatus('Copy failed. You can manually select the link and copy it.');
      }
    });
  }
</script>
</body>
</html>`);
 });

 app.get('/v/:id', (req, res) => {
  const { id } = req.params;

  const record = uploadsStore.find((r) => r.id === id);
  if (record) autoDeleteUploadIfNeeded(record);
  if (!record || record.deleted) {
    const heading = !record
      ? 'This content has expired'
      : record.deletedReason === 'auto'
      ? 'This content has been deleted'
      : 'This content has been deleted';
    const message = !record
      ? 'The link you tried to open is no longer available.'
      : record.deletedReason === 'auto'
      ? 'This content has been deleted automatically after its expiration period.'
      : 'This content has been deleted by the uploader.';

    return res.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unavailable • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>${heading}</h1>
      <p>${message}</p>
      <div class="actions">
        <a class="btn-secondary" href="/">Back to upload</a>
      </div>
    </main>
  </div>
</body>
</html>`);
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiration?.expiresAt || record.createdAt || new Date().toISOString());
  const isExpired = Number.isFinite(expiresAtMs) ? now >= expiresAtMs : false;

  const currentViews = Number.isFinite(record.viewCount) ? record.viewCount : 0;
  const maxViews = Number.isInteger(record.maxViews) && record.maxViews > 0 ? record.maxViews : null;
  if (maxViews !== null && currentViews >= maxViews) {
    return res.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>View limit reached • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>View limit reached</h1>
      <p>This content is no longer available because the maximum view limit has been reached.</p>
      <div class="actions">
        <a class="btn-secondary" href="/">Back to upload</a>
        <a class="btn-primary" href="/dashboard/${record.id}?key=${encodeURIComponent(record.dashboardKey)}" target="_blank" rel="noopener noreferrer">Link settings</a>
      </div>
    </main>
  </div>
</body>
</html>`);
  }

  const filesForType = (record.files || []).filter((f) => f.fieldName === record.mediaType);

  if (!filesForType.length) {
    return res.status(500).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Unable to display content • FadeDrop</title>
  <style>
    ${getWarmCss()}
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow">
      <h1>Unable to display content</h1>
      <p class="error">This upload record does not contain any files that can be shown.</p>
      <p class="back-link"><a href="/">Back to upload</a></p>
    </main>
  </div>
</body>
</html>`);
  }

  const requiresPassword = !!record.password;

  if (requiresPassword) {
    const cookies = typeof parseCookies === 'function' ? parseCookies(req) : {};
    const expected = record.passwordVersion;
    const cookieName = typeof getViewCookieName === 'function' ? getViewCookieName(record.id) : `fadedrop_view_${record.id}`;
    const cookieValue = cookies[cookieName];

    if (!expected || !cookieValue || cookieValue !== expected) {
      const showError = req.query && req.query.error === 'invalid';
      const errorHtml = showError
        ? '<p style="color:#fca5a5;margin-top:0.5rem;">Incorrect password. Please try again.</p>'
        : '';

      return res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Protected link • FadeDrop</title>
  <style>
    ${getWarmCss()}
    form { margin-top: 1rem; display: grid; gap: 0.6rem; }
    label { font-size: 0.85rem; color: var(--text); font-weight: 650; }
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
    </header>
    <main class="card card-narrow" style="max-width:520px;">
      <h1>Password required</h1>
      <p>This link is protected. Enter the password to view the content.</p>
      ${errorHtml}
      <form method="post" action="/v/${record.id}/password">
        <label for="password">Password</label>
        <input class="input" type="password" id="password" name="password" autocomplete="current-password" required />
        <button class="btn-primary" type="submit">Unlock</button>
      </form>
      <p class="back-link"><a href="/">Back to upload</a></p>
    </main>
  </div>
</body>
</html>`);
    }
  }

  const type = record.mediaType;
  const basePathByType = {
    images: '/media/images',
    video: '/media/videos',
    audio: '/media/audio',
  };
  const basePath = basePathByType[type] || '/media';

  const titleByType = {
    images: 'Images',
    video: 'Video',
    audio: 'Audio',
  };

  const pageTitle = `Shared content • FadeDrop`;

  const countdownVisibleForView = record.countdownVisible !== false;
  let expiresInText = '';
  if (countdownVisibleForView && Number.isFinite(expiresAtMs) && !isExpired && maxViews !== null ? currentViews < maxViews : true) {
    const diff = expiresAtMs - now;
    if (diff > 0) {
      const minutes = Math.round(diff / (60 * 1000));
      const hours = Math.round(minutes / 60);
      const days = Math.round(hours / 24);

      if (days >= 2) {
        expiresInText = `Expires in ${days} days`;
      } else if (hours >= 2) {
        expiresInText = `Expires in ${hours} hours`;
      } else {
        const mins = Math.max(1, minutes);
        expiresInText = `Expires in ${mins} minute${mins === 1 ? '' : 's'}`;
      }
    }
  }

  const expiresMetaHtml = `<p class="meta">This content is temporary and will expire automatically.</p>` +
    (expiresInText ? `<p class="meta">${expiresInText}</p>` : '');

  const mediaHtml = (() => {
    if (type === 'images') {
      const items = filesForType
        .map(
          (f) => `
        <figure class="item">
          <img src="${basePath}/${encodeURIComponent(f.storedFilename)}" alt="${
            f.originalFilename || 'Uploaded image'
          }" loading="lazy" />
          <figcaption>${f.originalFilename || ''}</figcaption>
        </figure>`
        )
        .join('\n');
      return `<div class="gallery">${items}</div>`;
    }

    if (type === 'video') {
      const file = filesForType[0];
      return `<div class="player-wrap">
  <video controls preload="metadata">
    <source src="${basePath}/${encodeURIComponent(file.storedFilename)}" type="${file.mimeType}" />
    Your browser does not support the video tag.
  </video>
  <p class="filename">${file.originalFilename || ''}</p>
</div>`;
    }

    if (type === 'audio') {
      const items = filesForType
        .map(
          (f) => `
        <div class="audio-item">
          <p class="filename">${f.originalFilename || ''}</p>
          <audio controls preload="metadata">
            <source src="${basePath}/${encodeURIComponent(f.storedFilename)}" type="${f.mimeType}" />
            Your browser does not support the audio element.
          </audio>
        </div>`
        )
        .join('\n');
      return `<div class="audio-list">${items}</div>`;
    }

    return '<p>This upload uses a media type that cannot be displayed yet.</p>';
  })();

  // Successful content display: count this as a view.
  record.viewCount = (record.viewCount || 0) + 1;

  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${pageTitle}</title>
  <style>
    ${getWarmCss()}
    .meta { font-size: 0.85rem; color: var(--muted); margin-bottom: 0.85rem; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-top: 1.1rem; }
    .gallery .item { background: rgba(255, 255, 255, 0.65); border-radius: var(--radius-md); border: 1px solid rgba(60, 45, 30, 0.12); padding: 0.6rem; box-shadow: var(--shadow-soft); }
    .gallery img { width: 100%; height: auto; border-radius: 14px; display: block; background: rgba(255, 255, 255, 0.8); }
    .gallery figcaption { margin-top: 0.35rem; font-size: 0.8rem; color: var(--muted); word-break: break-all; }
    .player-wrap { margin-top: 1.1rem; }
    video { width: 100%; max-height: 70vh; border-radius: var(--radius-md); background: rgba(255, 255, 255, 0.8); }
    .filename { font-size: 0.85rem; color: var(--muted); margin-top: 0.4rem; word-break: break-all; }
    .audio-list { margin-top: 1.1rem; display: grid; gap: 0.75rem; }
    .audio-item { padding: 0.85rem 0.85rem 0.95rem; border-radius: var(--radius-md); border: 1px solid rgba(60, 45, 30, 0.12); background: rgba(255, 255, 255, 0.65); box-shadow: var(--shadow-soft); }
    audio { width: 100%; margin-top: 0.25rem; }

    @media (max-width: 480px) {
      .gallery { grid-template-columns: 1fr; }
      .gallery figcaption { word-break: break-word; }
      .filename { word-break: break-word; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="top-header">
      <div class="brand">FadeDrop</div>
      <p class="tagline">Temporary media links for images, video, and audio.</p>
    </header>
    <main class="card">
      <h1>Shared content</h1>
      ${expiresMetaHtml}
      ${mediaHtml}
      <p class="back-link"><a href="/">Back to upload</a></p>
    </main>
  </div>
</body>
</html>`);
});

app.post('/v/:id/password', (req, res) => {
  const { id } = req.params;
  const record = uploadsStore.find((r) => r.id === id && !r.deleted);

  if (!record) {
    return res.redirect('/v/' + encodeURIComponent(id));
  }

  if (!record.password) {
    return res.redirect('/v/' + encodeURIComponent(id));
  }

  const submitted = (req.body && req.body.password) || '';
  const trimmed = submitted.trim();
  if (!trimmed) {
    return res.redirect(`/v/${encodeURIComponent(id)}?error=invalid`);
  }

  try {
    const { salt, iterations, keylen, digest, hash } = record.password;
    const candidate = crypto
      .pbkdf2Sync(trimmed, salt, iterations, keylen, digest)
      .toString('hex');

    if (candidate !== hash) {
      return res.redirect(`/v/${encodeURIComponent(id)}?error=invalid`);
    }

    if (!record.passwordVersion) {
      record.passwordVersion = crypto.randomBytes(8).toString('hex');
    }

    setViewAuthCookie(res, record);
    return res.redirect('/v/' + encodeURIComponent(id));
  } catch (err) {
    console.error('Error verifying password for view:', err);
    return res.redirect(`/v/${encodeURIComponent(id)}?error=invalid`);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Temporary Media Links service is running on http://localhost:${PORT}`);
});

setInterval(() => {
  (uploadsStore || []).forEach((record) => {
    autoDeleteUploadIfNeeded(record);
  });
}, 30 * 1000);

server.on('error', (err) => {
  console.error('Failed to start server:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
