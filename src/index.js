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

// Dev/test: always enable the 1-minute expiration shortcut.
// If you want to hide this in production, change this to read from process.env instead.
const ENABLE_TEST_EXPIRATION_SHORTCUT = true;

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
  <title>${title} • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 640px; margin: 0 auto; padding: 1.6rem 1.5rem 1.75rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(127,29,29,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.4rem; margin: 0 0 0.4rem; color: #fecaca; }
    p { margin: 0.25rem 0; color: #fca5a5; }
    a.button { display: inline-flex; margin-top: 1rem; padding: 0.6rem 1.1rem; border-radius: 999px; border: 1px solid rgba(248,113,113,0.7); color: #fee2e2; text-decoration: none; font-size: 0.9rem; }
    a.button:hover { background: rgba(127,29,29,0.8); }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="/upload" class="button">Back to upload</a>
  </main>
</body>
</html>`);
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const [rawName, ...rest] = part.split('=');
    if (!rawName) return acc;
    const name = rawName.trim();
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join('=') || '');
    return acc;
  }, {});
}

function getViewCookieName(uploadId) {
  return `tml_auth_${uploadId}`;
}

function setViewAuthCookie(res, record) {
  if (!record.passwordVersion) return;
  const cookieName = getViewCookieName(record.id);
  const value = encodeURIComponent(record.passwordVersion);
  const header = `${cookieName}=${value}; Path=/v/${record.id}; HttpOnly; SameSite=Lax`;
  res.setHeader('Set-Cookie', header);
}

app.get('/', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 2rem; background: #0f172a; color: #e5e7eb; }
    .card { max-width: 640px; margin: 0 auto; padding: 2rem; border-radius: 1rem; background: #020617; box-shadow: 0 25px 50px -12px rgba(15,23,42,0.8); border: 1px solid #1f2937; }
    h1 { font-size: 1.75rem; margin-bottom: 0.5rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    .status { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0.75rem; border-radius: 999px; background: rgba(22,163,74,0.1); color: #bbf7d0; font-size: 0.875rem; margin-top: 0.75rem; }
    .status-dot { width: 0.5rem; height: 0.5rem; border-radius: 999px; background: #22c55e; box-shadow: 0 0 0 4px rgba(34,197,94,0.35); }
    .actions { margin-top: 1.5rem; }
    .btn-primary { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; padding: 0.75rem 1.25rem; border-radius: 999px; border: none; background: linear-gradient(to right, #4f46e5, #06b6d4); color: white; font-weight: 600; text-decoration: none; cursor: pointer; box-shadow: 0 10px 25px -5px rgba(79,70,229,0.6); }
    .btn-primary:hover { filter: brightness(1.05); }
    .btn-primary:active { transform: translateY(1px); box-shadow: 0 4px 12px -4px rgba(15,23,42,0.7); }
  </style>
</head>
<body>
  <main class="card">
    <h1>Temporary Media Links</h1>
    <p>Ephemeral sharing for images, video, and audio.</p>
    <div class="status">
      <span class="status-dot"></span>
      <span>Service is running</span>
    </div>
    <div class="actions">
      <a class="btn-primary" href="/upload">Create a temporary link</a>
    </div>
  </main>
</body>
</html>`);
});

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
  <title>Invalid upload ID • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Invalid upload ID</h1>
    <p>The requested upload could not be found.</p>
    <p><a href="/">Back to Temporary Media Links</a></p>
  </main>
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
  <title>Unauthorized • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(127,29,29,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; color: #fecaca; }
    p { margin: 0.25rem 0; color: #fca5a5; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Unauthorized</h1>
    <p>Unauthorized  invalid dashboard key.</p>
    <p><a href="/">Back to Temporary Media Links</a></p>
  </main>
</body>
</html>`);
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiration?.expiresAt || record.createdAt || new Date().toISOString());
  const isExpired = Number.isFinite(expiresAtMs) ? now >= expiresAtMs : false;

  const createdAt = record.createdAt;
  const expiresAt = record.expiration?.expiresAt || 'n/a';

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

  const status = record.deleted
    ? 'Deleted'
    : isExpired
    ? 'Expired'
    : overViewLimit
    ? 'Over view limit'
    : 'Valid';

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
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Password removed. This upload is now accessible without a password.</p>';
  } else if (pwError === 'empty') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Password cannot be empty.</p>';
  } else if (pwError === 'current_required') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Current password is required to change it.</p>';
  } else if (pwError === 'current_invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Current password is incorrect.</p>';
  } else if (viewMessage === 'updated') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Max viewers updated.</p>';
  } else if (viewMessage === 'removed') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">View limit removed. This upload now has no maximum viewers.</p>';
  } else if (viewError === 'invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Please enter a positive whole number up to 100000 for max viewers.</p>';
  } else if (expMessage === 'extended') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Expiration extended successfully.</p>';
  } else if (expError === 'invalid') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Please choose a valid extension amount.</p>';
  } else if (expError === 'tooFar') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Expiration cannot be extended beyond 30 days from today.</p>';
  } else if (delMessage === 'deleted') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Upload deleted. Content is no longer available.</p>';
  } else if (delMessage === 'alreadyDeleted') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#9ca3af;">This upload was already deleted.</p>';
  } else if (delError === 'notfound') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">Upload not found for deletion.</p>';
  } else if (cdMessage === 'updated') {
    feedbackHtml = '<p style="margin-top:0.5rem;font-size:0.85rem;color:#bbf7d0;">Viewer countdown setting updated.</p>';
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
  <title>Upload dashboard • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 960px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.7rem; margin: 0 0 0.75rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    .layout { display: grid; gap: 1.25rem; margin-top: 1rem; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); }
    .section { padding: 1rem 1rem 1.1rem; border-radius: 0.9rem; background: rgba(15,23,42,0.96); border: 1px solid rgba(55,65,81,0.9); }
    .section h2 { margin: 0 0 0.4rem; font-size: 1rem; }
    .section p { font-size: 0.85rem; }
    dl.meta { margin: 0.35rem 0 0; display: grid; grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr); gap: 0.3rem 0.85rem; font-size: 0.85rem; }
    dl.meta dt { color: #9ca3af; }
    dl.meta dd { margin: 0; color: #e5e7eb; }
    table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.85rem; }
    th, td { padding: 0.4rem 0.45rem; text-align: left; border-bottom: 1px solid rgba(31,41,55,0.9); }
    th { color: #9ca3af; font-weight: 500; }
    tbody tr:last-child td { border-bottom: none; }
    .status-pill { display: inline-flex; align-items: center; padding: 0.15rem 0.6rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid rgba(55,65,81,0.9); }
    .status-valid { background: rgba(22,163,74,0.15); border-color: rgba(34,197,94,0.7); color: #bbf7d0; }
    .status-expired { background: rgba(248,113,113,0.08); border-color: rgba(248,113,113,0.9); color: #fecaca; }
    .status-deleted { background: rgba(148,163,184,0.1); color: #e5e7eb; }
    .pill { display: inline-flex; align-items: center; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; border: 1px solid rgba(75,85,99,0.9); color: #e5e7eb; }
    .back-link { margin-top: 1.25rem; font-size: 0.85rem; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 768px) {
      .layout { grid-template-columns: minmax(0, 1fr); }
    }
  </style>
</head>
<body>
  <main>
    <h1>Upload dashboard</h1>
    <p>Private dashboard for a single upload. Share this URL only with people you trust.</p>
    ${feedbackHtml}

    <div class="layout">
      <section class="section">
        <h2>Metadata</h2>
        <dl class="meta">
          <dt>Upload ID</dt>
          <dd>${record.id}</dd>
          <dt>Type</dt>
          <dd>${record.mediaType}</dd>
          <dt>Created at</dt>
          <dd>${createdAt}</dd>
          <dt>Expires at</dt>
          <dd>${expiresAt}</dd>
          <dt>Time remaining</dt>
          <dd>${timeRemainingLabel}</dd>
          <dt>Status</dt>
          <dd>
            <span class="status-pill ${
              status === 'Valid' ? 'status-valid' : status === 'Expired' ? 'status-expired' : 'status-deleted'
            }">${status}</span>
          </dd>
        </dl>
      </section>

      <section class="section">
        <h2>Viewer controls</h2>
        ${
          record.deleted
            ? '<p style="font-size:0.85rem;color:#fca5a5;margin:0 0 0.6rem;">This upload has been deleted. Content is no longer available. Viewer, password, and expiration controls are disabled.</p>'
            : '<div style="margin-bottom:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.9);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Expiration</h3>\n' +
              '  <p style="margin:0 0 0.35rem;font-size:0.8rem;color:#9ca3af;">Current expiration controls how long this link stays live. You can only extend it, up to 30 days from now.</p>\n' +
              '  <p style="margin:0 0 0.3rem;font-size:0.8rem;">Current expiration: <span style="color:#e5e7eb;">' +
              expiresAt +
              '</span></p>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;">Time remaining: <span style="color:#e5e7eb;">' +
              timeRemainingLabel +
              '</span></p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/expiration?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.4rem;max-width:260px;margin-top:0.35rem;">\n' +
              '    <label for="dashboard-extend-expiration" style="font-size:0.8rem;color:#e5e7eb;">Add expiration time</label>\n' +
              '    <select\n' +
              '      id="dashboard-extend-expiration"\n' +
              '      name="extendBy"\n' +
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.96);color:#e5e7eb;font-size:0.85rem;"\n' +
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
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:none;background:linear-gradient(to right,#0ea5e9,#22c55e);color:#fff;font-size:0.8rem;font-weight:600;cursor:pointer;justify-self:flex-start;">Extend expiration</button>\n' +
              '  </form>\n' +
              '</div>'
        }

        <p class="pill">Max viewers: ${maxViewsLabel}</p>
        <p style="margin-top:0.5rem; font-size:0.85rem;">Views: ${views}</p>
        ${
          overViewLimit && !record.deleted
            ? '<p style="margin-top:0.15rem;font-size:0.8rem;color:#fca5a5;">This upload has reached its max viewers. New visitors will see a view-limit message until you increase or remove the limit.</p>'
            : ''
        }
        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.9);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">View limit</h3>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;color:#9ca3af;">Optionally cap how many times this link can be viewed. Leave blank for no limit.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/views?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.35rem;max-width:260px;margin-bottom:0.8rem;">\n' +
              '    <input type="hidden" name="mode" value="set" />\n' +
              '    <label for="dashboard-max-views" style="font-size:0.8rem;color:#e5e7eb;">Max viewers</label>\n' +
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
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.96);color:#e5e7eb;font-size:0.85rem;"\n' +
              '    />\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:none;background:linear-gradient(to right,#0ea5e9,#22c55e);color:#fff;font-size:0.8rem;font-weight:600;cursor:pointer;justify-self:flex-start;">' +
              (maxViews && maxViews > 0 ? 'Change max viewers' : 'Set max viewers') +
              '</button>\n' +
              '  </form>\n' +
              (maxViews && maxViews > 0
                ? '  <form method="post" action="/dashboard/' +
                  record.id +
                  '/views?key=' +
                  encodeURIComponent(key) +
                  '" style="margin:0;">\n' +
                  '    <input type="hidden" name="mode" value="remove" />\n' +
                  '    <button type="submit" style="padding:0.35rem 0.9rem;border-radius:999px;border:1px solid rgba(148,163,184,0.7);background:transparent;color:#e5e7eb;font-size:0.75rem;cursor:pointer;">Remove view limit</button>\n' +
                  '  </form>\n'
                : '') +
              '</div>'
        }

        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.9);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Password protection</h3>\n' +
              '  <p style="margin:0 0 0.4rem;font-size:0.8rem;display:flex;align-items:center;gap:0.35rem;">\n' +
              '    <span class="pill" style="border-color:' +
              (record.password ? 'rgba(34,197,94,0.7)' : 'rgba(148,163,184,0.8)') +
              ';background:' +
              (record.password ? 'rgba(22,163,74,0.15)' : 'rgba(31,41,55,0.8)') +
              ';"><span style="font-size:0.8rem;">' +
              (record.password ? '🔐' : '🔓') +
              '</span> ' +
              passwordStatus +
              '</span>\n' +
              '  </p>\n' +
              '  <p style="margin:0.2rem 0 0.6rem;font-size:0.8rem;color:#9ca3af;">Use these controls to add, change, or remove the password for the public view link.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/password?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.4rem;max-width:260px;">\n' +
              '    <input type="hidden" name="mode" value="' +
              (record.password ? 'change' : 'set') +
              '" />\n' +
              (record.password
                ? '    <label for="dashboard-current-password" style="font-size:0.8rem;color:#e5e7eb;">Current password</label>\n' +
                  '    <input id="dashboard-current-password" name="currentPassword" type="password" autocomplete="current-password" style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.96);color:#e5e7eb;font-size:0.85rem;" />\n'
                : '') +
              '    <label for="dashboard-password" style="font-size:0.8rem;color:#e5e7eb;">' +
              (record.password ? 'New password' : 'Add password') +
              '</label>\n' +
              '    <input\n' +
              '      id="dashboard-password"\n' +
              '      name="password"\n' +
              '      type="password"\n' +
              '      autocomplete="new-password"\n' +
              '      style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.96);color:#e5e7eb;font-size:0.85rem;"\n' +
              '    />\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:none;background:linear-gradient(to right,#4f46e5,#06b6d4);color:#fff;font-size:0.8rem;font-weight:600;cursor:pointer;justify-self:flex-start;">' +
              (record.password ? 'Change password' : 'Set password') +
              '</button>\n' +
              '  </form>\n' +
              (record.password
                ? '  <form method="post" action="/dashboard/' +
                  record.id +
                  '/password?key=' +
                  encodeURIComponent(key) +
                  '" style="margin-top:0.75rem;display:grid;gap:0.35rem;max-width:260px;">\n' +
                  '    <input type="hidden" name="mode" value="remove" />\n' +
                  '    <label for="dashboard-remove-current" style="font-size:0.8rem;color:#e5e7eb;">Current password</label>\n' +
                  '    <input id="dashboard-remove-current" name="currentPassword" type="password" autocomplete="current-password" style="width:100%;padding:0.45rem 0.55rem;border-radius:0.55rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.96);color:#e5e7eb;font-size:0.85rem;" />\n' +
                  '    <button type="submit" style="padding:0.35rem 0.9rem;border-radius:999px;border:1px solid rgba(248,113,113,0.7);background:transparent;color:#fecaca;font-size:0.75rem;cursor:pointer;justify-self:flex-start;">Remove password</button>\n' +
                  '  </form>\n'
                : '') +
              '</div>'
        }

        ${
          record.deleted
            ? ''
            : '<div style="margin-top:0.85rem;padding:0.85rem 0.85rem 0.95rem;border-radius:0.75rem;border:1px solid rgba(55,65,81,0.9);background:rgba(15,23,42,0.9);">\n' +
              '  <h3 style="margin:0 0 0.4rem;font-size:0.9rem;">Viewer expiration countdown</h3>\n' +
              '  <p style="margin:0 0 0.5rem;font-size:0.8rem;color:#9ca3af;">You can choose whether viewers see how much time is left before this content expires.</p>\n' +
              '  <form method="post" action="/dashboard/' +
              record.id +
              '/countdown?key=' +
              encodeURIComponent(key) +
              '" style="display:grid;gap:0.35rem;max-width:260px;">\n' +
              '    <label style="font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;">\n' +
              '      <input type="radio" name="countdownMode" value="show" ' +
              (countdownVisible ? 'checked' : '') +
              ' />\n' +
              '      <span>Show expiration countdown to viewers</span>\n' +
              '    </label>\n' +
              '    <label style="font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;">\n' +
              '      <input type="radio" name="countdownMode" value="hide" ' +
              (countdownVisible ? '' : 'checked') +
              ' />\n' +
              '      <span>Do not show expiration countdown to viewers</span>\n' +
              '    </label>\n' +
              '    <button type="submit" style="margin-top:0.1rem;padding:0.45rem 1rem;border-radius:999px;border:none;background:linear-gradient(to right,#0ea5e9,#22c55e);color:#fff;font-size:0.8rem;font-weight:600;cursor:pointer;justify-self:flex-start;">Save setting</button>\n' +
              '  </form>\n' +
              '</div>'
        }
      </section>
    </div>

    <section class="section" style="margin-top:1.25rem;">
      <h2>Files</h2>
      <p>These are the files attached to this upload. File paths and internal identifiers are hidden.</p>
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
      <h2>Content management</h2>
      <p style="font-size:0.85rem;color:#9ca3af;">Use this section to permanently delete this upload. This cannot be undone.</p>
      ${
        record.deleted
          ? '<p style="margin-top:0.5rem;font-size:0.85rem;color:#fca5a5;">This upload has been deleted. All associated media was removed, and the view link now shows a deleted message.</p>'
          : '<form method="post" action="/dashboard/' +
            record.id +
            '/delete?key=' +
            encodeURIComponent(key) +
            '" onsubmit="return confirm(\'Are you sure you want to delete this upload? This action cannot be undone.\');" style="margin-top:0.75rem;">\n' +
            '  <button type="submit" style="padding:0.55rem 1.1rem;border-radius:999px;border:1px solid rgba(248,113,113,0.9);background:transparent;color:#fecaca;font-size:0.85rem;cursor:pointer;">Delete this upload</button>\n' +
            '</form>'
      }
    </section>

    <p class="back-link"><a href="/">Back to Temporary Media Links</a></p>
  </main>
</body>
</html>`);
});

