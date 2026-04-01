const API = '/api';
const LIMIT = 5 * 1024 * 1024 * 1024;

const state = {
  mode: 'signin',
  token: localStorage.getItem('nebula_token') || '',
  user: localStorage.getItem('nebula_user') || '',
  files: [],
  section: 'drive',
  selectedId: null,
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
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || 'Request failed');
  return body;
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
  const scoped = state.files.filter((f) => state.section === 'trash' ? !!f.trashedAt : !f.trashedAt);
  const q = $('searchInput').value.trim().toLowerCase();
  return q ? scoped.filter((f) => f.name.toLowerCase().includes(q)) : scoped;
}

function getSelected() { return state.files.find((f) => f.id === state.selectedId); }

function renderDetails() {
  const item = getSelected();
  $('detailsEmpty').classList.toggle('hidden', !!item);
  $('detailsBox').classList.toggle('hidden', !item);
  $('shareBtn').disabled = !item || state.section === 'trash';
  $('trashBtn').disabled = !item || state.section === 'trash';
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
    card.innerHTML = `<div><strong>${item.type === 'folder' ? 'DIR' : 'FILE'}</strong></div><div>${item.name}</div><div class="meta">${item.type === 'folder' ? 'Folder' : fmt(item.size || 0)}</div>`;
    card.onclick = () => { state.selectedId = item.id; renderGrid(); renderDetails(); };
    grid.appendChild(card);
  }
  renderStorage();
}

async function loadDrive() {
  const response = await api('/files');
  state.files = response.files;
  state.selectedId = null;
  $('currentUser').textContent = state.user;
  $('authPage').classList.add('hidden');
  $('drivePage').classList.remove('hidden');
  renderGrid();
  renderDetails();
}

async function uploadRecords(fileList, isFolder = false) {
  for (const file of [...fileList]) {
    const parentPath = isFolder ? (file.webkitRelativePath || '').split('/').slice(0, -1).join('/') : '';
    await api('/files', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, type: 'file', size: file.size, parentPath, sharedWith: [] }),
    });
  }
  await loadDrive();
  toast('Upload completed');
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

function openShare() {
  if (!getSelected()) return;
  $('shareEmail').value = '';
  $('shareModal').classList.remove('hidden');
}

async function confirmShare() {
  const item = getSelected();
  const email = $('shareEmail').value.trim().toLowerCase();
  if (!item || !email) return;
  await api(`/files/${item.id}/share`, { method: 'PATCH', body: JSON.stringify({ email }) });
  $('shareModal').classList.add('hidden');
  await loadDrive();
  toast('Item shared');
}

function wire() {
  $('tabSignin').onclick = () => showAuth('signin');
  $('tabSignup').onclick = () => showAuth('signup');
  $('authSubmit').onclick = submitAuth;
  $('signOutBtn').onclick = signOut;
  $('searchInput').oninput = renderGrid;
  $('uploadFileBtn').onclick = () => $('fileInput').click();
  $('uploadFolderBtn').onclick = () => $('folderInput').click();
  $('fileInput').onchange = (e) => uploadRecords(e.target.files, false);
  $('folderInput').onchange = (e) => uploadRecords(e.target.files, true);
  $('newFolderBtn').onclick = createFolder;
  $('trashBtn').onclick = moveToTrash;
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
if (state.token && state.user) loadDrive().catch(() => signOut());
else showAuth('signin');
