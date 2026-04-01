const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const users = new Map(); // email -> { password }
const sessions = new Map(); // token -> email
const userFiles = new Map(); // email -> file records

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

app.post('/api/files', auth, (req, res) => {
  const { name, type, size = 0, parentPath = '', sharedWith = [] } = req.body || {};
  if (!name || !type) return res.status(400).json({ message: 'name and type are required.' });

  const records = ensureUserFiles(req.userEmail);
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

  const records = ensureUserFiles(req.userEmail);
  const file = records.find((f) => f.id === req.params.id);
  if (!file) return res.status(404).json({ message: 'File not found.' });

  if (!file.sharedWith.includes(email)) file.sharedWith.push(email);
  res.json(file);
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NebulaCloud server running on http://localhost:${PORT}`);
});
