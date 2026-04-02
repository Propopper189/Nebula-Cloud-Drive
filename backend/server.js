const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;
const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const users = new Map(); // email -> { password }
const sessions = new Map(); // token -> email
const userFiles = new Map(); // email -> file records
const fileBlobs = new Map(); // fileId -> { buffer, mimeType, originalName }

function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.userEmail = sessions.get(token);
  next();
}

function ensureUserFiles(email) {
  if (!userFiles.has(email)) userFiles.set(email, []);
  return userFiles.get(email);
}

function purgeTrash(records) {
  const maxAgeMs = 15 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  return records.filter((item) => !(item.trashedAt && (now - new Date(item.trashedAt).getTime() > maxAgeMs)));
}

app.post('/api/auth/signup', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ message: 'Email and password (6+ chars) are required.' });
  }

  if (users.has(email)) {
    return res.status(409).json({ message: 'Account already exists.' });
  }

  users.set(email, { password });
  const token = crypto.randomUUID();
  sessions.set(token, email);
  ensureUserFiles(email);
  return res.json({ token, email });
});

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body || {};
  const user = users.get(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'Invalid credentials.' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, email);
  return res.json({ token, email });
});

app.post('/api/auth/signout', auth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  sessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/files', auth, (req, res) => {
  const files = purgeTrash(ensureUserFiles(req.userEmail));
  userFiles.set(req.userEmail, files);
  res.json({ files });
});

app.get('/api/files/shared', auth, (req, res) => {
  const shared = [];
  for (const [ownerEmail, records] of userFiles.entries()) {
    if (ownerEmail === req.userEmail) continue;
    for (const item of records) {
      if (!item.trashedAt && Array.isArray(item.sharedWith) && item.sharedWith.includes(req.userEmail)) {
        shared.push({ ...item, owner: ownerEmail });
      }
    }
  }
  res.json({ files: shared });
});

app.post('/api/files', auth, (req, res) => {
  const { name, type, size = 0, parentPath = '', sharedWith = [] } = req.body || {};
  if (!name || !type) return res.status(400).json({ message: 'name and type are required.' });

  const records = ensureUserFiles(req.userEmail);
  const used = records.filter((r) => !r.trashedAt).reduce((acc, item) => acc + (item.size || 0), 0);
  if (used + Number(size || 0) > STORAGE_LIMIT_BYTES) {
    return res.status(413).json({ message: 'Storage limit exceeded. Upgrade your plan or free up space.' });
  }
  const item = {
    id: crypto.randomUUID(),
    name: parentPath ? `${parentPath}/${name}` : name,
    type,
    size,
    modified: new Date().toISOString().slice(0, 10),
    sharedWith,
    trashedAt: null,
  };
  records.unshift(item);
  res.status(201).json(item);
});

app.post('/api/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'file is required.' });
  const parentPath = req.body?.parentPath || '';
  const records = ensureUserFiles(req.userEmail);
  const used = records.filter((r) => !r.trashedAt).reduce((acc, item) => acc + (item.size || 0), 0);
  if (used + req.file.size > STORAGE_LIMIT_BYTES) {
    return res.status(413).json({ message: 'Storage limit exceeded. Upgrade your plan or free up space.' });
  }

  const item = {
    id: crypto.randomUUID(),
    name: parentPath ? `${parentPath}/${req.file.originalname}` : req.file.originalname,
    type: 'file',
    size: req.file.size,
    modified: new Date().toISOString().slice(0, 10),
    sharedWith: [],
    trashedAt: null,
    mimeType: req.file.mimetype || 'application/octet-stream',
  };
  records.unshift(item);
  fileBlobs.set(item.id, {
    buffer: req.file.buffer,
    mimeType: item.mimeType,
    originalName: req.file.originalname,
  });
  res.status(201).json(item);
});

app.patch('/api/files/:id/trash', auth, (req, res) => {
  const records = ensureUserFiles(req.userEmail);
  const file = records.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });
  file.trashedAt = new Date().toISOString();
  res.json(file);
});

app.patch('/api/files/:id/share', auth, (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ message: 'Share email is required.' });
  if (!users.has(email)) return res.status(404).json({ message: 'Target user does not exist.' });
  if (email === req.userEmail) return res.status(400).json({ message: 'You already own this item.' });

  const records = ensureUserFiles(req.userEmail);
  const file = records.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });

  if (!file.sharedWith.includes(email)) file.sharedWith.push(email);
  res.json(file);
});

app.delete('/api/files/:id', auth, (req, res) => {
  const records = ensureUserFiles(req.userEmail);
  const index = records.findIndex((f) => f.id === req.params.id);
  if (index === -1) return res.status(404).json({ message: 'File not found.' });
  if (!records[index].trashedAt) {
    return res.status(400).json({ message: 'Only trashed files can be permanently deleted.' });
  }
  fileBlobs.delete(records[index].id);
  records.splice(index, 1);
  res.json({ ok: true });
});

app.get('/api/files/:id/download', auth, (req, res) => {
  let file = ensureUserFiles(req.userEmail).find((f) => f.id === req.params.id);
  if (!file) {
    for (const [ownerEmail, records] of userFiles.entries()) {
      if (ownerEmail === req.userEmail) continue;
      const maybe = records.find((f) => f.id === req.params.id && !f.trashedAt && f.sharedWith?.includes(req.userEmail));
      if (maybe) {
        file = maybe;
        break;
      }
    }
  }
  if (!file) return res.status(404).json({ message: 'File not found.' });
  if (file.type === 'folder') return res.status(400).json({ message: 'Folders cannot be downloaded.' });

  const blob = fileBlobs.get(file.id);
  if (!blob) return res.status(404).json({ message: 'Binary content not available for this file.' });
  res.setHeader('Content-Type', blob.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename=\"${encodeURIComponent(blob.originalName)}\"`);
  return res.send(blob.buffer);
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NebulaCloud server running on http://localhost:${PORT}`);
});
