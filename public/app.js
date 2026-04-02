const API = '/api';
const LIMIT = 10 * 1024 * 1024 * 1024;
const IS_FILE_MODE = location.protocol === 'file:';

const state = {
  mode: 'signin',
  token: localStorage.getItem('nebula_token') || '',
  user: localStorage.getItem('nebula_user') || '',
  files: [],
  sharedFiles: [],
  section: 'drive',
  selectedId: null,
};
const localBlobMap = new Map();

const localKey = {
  users: 'nebula_local_users',
  session: 'nebula_local_session',
  files: (email) => `nebula_local_files_${email}`,
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(2)} MB`;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.style.display = 'none', 2500);
}

async function api(path, options = {}) {
  if (IS_FILE_MODE) return localApi(path, options);
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  try {
    const res = await fetch(`${API}${path}`, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || 'Request failed');
    return body;
  } catch (error) {
    // Graceful fallback when backend is not running.
    return localApi(path, options);
  }
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}

function localApi(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const body = options.body ? JSON.parse(options.body) : {};
  const users = readJson(localKey.users, []);
  const localSession = readJson(localKey.session, null);
  const sessionEmail = state.user || localSession?.email;
  const files = sessionEmail ? readJson(localKey.files(sessionEmail), []) : [];

  const saveUsers = (value) => localStorage.setItem(localKey.users, JSON.stringify(value));
  const saveFiles = (value) => sessionEmail && localStorage.setItem(localKey.files(sessionEmail), JSON.stringify(value));

  if (path === '/auth/signup' && method === 'POST') {
    if (users.some((u) => u.email === body.email)) throw new Error('Account already exists.');
    users.push({ email: body.email, password: body.password });
    saveUsers(users);
    localStorage.setItem(localKey.session, JSON.stringify({ email: body.email, token: crypto.randomUUID() }));
    return { email: body.email, token: crypto.randomUUID() };
  }

  if (path === '/auth/signin' && method === 'POST') {
    const user = users.find((u) => u.email === body.email && u.password === body.password);
    if (!user) throw new Error('Invalid credentials.');
    const token = crypto.randomUUID();
    localStorage.setItem(localKey.session, JSON.stringify({ email: body.email, token }));
    return { email: body.email, token };
  }

  if (path === '/auth/signout' && method === 'POST') {
    localStorage.removeItem(localKey.session);
    return { ok: true };
  }

  if (path === '/files' && method === 'GET') {
    const maxAgeMs = 15 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const clean = files.filter((item) => !(item.trashedAt && now - new Date(item.trashedAt).getTime() > maxAgeMs));
    saveFiles(clean);
    return { files: clean };
  }

  if (path === '/files/shared' && method === 'GET') {
    const shared = [];
    for (const user of users) {
      if (user.email === sessionEmail) continue;
      const ownerFiles = readJson(localKey.files(user.email), []);
      ownerFiles.forEach((item) => {
        if (!item.trashedAt && item.sharedWith?.includes(sessionEmail)) {
          shared.push({ ...item, owner: user.email });
        }
      });
    }
    return { files: shared };
  }

  if (path === '/files' && method === 'POST') {
    const item = {
      id: crypto.randomUUID(),
      name: body.parentPath ? `${body.parentPath}/${body.name}` : body.name,
      type: body.type,
      size: body.size || 0,
      modified: new Date().toISOString().slice(0, 10),
      sharedWith: body.sharedWith || [],
      trashedAt: null,
    };
    files.unshift(item);
    saveFiles(files);
    return item;
  }

  if (path.includes('/trash') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    item.trashedAt = new Date().toISOString();
    saveFiles(files);
    return item;
  }

  if (path.includes('/share') && method === 'PATCH') {
    const id = path.split('/')[2];
    const item = files.find((f) => f.id === id);
    if (!item) throw new Error('File not found.');
    if (!users.some((u) => u.email === body.email)) throw new Error('Target user does not exist.');
    if (body.email === sessionEmail) throw new Error('You already own this item.');
    if (!item.sharedWith.includes(body.email)) item.sharedWith.push(body.email);
    saveFiles(files);
    return item;
  }

  if (path.startsWith('/files/') && method === 'DELETE') {
    const id = path.split('/')[2];
    const index = files.findIndex((f) => f.id === id);
    if (index === -1) throw new Error('File not found.');
    if (!files[index].trashedAt) throw new Error('Only trashed files can be permanently deleted.');
    files.splice(index, 1);
    saveFiles(files);
    return { ok: true };
  }

  throw new Error('Operation not available.');
}

function showAuth(mode = 'signin') {
  state.mode = mode;
  $('tabSignin').classList.toggle('active', mode === 'signin');
  $('tabSignup').classList.toggle('active', mode === 'signup');
  $('authSubmit').textContent = mode === 'signin' ? 'Sign In' : 'Create Account';
}

async function submitAuth() {
  const email = $('authEmail').value.trim().toLowerCase();
  const password = $('authPassword').value;
  if (!email || password.length < 6) return $('authMessage').textContent = 'Please use a valid email and a 6+ character password.';

  try {
    const route = state.mode === 'signin' ? '/auth/signin' : '/auth/signup';
    const result = await api(route, { method: 'POST', body: JSON.stringify({ email, password }) });
    state.token = result.token;
    state.user = result.email;
    localStorage.setItem('nebula_token', result.token);
    localStorage.setItem('nebula_user', result.email);
    $('authMessage').textContent = '';
    await loadDrive();
  } catch (err) {
    $('authMessage').textContent = err.message;
  }
}

async function signOut() {
  try { await api('/auth/signout', { method: 'POST' }); } catch {}
  state.token = '';
  state.user = '';
  state.files = [];
  state.selectedId = null;
  localStorage.removeItem('nebula_token');
  localStorage.removeItem('nebula_user');
  $('drivePage').classList.add('hidden');
  $('authPage').classList.remove('hidden');
  showAuth('signin');
}

function currentList() {
  const source = state.section === 'shared'
    ? state.sharedFiles
    : state.files.filter((f) => state.section === 'trash' ? !!f.trashedAt : !f.trashedAt);
  const scoped = source;
  const q = $('searchInput').value.trim().toLowerCase();
  return q ? scoped.filter((f) => f.name.toLowerCase().includes(q)) : scoped;
}

function getSelected() {
  const current = currentList();
  return current.find((f) => f.id === state.selectedId);
}

function renderDetails() {
  const item = getSelected();
  $('detailsEmpty').classList.toggle('hidden', !!item);
  $('detailsBox').classList.toggle('hidden', !item);
  $('shareBtn').disabled = !item || state.section !== 'drive';
  $('downloadBtn').disabled = !item || item.type === 'folder' || state.section === 'trash';
  $('trashBtn').disabled = !item || state.section !== 'drive';
  $('deleteForeverBtn').disabled = !item || state.section !== 'trash';
  if (!item) return;
  $('dName').textContent = item.name;
  $('dType').textContent = item.type;
  $('dSize').textContent = item.type === 'folder' ? '-' : fmt(item.size || 0);
  $('dModified').textContent = item.modified;
  $('dShared').textContent = item.sharedWith?.length ? item.sharedWith.join(', ') : 'Only you';
}

function renderStorage() {
  const used = state.files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
  const pct = Math.min(100, (used / LIMIT) * 100);
  $('storageText').textContent = `${fmt(used)} / ${fmt(LIMIT)}`;
  $('storageBar').style.width = `${pct}%`;
}

function renderGrid() {
  const list = currentList();
  const grid = $('grid');
  grid.innerHTML = '';
  $('empty').classList.toggle('hidden', list.length > 0);

  for (const item of list) {
    const card = document.createElement('article');
    card.className = `card${item.id === state.selectedId ? ' active' : ''}`;
    const owner = state.section === 'shared' ? (item.owner || 'Shared') : 'me';
    const modified = item.modified || '-';
    const size = item.type === 'folder' ? '--' : fmt(item.size || 0);
    const icon = item.type === 'folder' ? '📁' : '📄';
    card.innerHTML = `
      <div class="file-name-cell"><span class="file-icon">${icon}</span><strong>${item.name}</strong></div>
      <div class="file-owner">${owner}</div>
      <div class="file-modified">${modified}</div>
      <div class="file-size">${size}</div>
    `;
    card.onclick = () => { state.selectedId = item.id; renderGrid(); renderDetails(); };
    grid.appendChild(card);
  }
  renderStorage();
  const readonly = state.section === 'shared';
  $('uploadFileBtn').disabled = readonly;
  $('uploadFolderBtn').disabled = readonly;
  $('newFolderBtn').disabled = readonly;
}

async function loadDrive() {
  const response = await api('/files');
  const shared = await api('/files/shared');
  state.files = response.files;
  state.sharedFiles = shared.files;
  state.selectedId = null;
  $('currentUser').textContent = state.user;
  $('authPage').classList.add('hidden');
  $('drivePage').classList.remove('hidden');
  renderGrid();
  renderDetails();
}

async function uploadRecords(fileList, isFolder = false) {
  let used = state.files.filter((f) => !f.trashedAt).reduce((a, b) => a + (b.size || 0), 0);
  let uploadedCount = 0;
  if (isFolder && fileList.length) {
    const rootFolderName = (fileList[0].webkitRelativePath || '').split('/')[0];
    if (rootFolderName && !state.files.some((f) => f.type === 'folder' && f.name === rootFolderName && !f.trashedAt)) {
      await api('/files', {
        method: 'POST',
        body: JSON.stringify({ name: rootFolderName, type: 'folder', size: 0, sharedWith: [] }),
      });
    }
  }
  for (const file of [...fileList]) {
    if (used + file.size > LIMIT) {
      toast(`Cannot upload ${file.name}: exceeds 10 GB storage limit`);
      continue;
    }
    const parentPath = isFolder ? (file.webkitRelativePath || '').split('/').slice(0, -1).join('/') : '';
    if (IS_FILE_MODE) {
      const created = await api('/files', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, type: 'file', size: file.size, parentPath, sharedWith: [] }),
      });
      localBlobMap.set(created.id, file);
    } else {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('parentPath', parentPath);
      await fetch(`${API}/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${state.token}` },
        body: form,
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message || 'Upload failed');
        }
      });
    }
    used += file.size;
    uploadedCount += 1;
  }
  await loadDrive();
  toast(uploadedCount ? `Upload completed: ${uploadedCount} file(s)` : 'No files uploaded');
}

async function createFolder() {
  const name = prompt('Folder name', 'New Folder');
  if (!name) return;
  await api('/files', { method: 'POST', body: JSON.stringify({ name, type: 'folder', size: 0, sharedWith: [] }) });
  await loadDrive();
  toast('Folder created');
}

async function moveToTrash() {
  const item = getSelected();
  if (!item) return;
  await api(`/files/${item.id}/trash`, { method: 'PATCH' });
  await loadDrive();
  toast('Moved to Trash');
}

async function deleteForever() {
  const item = getSelected();
  if (!item || state.section !== 'trash') return;
  await api(`/files/${item.id}`, { method: 'DELETE' });
  await loadDrive();
  toast('Deleted permanently');
}

function downloadSelected() {
  const item = getSelected();
  if (!item || item.type === 'folder' || state.section === 'trash') return;
  if (!IS_FILE_MODE) {
    fetch(`${API}/files/${item.id}/download`, {
      headers: { Authorization: `Bearer ${state.token}` },
    }).then(async (res) => {
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Download failed');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name.split('/').pop();
      a.click();
      URL.revokeObjectURL(url);
      toast('Download started');
    }).catch((error) => toast(error.message));
    return;
  }

  const blob = localBlobMap.get(item.id);
  if (!blob) {
    toast('Local preview mode cannot download this file after refresh. Run npm start for persistent binary downloads.');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name.split('/').pop();
  a.click();
  URL.revokeObjectURL(url);
  toast('Download started');
}

function openShare() {
  if (!getSelected()) return;
  $('shareEmail').value = '';
  $('shareModal').classList.remove('hidden');
}

async function confirmShare() {
  const item = getSelected();
  const email = $('shareEmail').value.trim().toLowerCase();
  if (!item || !email) return;
  try {
    await api(`/files/${item.id}/share`, { method: 'PATCH', body: JSON.stringify({ email }) });
    $('shareModal').classList.add('hidden');
    await loadDrive();
    toast('Item shared successfully');
  } catch (error) {
    toast(error.message);
  }
}

function wire() {
  $('tabSignin').onclick = () => showAuth('signin');
  $('tabSignup').onclick = () => showAuth('signup');
  $('authSubmit').onclick = submitAuth;
  $('signOutBtn').onclick = signOut;
  $('searchInput').oninput = renderGrid;
  $('uploadFileBtn').onclick = () => $('fileInput').click();
  const quickNew = $('newQuickBtn');
  if (quickNew) quickNew.onclick = () => $('fileInput').click();
  $('uploadFolderBtn').onclick = () => $('folderInput').click();
  $('fileInput').onchange = (e) => uploadRecords(e.target.files, false);
  $('folderInput').onchange = (e) => uploadRecords(e.target.files, true);
  $('newFolderBtn').onclick = createFolder;
  $('trashBtn').onclick = moveToTrash;
  $('downloadBtn').onclick = downloadSelected;
  $('deleteForeverBtn').onclick = deleteForever;
  $('shareBtn').onclick = openShare;
  $('cancelShare').onclick = () => $('shareModal').classList.add('hidden');
  $('confirmShare').onclick = confirmShare;
  document.querySelectorAll('.side-btn').forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll('.side-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.section = btn.dataset.section;
      state.selectedId = null;
      renderGrid();
      renderDetails();
    };
  });
}

wire();
if (!state.token && IS_FILE_MODE) {
  const localSession = readJson(localKey.session, null);
  if (localSession?.token && localSession?.email) {
    state.token = localSession.token;
    state.user = localSession.email;
  }
}

if (state.token && state.user) loadDrive().catch(() => signOut());
else showAuth('signin');