app.get('/upload', (req, res) => {
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload • Temporary Media Links</title>
  <style>
    :root {
      color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.5rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: radial-gradient(circle at top left, rgba(56,189,248,0.15), transparent 55%), radial-gradient(circle at top right, rgba(129,140,248,0.2), transparent 55%), #020617; border: 1px solid rgba(148,163,184,0.3); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    header { margin-bottom: 1.5rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.25rem; }
    .subtitle { margin: 0; color: #9ca3af; font-size: 0.95rem; }
    form { display: grid; gap: 1.25rem; margin-top: 1rem; }
    .field-group { padding: 1rem 1rem 1.1rem; border-radius: 0.9rem; background: rgba(15,23,42,0.96); border: 1px solid rgba(55,65,81,0.9); }
    .field-label { font-size: 0.9rem; font-weight: 600; color: #e5e7eb; margin-bottom: 0.4rem; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
    .field-hint { font-size: 0.8rem; color: #9ca3af; }
    .required-pill, .optional-pill { font-size: 0.7rem; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid rgba(148,163,184,0.65); color: #e5e7eb; opacity: 0.9; }
    .optional-pill { opacity: 0.75; }
    .media-options { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.25rem; }
    .media-option { position: relative; }
    .media-option input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
    .media-chip { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.4rem 0.75rem; border-radius: 999px; border: 1px solid rgba(55,65,81,0.9); background: rgba(15,23,42,0.9); font-size: 0.85rem; color: #e5e7eb; }
    .media-chip span.icon { font-size: 0.9rem; opacity: 0.9; }
    .media-option input:checked + .media-chip { border-color: #4f46e5; box-shadow: 0 0 0 1px rgba(79,70,229,0.7), 0 10px 25px -10px rgba(79,70,229,0.8); background: radial-gradient(circle at top left, rgba(79,70,229,0.45), rgba(15,23,42,0.95)); }
    .file-input-group { display: grid; gap: 0.5rem; margin-top: 0.5rem; }
    input[type="file"] { font-size: 0.85rem; color: #e5e7eb; }
    .selected-files { list-style: none; padding: 0; margin: 0.4rem 0 0; display: grid; gap: 0.3rem; font-size: 0.8rem; }
    .selected-files li { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.25rem 0.4rem; border-radius: 0.4rem; background: rgba(15,23,42,0.9); border: 1px solid rgba(31,41,55,0.9); }
    .selected-files span.name { flex: 1 1 auto; word-break: break-all; color: #e5e7eb; }
    .selected-files span.meta { flex-shrink: 0; color: #9ca3af; }
    .selected-files button.remove { flex-shrink: 0; border: none; background: transparent; color: #fca5a5; font-size: 0.75rem; cursor: pointer; padding: 0.15rem 0.35rem; border-radius: 0.35rem; }
    .selected-files button.remove:hover { background: rgba(127,29,29,0.4); }
    input[type="number"], input[type="password"], select { width: 100%; padding: 0.5rem 0.6rem; border-radius: 0.55rem; border: 1px solid rgba(55,65,81,0.9); background: rgba(15,23,42,0.96); color: #e5e7eb; font-size: 0.9rem; }
    input[type="number"]:focus, input[type="password"]:focus, select:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 1px rgba(99,102,241,0.8); }
    .expiration-row { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.35rem; align-items: center; }
    .expiration-row > * { flex: 1 1 120px; }
    .expiration-meta { font-size: 0.8rem; color: #9ca3af; margin-top: 0.4rem; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: flex-end; margin-top: 0.5rem; }
    .btn-primary { padding: 0.7rem 1.4rem; border-radius: 999px; border: none; background: linear-gradient(to right, #4f46e5, #06b6d4); color: white; font-weight: 600; font-size: 0.95rem; cursor: pointer; display: inline-flex; align-items: center; gap: 0.35rem; box-shadow: 0 16px 35px -18px rgba(15,23,42,0.9); }
    .btn-primary:hover { filter: brightness(1.05); }
    .btn-secondary { padding: 0.6rem 1rem; border-radius: 999px; border: 1px solid rgba(148,163,184,0.6); background: transparent; color: #e5e7eb; font-size: 0.85rem; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 0.3rem; }
    .btn-secondary:hover { background: rgba(15,23,42,0.9); }
    @media (max-width: 640px) {
      main { padding: 1.25rem 1rem 1.5rem; }
      h1 { font-size: 1.35rem; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p style="font-size:0.8rem;color:#9ca3af;margin:0 0 0.35rem;">Temporary Media Links</p>
      <h1>Create a temporary media link</h1>
      <p class="subtitle">Choose what you're sharing, how long it should live, and optionally protect it with a password.</p>
    </header>

    <form action="/upload" method="post" enctype="multipart/form-data">
      <section class="field-group">
        <div class="field-label">
          <span>Media type</span>
          <span class="required-pill">Required</span>
        </div>
        <p class="field-hint">Select what kind of content you're uploading for this link.</p>
        <div class="media-options" aria-label="Media type">
          <label class="media-option">
            <input type="radio" name="mediaType" value="images" checked />
            <span class="media-chip"><span class="icon">🖼️</span><span>Images</span></span>
          </label>
          <label class="media-option">
            <input type="radio" name="mediaType" value="video" />
            <span class="media-chip"><span class="icon">📹</span><span>Video</span></span>
          </label>
          <label class="media-option">
            <input type="radio" name="mediaType" value="audio" />
            <span class="media-chip"><span class="icon">🎧</span><span>Audio</span></span>
          </label>
        </div>
      </section>

      <section class="field-group">
        <div class="field-label">
          <span>Files</span>
          <span class="required-pill">Required</span>
        </div>
        <div class="file-input-group" id="file-inputs">
          <div data-media="images">
            <p class="field-hint">Upload up to 10 images (up to ~15MB each). Limits will be enforced in a later step.</p>
            <input type="file" id="images-input" accept="image/*" multiple />
            <input type="file" id="images-hidden" name="images" accept="image/*" multiple style="display:none;" />
            <ul class="selected-files" id="images-list"></ul>
            <p class="field-hint" id="images-warning" style="display:none;color:#fca5a5;">You can upload up to 10 images per upload.</p>
          </div>
          <div data-media="video" style="display:none;">
            <p class="field-hint">Upload a single video file for this link.</p>
            <input type="file" id="video-input" accept="video/*" />
            <input type="file" id="video-hidden" name="video" accept="video/*" style="display:none;" />
            <ul class="selected-files" id="video-list"></ul>
          </div>
          <div data-media="audio" style="display:none;">
            <p class="field-hint">Upload up to 2 audio files for this link.</p>
            <input type="file" id="audio-input" accept="audio/*" multiple />
            <input type="file" id="audio-hidden" name="audio" accept="audio/*" multiple style="display:none;" />
            <ul class="selected-files" id="audio-list"></ul>
            <p class="field-hint" id="audio-warning" style="display:none;color:#fca5a5;">You can upload up to 2 audio files per upload.</p>
          </div>
        </div>
      </section>

      <section class="field-group">
        <div class="field-label">
          <span>Expiration</span>
          <span class="required-pill">Required</span>
        </div>
        <p class="field-hint">Choose how long this link should stay live. Actual limits (1 hour  30 days) will be enforced in a later step.</p>
        <div class="expiration-row">
          <input type="number" id="expiresValue" name="expiresValue" min="1" max="30" value="24" />
          <select id="expiresUnit" name="expiresUnit">
            <option value="hours" selected>Hours</option>
            <option value="days">Days</option>
          </select>
        </div>
        <p class="expiration-meta">Valid for at least 1 hour and up to 30 days.</p>
        ${
          ENABLE_TEST_EXPIRATION_SHORTCUT
            ? '<p class="expiration-meta" style="margin-top:0.3rem;color:#a5b4fc;">Test shortcut enabled: use the button below to set a 1-minute expiration (dev only).</p>\n' +
              '<button type="button" id="test-expiration-minute" style="margin-top:0.35rem;padding:0.25rem 0.7rem;border-radius:999px;border:1px solid rgba(129,140,248,0.8);background:transparent;color:#c7d2fe;font-size:0.75rem;cursor:pointer;">1 minute (test only)</button>'
            : ''
        }
      </section>

      <section class="field-group">
        <div class="field-label">
          <span>Password</span>
          <span class="optional-pill">Optional</span>
        </div>
        <p class="field-hint">Add a password to protect access to this link. You will share it alongside the URL.</p>
        <input type="password" name="password" autocomplete="new-password" placeholder="Leave blank for no password" />
      </section>

      <div class="actions">
        <a class="btn-secondary" href="/">
          <span>Back to status</span>
        </a>
        <button type="submit" class="btn-primary">
          <span>Create link</span>
        </button>
      </div>
    </form>
  </main>

  <script>
    const mediaInputs = document.querySelectorAll('input[name="mediaType"]');
    const fileGroups = document.querySelectorAll('#file-inputs [data-media]');

    const visibleInputs = {
      images: document.getElementById('images-input'),
      video: document.getElementById('video-input'),
      audio: document.getElementById('audio-input'),
    };

    const hiddenInputs = {
      images: document.getElementById('images-hidden'),
      video: document.getElementById('video-hidden'),
      audio: document.getElementById('audio-hidden'),
    };

    const lists = {
      images: document.getElementById('images-list'),
      video: document.getElementById('video-list'),
      audio: document.getElementById('audio-list'),
    };

    const warnings = {
      images: document.getElementById('images-warning'),
      audio: document.getElementById('audio-warning'),
    };

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

    function updateFileInputs() {
      const selected = document.querySelector('input[name="mediaType"]:checked');
      if (!selected) return;
      const value = selected.value;
      fileGroups.forEach((group) => {
        const isActive = group.getAttribute('data-media') === value;
        group.style.display = isActive ? '' : 'none';
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
      const list = lists[type];
      if (!list) return;
      const files = state[type] || [];
      list.innerHTML = '';
      files.forEach((file, index) => {
        const li = document.createElement('li');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'name';
        nameSpan.textContent = file.name || '(unnamed file)';
        const metaSpan = document.createElement('span');
        metaSpan.className = 'meta';
        metaSpan.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'remove';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', () => {
          state[type].splice(index, 1);
          syncHiddenInput(type);
          renderList(type);
          if (warnings[type]) warnings[type].style.display = 'none';
        });
        li.appendChild(nameSpan);
        li.appendChild(metaSpan);
        li.appendChild(removeBtn);
        list.appendChild(li);
      });
    }

    function handleFilesAdded(type, fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      const max = state.max[type];
      if (!max) return;

      if (type === 'video') {
        // Single-file: replace previous selection (no effective duplicates)
        state.video = files.length ? [files[0]] : [];
        syncHiddenInput('video');
        renderList('video');
        return;
      }

      const current = state[type] || [];
      let addedAny = false;
      files.forEach((file) => {
        const isDuplicate = current.some((existing) => {
          return (
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified
          );
        });
        if (isDuplicate) {
          return;
        }
        if (current.length >= max) {
          return;
        }
        current.push(file);
        addedAny = true;
      });

      state[type] = current;
      syncHiddenInput(type);
      renderList(type);

      if (!addedAny || state[type].length >= max) {
        if (warnings[type]) warnings[type].style.display = 'block';
      } else if (warnings[type]) {
        warnings[type].style.display = 'none';
      }
    }

    mediaInputs.forEach((input) => {
      input.addEventListener('change', () => {
        updateFileInputs();
      });
    });

    if (visibleInputs.images) {
      visibleInputs.images.addEventListener('change', (event) => {
        handleFilesAdded('images', event.target.files);
        event.target.value = '';
      });
    }

    if (visibleInputs.audio) {
      visibleInputs.audio.addEventListener('change', (event) => {
        handleFilesAdded('audio', event.target.files);
        event.target.value = '';
      });
    }

    if (visibleInputs.video) {
      visibleInputs.video.addEventListener('change', (event) => {
        handleFilesAdded('video', event.target.files);
        event.target.value = '';
      });
    }

    const testExpirationButton = document.getElementById('test-expiration-minute');
    if (testExpirationButton) {
      testExpirationButton.addEventListener('click', () => {
        const expiresValueInput = document.getElementById('expiresValue');
        const expiresUnitSelect = document.getElementById('expiresUnit');
        if (expiresValueInput && expiresUnitSelect) {
          expiresValueInput.value = '1';
          const option = Array.from(expiresUnitSelect.options).find((opt) => opt.value === 'minutes');
          if (!option) {
            const minutesOption = document.createElement('option');
            minutesOption.value = 'minutes';
            minutesOption.textContent = 'Minutes (test only)';
            expiresUnitSelect.appendChild(minutesOption);
          }
          expiresUnitSelect.value = 'minutes';
        }
      });
    }

    updateFileInputs();
  </script>
</body>
</html>`);
});

app.post(
  '/upload',
  upload.fields([
    { name: 'images', maxCount: 10 },
    { name: 'video', maxCount: 1 },
    { name: 'audio', maxCount: 2 },
  ]),
  (req, res) => {
    let filesMeta = [];
    try {
      const { mediaType, expiresValue, expiresUnit, password } = req.body;

      filesMeta = Object.keys(req.files || {}).flatMap((field) => {
        return (req.files?.[field] || []).map((f) => ({
          fieldName: field,
          storedFilename: f.filename,
          storedPath: f.path,
          originalFilename: f.originalname,
          mimeType: f.mimetype,
          size: f.size,
        }));
      });

      if (!filesMeta.length) {
        console.warn('Upload attempt with no files received.', {
          mediaType,
          expiresValue,
          expiresUnit,
        });

        deleteStoredFiles(filesMeta);
        return sendValidationError(res, 'Upload failed', 'No files were uploaded. Please attach file(s) and try again.');
      }

      const normalizedType = mediaType === 'images' || mediaType === 'video' || mediaType === 'audio' ? mediaType : null;
      if (!normalizedType) {
        console.warn('Invalid media type received:', mediaType);
        deleteStoredFiles(filesMeta);
        return sendValidationError(res, 'Upload failed', 'Invalid media type. Please choose images, video, or audio.');
      }

      const filesForType = filesMeta.filter((f) => f.fieldName === normalizedType);

      if (normalizedType === 'images') {
        if (filesForType.length < 1 || filesForType.length > 10) {
          console.warn('Image file count validation failed:', filesForType.length);
          deleteStoredFiles(filesMeta);
          return sendValidationError(res, 'Upload failed', 'For images, you can upload between 1 and 10 files.');
        }
      } else if (normalizedType === 'video') {
        if (filesForType.length !== 1) {
          console.warn('Video file count validation failed:', filesForType.length);
          deleteStoredFiles(filesMeta);
          return sendValidationError(res, 'Upload failed', 'For video, you must upload exactly one file.');
        }
      } else if (normalizedType === 'audio') {
        if (filesForType.length < 1 || filesForType.length > 2) {
          console.warn('Audio file count validation failed:', filesForType.length);
          deleteStoredFiles(filesMeta);
          return sendValidationError(res, 'Upload failed', 'For audio, you can upload between 1 and 2 files.');
        }
      }

      const MB = 1024 * 1024;
      const sizeLimits = {
        images: 15 * MB,
        video: 500 * MB,
        audio: 50 * MB,
      };

      const limitForType = sizeLimits[normalizedType];
      const tooLarge = filesForType.find((f) => f.size > limitForType);
      if (tooLarge) {
        console.warn('File size validation failed for', normalizedType, 'size(bytes)=', tooLarge.size);
        deleteStoredFiles(filesMeta);
        const messages = {
          images: 'One or more images exceed the 15 MB limit.',
          video: 'The video exceeds the 500 MB limit.',
          audio: 'One or more audio files exceed the 50 MB limit.',
        };
        return sendValidationError(res, 'Upload failed', messages[normalizedType]);
      }

      const allowedByType = {
        images: {
          mime: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
          ext: ['.jpg', '.jpeg', '.png', '.gif', '.webp'],
        },
        video: {
          mime: ['video/mp4', 'video/webm', 'video/quicktime'],
          ext: ['.mp4', '.webm', '.mov'],
        },
        audio: {
          mime: ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/m4a'],
          ext: ['.mp3', '.wav', '.m4a', '.aac'],
        },
      };

      const rules = allowedByType[normalizedType];
      const invalidTypeFile = filesForType.find((f) => {
        const ext = path.extname(f.originalFilename || '').toLowerCase();
        return !rules.mime.includes(f.mimeType) && !rules.ext.includes(ext);
      });

      if (invalidTypeFile) {
        console.warn('File type validation failed for', normalizedType, 'file=', invalidTypeFile.originalFilename, 'mime=', invalidTypeFile.mimeType);
        deleteStoredFiles(filesMeta);
        const messages = {
          images: 'Unsupported file type for images.',
          video: 'Unsupported file type for video.',
          audio: 'Unsupported file type for audio.',
        };
        return sendValidationError(res, 'Upload failed', messages[normalizedType]);
      }

      const numericValue = parseInt(expiresValue, 10);
      if (Number.isNaN(numericValue) || numericValue <= 0) {
        console.warn('Expiration value is invalid:', expiresValue, expiresUnit);
        deleteStoredFiles(filesMeta);
        return sendValidationError(res, 'Upload failed', 'Expiration must be between 1 hour and 30 days.');
      }

      let durationMs;
      if (expiresUnit === 'hours') {
        durationMs = numericValue * 60 * 60 * 1000;
      } else if (expiresUnit === 'days') {
        durationMs = numericValue * 24 * 60 * 60 * 1000;
      } else if (ENABLE_TEST_EXPIRATION_SHORTCUT && expiresUnit === 'minutes') {
        // Dev/test-only shortcut: allow exactly 1 minute expiration when enabled via env flag
        if (numericValue !== 1) {
          console.warn('Test expiration shortcut used with unsupported value:', numericValue, expiresUnit);
          deleteStoredFiles(filesMeta);
          return sendValidationError(res, 'Upload failed', 'For the 1 minute test option, expiration must be exactly 1 minute.');
        }
        durationMs = numericValue * 60 * 1000;
      } else {
        console.warn('Expiration unit is invalid:', expiresUnit);
        deleteStoredFiles(filesMeta);
        return sendValidationError(res, 'Upload failed', 'Expiration must be between 1 hour and 30 days.');
      }

      const minMs = ENABLE_TEST_EXPIRATION_SHORTCUT && expiresUnit === 'minutes' ? 1 * 60 * 1000 : 1 * 60 * 60 * 1000;
      const maxMs = 30 * 24 * 60 * 60 * 1000;
      if (durationMs < minMs || durationMs > maxMs) {
        console.warn('Expiration range validation failed. Duration(ms)=', durationMs);
        deleteStoredFiles(filesMeta);
        return sendValidationError(res, 'Upload failed', 'Expiration must be between 1 hour and 30 days.');
      }

      const createdAtDate = new Date();
      const createdAt = createdAtDate.toISOString();
      const expiresAt = new Date(createdAtDate.getTime() + durationMs).toISOString();
      const autoDeleteAt = new Date(createdAtDate.getTime() + durationMs + GRACE_PERIOD_MS).toISOString();

      let passwordHash = null;
      if (password && password.trim().length > 0) {
        const salt = crypto.randomBytes(16).toString('hex');
        const iterations = 100000;
        const keylen = 64;
        const digest = 'sha512';
        const hash = crypto
          .pbkdf2Sync(password, salt, iterations, keylen, digest)
          .toString('hex');
        passwordHash = {
          algorithm: 'pbkdf2',
          iterations,
          keylen,
          digest,
          salt,
          hash,
        };
      }

      const uploadId = crypto.randomBytes(10).toString('hex');
      const dashboardKey = crypto.randomBytes(12).toString('base64url').slice(0, 16);
      const passwordVersion = passwordHash ? crypto.randomBytes(8).toString('hex') : null;

      const record = {
        id: uploadId,
        mediaType: normalizedType,
        files: filesMeta,
        expiration: {
          value: numericValue,
          unit: expiresUnit,
          durationMs,
          expiresAt,
          autoDeleteAt,
        },
        password: passwordHash,
        createdAt,
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

      console.log('--- Upload stored ---');
      console.log('Upload record:', record);

      const totalFiles = filesMeta.length;
      const originalNames = filesMeta.map((f) => f.originalFilename).join(', ');

      const viewPath = `/v/${uploadId}`;
      const viewUrl = `${req.protocol}://${req.get('host')}${viewPath}`;
      const dashboardPath = `/dashboard/${uploadId}?key=${encodeURIComponent(dashboardKey)}`;
      const dashboardUrl = `${req.protocol}://${req.get('host')}${dashboardPath}`;

      res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload received • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 640px; margin: 0 auto; padding: 1.6rem 1.5rem 1.75rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    dl { margin: 1rem 0 0.5rem; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 0.4rem 1rem; font-size: 0.9rem; }
    dt { color: #9ca3af; }
    dd { margin: 0; color: #e5e7eb; }
    .actions { margin-top: 1.25rem; display: flex; flex-wrap: wrap; gap: 0.75rem; justify-content: flex-end; }
    a.button { padding: 0.6rem 1.1rem; border-radius: 999px; border: 1px solid rgba(148,163,184,0.7); color: #e5e7eb; text-decoration: none; font-size: 0.9rem; display: inline-flex; align-items: center; gap: 0.35rem; }
    a.button:hover { background: rgba(15,23,42,0.9); }
  </style>
</head>
<body>
  <main>
    <h1>Upload stored successfully</h1>
    <p>Your files and settings have been stored on the server. Links and dashboards will be added in a later step.</p>
    <dl>
      <dt>Upload ID</dt>
      <dd>${uploadId}</dd>
      <dt>View link</dt>
      <dd><a href="${viewPath}">${viewUrl}</a></dd>
      <dt>Dashboard link</dt>
      <dd><a href="${dashboardPath}">${dashboardUrl}</a></dd>
      <dt>Media type</dt>
      <dd>${normalizedType}</dd>
      <dt>Expiration</dt>
      <dd>${numericValue} ${expiresUnit}</dd>
      <dt>Password</dt>
      <dd>${passwordHash ? 'Provided' : 'Not provided'}</dd>
      <dt>Files</dt>
      <dd>${totalFiles} file(s)</dd>
      <dt>Original filenames</dt>
      <dd>${originalNames || 'n/a'}</dd>
    </dl>
    <div class="actions">
      <a href="/upload" class="button">New upload</a>
      <a href="/" class="button">Back to start</a>
    </div>
  </main>
</body>
</html>`);
    } catch (err) {
      console.error('Error handling upload:', err);

      res.status(500).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Upload failed • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 640px; margin: 0 auto; padding: 1.6rem 1.5rem 1.75rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(127,29,29,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.4rem; margin: 0 0 0.4rem; color: #fecaca; }
    p { margin: 0.25rem 0; color: #fca5a5; }
    a.button { display: inline-flex; margin-top: 1rem; padding: 0.6rem 1.1rem; border-radius: 999px; border: 1px solid rgba(248,113,113,0.7); color: #fee2e2; text-decoration: none; font-size: 0.9rem; }
    a.button:hover { background: rgba(127,29,29,0.8); }
  </style>
</head>
<body>
  <main>
    <h1>Upload failed</h1>
    <p>Something went wrong while storing your upload. Please try again later.</p>
    <a href="/upload" class="button">Back to upload</a>
  </main>
</body>
</html>`);
    }
  }
);

app.get('/v/:id', (req, res) => {
  const { id } = req.params;
  const record = uploadsStore.find((r) => r.id === id);

  console.log('View access', {
    uploadId: id,
    at: new Date().toISOString(),
    found: !!record,
  });

  if (!record) {
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Content not found • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Content not found</h1>
    <p>This link is invalid or the content is no longer available.</p>
    <p><a href="/">Go back to Temporary Media Links</a></p>
  </main>
</body>
</html>`);
  }

  if (record.deleted) {
    return res.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Content deleted • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>This content has been deleted by the uploader.</h1>
    <p><a href="/">Go back to Temporary Media Links</a></p>
  </main>
</body>
</html>`);
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(record.expiration?.expiresAt || record.createdAt || new Date().toISOString());
  const isExpired = Number.isFinite(expiresAtMs) ? now >= expiresAtMs : false;
  const isDeleted = !!record.deleted;

  if (isExpired) {
    return res.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Content not available • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>This content has expired</h1>
    <p>The link you tried to open is no longer available.</p>
    <p><a href="/">Go back to Temporary Media Links</a></p>
    <p><a href="/dashboard/${record.id}?key=${encodeURIComponent(record.dashboardKey)}">Extend expiration date</a></p>
  </main>
</body>
</html>`);
  }

  const currentViews = Number.isFinite(record.viewCount) ? record.viewCount : 0;
  const maxViews = Number.isInteger(record.maxViews) && record.maxViews > 0 ? record.maxViews : null;

  if (maxViews !== null && currentViews >= maxViews) {
    return res.status(410).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>View limit reached • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>View limit reached</h1>
    <p>This content is no longer available because the maximum view limit has been reached.</p>
    <p><a href="/">Go back to Temporary Media Links</a></p>
  </main>
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
  <title>Unable to display content • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 720px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(127,29,29,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.4rem; color: #fecaca; }
    p { margin: 0.25rem 0; color: #fca5a5; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Unable to display content</h1>
    <p>This upload record does not contain any files that can be shown.</p>
    <p><a href="/">Go back to Temporary Media Links</a></p>
  </main>
</body>
</html>`);
  }

  const requiresPassword = !!record.password;

  if (requiresPassword) {
    const cookies = parseCookies(req);
    const expected = record.passwordVersion;
    const cookieName = getViewCookieName(record.id);
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
  <title>Protected link • Temporary Media Links</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 480px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    form { margin-top: 1rem; display: grid; gap: 0.6rem; }
    label { font-size: 0.85rem; color: #e5e7eb; }
    input[type="password"] { width: 100%; padding: 0.5rem 0.6rem; border-radius: 0.55rem; border: 1px solid rgba(55,65,81,0.9); background: rgba(15,23,42,0.96); color: #e5e7eb; font-size: 0.9rem; }
    input[type="password"]:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 1px rgba(99,102,241,0.8); }
    button { padding: 0.6rem 1.2rem; border-radius: 999px; border: none; background: linear-gradient(to right, #4f46e5, #06b6d4); color: white; font-weight: 600; font-size: 0.9rem; cursor: pointer; justify-self: flex-start; }
    button:hover { filter: brightness(1.05); }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <h1>Password required</h1>
    <p>This link is protected. Enter the password to view the content.</p>
    ${errorHtml}
    <form method="post" action="/v/${record.id}/password">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required />
      <button type="submit">Unlock</button>
    </form>
    <p style="margin-top:1rem;font-size:0.85rem;"><a href="/">Back to Temporary Media Links</a></p>
  </main>
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

  const pageTitle = `View ${titleByType[type] || 'content'} • Temporary Media Links`;

  const countdownVisibleForView = record.countdownVisible !== false;
  let expiresInText = '';
  if (countdownVisibleForView && Number.isFinite(expiresAtMs) && !isExpired && maxViews !== null ? currentViews < maxViews : true) {
    const diff = expiresAtMs - now;
    if (diff > 0) {
      const minutes = Math.round(diff / (60 * 1000));
      const hours = Math.floor(minutes / 60);
      const days = Math.floor(hours / 24);

      if (days >= 1) {
        const remHours = hours - days * 24;
        if (remHours > 0) {
          expiresInText = `Expires in ${days} day${days === 1 ? '' : 's'}, ${remHours} hour${remHours === 1 ? '' : 's'}`;
        } else {
          expiresInText = `Expires in ${days} day${days === 1 ? '' : 's'}`;
        }
      } else if (hours >= 1) {
        const remMinutes = minutes - hours * 60;
        if (remMinutes > 0) {
          expiresInText = `Expires in ${hours} hour${hours === 1 ? '' : 's'}, ${remMinutes} minute${remMinutes === 1 ? '' : 's'}`;
        } else {
          expiresInText = `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
        }
      } else {
        const mins = Math.max(1, minutes);
        expiresInText = `Expires in ${mins} minute${mins === 1 ? '' : 's'}`;
      }
    }
  }

  const expiresMetaHtml = expiresInText
    ? `<p class="meta">${expiresInText}</p>`
    : '';

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
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 1.75rem; background: #020617; color: #e5e7eb; }
    main { max-width: 960px; margin: 0 auto; padding: 1.75rem 1.5rem 2rem; border-radius: 1.25rem; background: #020617; border: 1px solid rgba(55,65,81,0.9); box-shadow: 0 25px 50px -24px rgba(15,23,42,0.9); }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem; }
    p { margin: 0.25rem 0; color: #9ca3af; }
    .meta { font-size: 0.8rem; color: #6b7280; margin-bottom: 1rem; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-top: 1.25rem; }
    .gallery .item { background: #020617; border-radius: 0.75rem; border: 1px solid rgba(55,65,81,0.9); padding: 0.5rem; }
    .gallery img { width: 100%; height: auto; border-radius: 0.5rem; display: block; background: #020617; }
    .gallery figcaption { margin-top: 0.35rem; font-size: 0.8rem; color: #9ca3af; word-break: break-all; }
    .player-wrap { margin-top: 1.25rem; }
    video { width: 100%; max-height: 70vh; border-radius: 0.75rem; background: #020617; }
    .filename { font-size: 0.85rem; color: #9ca3af; margin-top: 0.4rem; word-break: break-all; }
    .audio-list { margin-top: 1.25rem; display: grid; gap: 0.75rem; }
    .audio-item { padding: 0.75rem 0.75rem 0.85rem; border-radius: 0.75rem; border: 1px solid rgba(55,65,81,0.9); background: #020617; }
    audio { width: 100%; margin-top: 0.25rem; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back-link { margin-top: 1.25rem; font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>Shared media</h1>
    <p class="meta">Upload ID: ${record.id} • Type: ${record.mediaType}</p>
    ${expiresMetaHtml}
    ${mediaHtml}
    <p class="back-link"><a href="/">Back to Temporary Media Links</a></p>
  </main>
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

server.on('error', (err) => {
  console.error('Failed to start server:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
