/* =========================================================
   SUNNY RECORD — main.js
   Ce fichier parle à l'API du serveur (server/server.js), qui
   lit/écrit dans une vraie base de données (server/data/sunny.db).
   Le site doit être ouvert via le serveur (http://localhost:3000
   par défaut), pas en double-cliquant sur les fichiers .html.
   ========================================================= */

// --- Petit utilitaire fetch avec gestion d'erreurs claire ---
async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'include',
      headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch (err) {
    throw new Error("Impossible de contacter le serveur. Vérifiez qu'il est bien lancé (npm start dans le dossier server) et que vous ouvrez le site via http://localhost:3000, pas en double-cliquant sur un fichier.");
  }
  let data = null;
  try { data = await res.json(); } catch (_) { /* pas de contenu JSON, ok pour DELETE par ex. */ }
  if (!res.ok) {
    throw new Error((data && data.error) || `Erreur serveur (${res.status})`);
  }
  return data;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// --- Menu mobile ---
function initNavToggle() {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (!toggle || !links) return;
  toggle.addEventListener('click', () => {
    links.classList.toggle('open');
    toggle.textContent = links.classList.contains('open') ? '✕' : '☰';
  });
}

/* =========================================================
   LECTEUR AUDIO PERSISTANT (mini-player en bas à droite)
   Un seul <audio> partagé par tout le site : jouer un morceau sur la page
   Artistes puis naviguer vers Bar ne l'interrompt pas (voir initSoftNav).
   ========================================================= */
let playerAudio = null;

function ensureMiniPlayer() {
  if (document.getElementById('mini-player')) return;

  playerAudio = document.createElement('audio');
  playerAudio.id = 'global-audio';
  // Reprend le dernier volume choisi par la personne, sinon 80% par défaut.
  const savedVolume = parseFloat(sessionStorage.getItem('sunny_player_volume'));
  playerAudio.volume = isNaN(savedVolume) ? 0.8 : savedVolume;
  document.body.appendChild(playerAudio);

  const bar = document.createElement('div');
  bar.id = 'mini-player';
  bar.className = 'hidden';
  bar.innerHTML = `
    <img id="mini-player-cover" class="mini-player-cover" alt="" hidden>
    <button class="mini-player-toggle" id="mini-player-toggle" aria-label="Lecture / pause">▶</button>
    <div class="mini-player-info">
      <div class="mini-player-title" id="mini-player-title"></div>
      <div class="mini-player-artist" id="mini-player-artist"></div>
      <div class="mini-player-volume-row">
        <span class="mini-player-vol-icon" id="mini-player-vol-icon">🔊</span>
        <input type="range" id="mini-player-volume" min="0" max="100" step="1" aria-label="Volume">
      </div>
    </div>
    <button class="mini-player-close" id="mini-player-close" aria-label="Arrêter">✕</button>
  `;
  document.body.appendChild(bar);

  document.getElementById('mini-player-toggle').addEventListener('click', toggleTrack);
  document.getElementById('mini-player-close').addEventListener('click', stopTrack);
  playerAudio.addEventListener('play', () => setPlayerPlayingState(true));
  playerAudio.addEventListener('pause', () => setPlayerPlayingState(false));
  playerAudio.addEventListener('ended', () => setPlayerPlayingState(false));

  const volumeSlider = document.getElementById('mini-player-volume');
  volumeSlider.value = Math.round(playerAudio.volume * 100);
  updateVolumeIcon(playerAudio.volume);
  volumeSlider.addEventListener('input', () => {
    const v = Number(volumeSlider.value) / 100;
    playerAudio.volume = v;
    sessionStorage.setItem('sunny_player_volume', String(v));
    updateVolumeIcon(v);
  });
}

function updateVolumeIcon(volume) {
  const icon = document.getElementById('mini-player-vol-icon');
  if (!icon) return;
  icon.textContent = volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';
}

function setPlayerPlayingState(isPlaying) {
  const toggle = document.getElementById('mini-player-toggle');
  if (toggle) toggle.textContent = isPlaying ? '⏸' : '▶';
  document.querySelectorAll('.play-btn[data-playing="1"]').forEach(btn => {
    btn.classList.toggle('is-playing', isPlaying);
    btn.textContent = isPlaying ? '⏸ En écoute' : '▶ Écouter';
  });
}

function playTrack(src, titre, artiste, sourceBtn, coverUrl) {
  if (!src) return;
  ensureMiniPlayer();

  document.querySelectorAll('.play-btn').forEach(b => { b.removeAttribute('data-playing'); b.classList.remove('is-playing'); b.textContent = '▶ Écouter'; });

  const isSameTrack = playerAudio.dataset.src === src;
  if (!isSameTrack) {
    playerAudio.src = src;
    playerAudio.dataset.src = src;
  }
  document.getElementById('mini-player-title').textContent = titre || 'Sans titre';
  document.getElementById('mini-player-artist').textContent = artiste || '';

  const coverEl = document.getElementById('mini-player-cover');
  if (coverEl) {
    if (coverUrl) { coverEl.src = coverUrl; coverEl.hidden = false; }
    else { coverEl.removeAttribute('src'); coverEl.hidden = true; }
  }

  document.getElementById('mini-player').classList.remove('hidden');
  if (sourceBtn) sourceBtn.setAttribute('data-playing', '1');

  playerAudio.play().catch(() => {});
}

// Récupère le morceau audio d'un artiste au moment où on clique "Écouter"
// (il n'est plus inclus dans la liste des artistes, pour que la page se
// charge vite — voir server/server.js, route /api/artists/:id/track).
const trackCache = {}; // évite de re-télécharger le même morceau plusieurs fois dans la session

async function playArtistTrack(artistId, btn) {
  const artist = cachedArtists.find(a => a.id === artistId);
  if (!artist || !artist.has_track) return;

  // Si ce morceau est déjà celui en cours de lecture, on bascule juste pause/lecture.
  if (trackCache[artistId] && playerAudio && playerAudio.dataset.src === trackCache[artistId] && !playerAudio.paused) {
    playerAudio.pause();
    return;
  }

  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Chargement…'; }

  try {
    let trackData = trackCache[artistId];
    if (!trackData) {
      const res = await api(`/api/artists/${artistId}/track`);
      trackData = res.track_data;
      trackCache[artistId] = trackData;
    }
    playTrack(trackData, artist.track_titre || 'Sans titre', artist.nom, btn, artist.cover_image);
  } catch (err) {
    alert(err.message);
  } finally {
    if (btn) { btn.disabled = false; if (!btn.hasAttribute('data-playing')) btn.textContent = originalLabel; }
  }
}

function toggleTrack() {
  if (!playerAudio) return;
  if (playerAudio.paused) playerAudio.play().catch(() => {});
  else playerAudio.pause();
}
function stopTrack() {
  if (!playerAudio) return;
  playerAudio.pause();
  playerAudio.currentTime = 0;
  document.getElementById('mini-player')?.classList.add('hidden');
  setPlayerPlayingState(false);
}

/* =========================================================
   PAGE ARTISTES PUBLIQUE — rendu dynamique + filtre par genre
   ========================================================= */
const AVATAR_COLORS = [
  'linear-gradient(160deg, var(--violet), var(--bg-panel-2))',
  'linear-gradient(160deg, #3D0A0E, var(--bg-panel-2))',
  'linear-gradient(160deg, #2E1010, var(--bg-panel-2))',
  'linear-gradient(160deg, var(--gold), var(--bg-panel-2))',
  'linear-gradient(160deg, var(--violet-bright), var(--bg-panel-2))',
  'linear-gradient(160deg, #401515, var(--bg-panel-2))',
];
function initials(nom) {
  return (nom || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

let cachedArtists = [];

async function initPublicArtistsPage() {
  const grid = document.getElementById('public-artist-grid');
  if (!grid) return;

  grid.innerHTML = `<p style="color:var(--text-muted)">Chargement des artistes…</p>`;
  try {
    cachedArtists = await api('/api/artists');
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
    return;
  }

  const filterBar = document.getElementById('public-filter-bar');
  if (filterBar) {
    const genres = [...new Set(cachedArtists.map(a => a.genre).filter(Boolean))];
    filterBar.innerHTML = `<button class="filter-chip active" data-genre="tous">Tous</button>` +
      genres.map(g => `<button class="filter-chip" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('');
    filterBar.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        filterBar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        renderPublicArtists(chip.dataset.genre);
      });
    });
  }

  renderPublicArtists('tous');
}

function renderPublicArtists(activeGenre) {
  const grid = document.getElementById('public-artist-grid');
  if (!grid) return;

  const filtered = (!activeGenre || activeGenre === 'tous')
    ? cachedArtists
    : cachedArtists.filter(a => a.genre === activeGenre);

  if (!filtered.length) {
    grid.innerHTML = `<p style="color:var(--text-muted)">Aucun artiste dans cette catégorie pour le moment.</p>`;
    return;
  }

  grid.innerHTML = filtered.map((a, i) => `
    <article class="artist-card">
      <div class="artist-photo" style="background:${AVATAR_COLORS[i % AVATAR_COLORS.length]}">
        ${a.cover_image ? `<img src="${a.cover_image}" alt="Pochette de ${escapeHtml(a.nom)}">` : escapeHtml(initials(a.nom))}
      </div>
      <div class="artist-body">
        <h3>${escapeHtml(a.nom)}</h3>
        <span class="artist-genre">${escapeHtml(a.genre || '')}</span>
        <p class="bio">${escapeHtml(a.bio || 'Bio à venir.')}</p>
        ${a.has_track ? `
          <div class="track-label">Titre à l'affiche — « ${escapeHtml(a.track_titre || 'Sans titre')} »</div>
          <button type="button" class="btn btn-outline play-btn" onclick="playArtistTrack(${a.id}, this)">▶ Écouter</button>
        ` : `<p class="audio-pending">🎵 Morceau à venir</p>`}
      </div>
    </article>
  `).join('');
}

/* =========================================================
   PAGE BAR PUBLIQUE — carte des boissons par catégorie
   ========================================================= */
let cachedDrinks = [];

async function initPublicBarPage() {
  const container = document.getElementById('drinks-list');
  if (!container) return;

  container.innerHTML = `<p style="color:var(--text-muted)">Chargement de la carte…</p>`;
  try {
    cachedDrinks = await api('/api/drinks');
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
    return;
  }

  const filterBar = document.getElementById('drink-filter-bar');
  if (filterBar) {
    const categories = [...new Set(cachedDrinks.map(d => d.categorie).filter(Boolean))];
    filterBar.innerHTML = `<button class="filter-chip active" data-cat="toutes">Toutes</button>` +
      categories.map(c => `<button class="filter-chip" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('');
    filterBar.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        filterBar.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        renderPublicDrinks(chip.dataset.cat);
      });
    });
  }

  renderPublicDrinks('toutes');
}

function renderPublicDrinks(activeCategory) {
  const container = document.getElementById('drinks-list');
  if (!container) return;

  if (!cachedDrinks.length) {
    container.innerHTML = `<p style="color:var(--text-muted)">La carte n'est pas encore prête.</p>`;
    return;
  }

  const categories = [...new Set(cachedDrinks.map(d => d.categorie).filter(Boolean))]
    .filter(c => !activeCategory || activeCategory === 'toutes' || c === activeCategory);

  container.innerHTML = categories.map(cat => {
    const drinks = cachedDrinks.filter(d => d.categorie === cat);
    return `
      <div class="drinks-section">
        <h2>${escapeHtml(cat)}</h2>
        <div class="drink-grid">
          ${drinks.map(d => `
            <div class="drink-card">
              <div>
                <div class="drink-name">${escapeHtml(d.nom)}</div>
                ${d.description ? `<div class="drink-desc">${escapeHtml(d.description)}</div>` : ''}
              </div>
              <div class="drink-price">${Number(d.prix).toFixed(2).replace('.', ',')} €</div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }).join('');
}

/* =========================================================
   FORMULAIRE DE CONTACT (public)
   ========================================================= */
function initContactForm() {
  const form = document.getElementById('contact-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const confirmBox = document.getElementById('contact-confirm');

    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      if (confirmBox) {
        confirmBox.style.display = 'block';
        confirmBox.style.color = 'var(--gold-soft)';
        confirmBox.textContent = 'Message envoyé — merci, on revient vers vous rapidement.';
      }
    } catch (err) {
      if (confirmBox) {
        confirmBox.style.display = 'block';
        confirmBox.style.color = 'var(--danger)';
        confirmBox.textContent = err.message;
      }
    }
  });
}

/* =========================================================
   GESTION (zone admin)
   Authentification par session côté serveur (cookie httpOnly),
   les données viennent de la base — plus de mot de passe ni de
   données visibles dans le code source du navigateur.
   ========================================================= */
// Correspondance onglet → droit nécessaire pour le voir (le tabId "panel-comptes" n'y
// figure pas : il reste toujours visible, seul son contenu varie selon le rôle).
const TAB_PERMISSION_MAP = {
  'panel-messages': 'messages',
  'panel-artists': 'artists',
  'panel-formules': 'formules',
  'panel-boissons': 'bar',
  'panel-factures': 'factures',
  'panel-compta': 'compta',
};
let currentSession = { role: 'admin', permissions: [] };
function canAccess(key) {
  return currentSession.role === 'admin' || currentSession.permissions.includes(key);
}

function initGestionPage() {
  const loginShell = document.getElementById('login-shell');
  const adminShell = document.getElementById('admin-shell');
  if (!loginShell || !adminShell) return;

  const loginForm = document.getElementById('login-form');
  const errorMsg = document.getElementById('login-error');
  const logoutBtn = document.getElementById('logout-btn');
  const userLabel = document.getElementById('current-user-label');

  async function showAdmin(username, role, permissions) {
    currentSession = { role: role || 'admin', permissions: permissions || [] };
    loginShell.style.display = 'none';
    adminShell.style.display = 'block';
    if (userLabel) {
      const roleLabel = currentSession.role === 'admin' ? 'Administrateur' : 'Collaborateur';
      userLabel.textContent = username ? `Connecté en tant que ${username} (${roleLabel})` : '';
    }

    // Masque les onglets auxquels ce compte n'a pas accès.
    let firstVisibleTab = null;
    document.querySelectorAll('.admin-tab').forEach(tab => {
      const needed = TAB_PERMISSION_MAP[tab.dataset.target];
      const visible = !needed || canAccess(needed);
      tab.style.display = visible ? '' : 'none';
      if (visible && !firstVisibleTab) firstVisibleTab = tab;
    });
    // Si l'onglet actuellement actif vient d'être masqué, on bascule sur le premier visible.
    const activeTab = document.querySelector('.admin-tab.active');
    if (activeTab && activeTab.style.display === 'none' && firstVisibleTab) {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
      firstVisibleTab.classList.add('active');
      document.getElementById(firstVisibleTab.dataset.target)?.classList.add('active');
    }

    // La gestion des comptes (créer/lister/supprimer) reste réservée aux Administrateurs ;
    // le changement de son propre mot de passe, lui, reste toujours visible.
    const accountsSection = document.getElementById('accounts-management-section');
    if (accountsSection) accountsSection.style.display = currentSession.role === 'admin' ? '' : 'none';

    const tasks = [];
    if (canAccess('messages')) tasks.push(renderMessages());
    if (canAccess('artists')) tasks.push(renderArtistsAdmin());
    if (canAccess('formules')) tasks.push(renderFormulesAdmin());
    if (canAccess('bar')) tasks.push(renderDrinksAdmin());
    if (canAccess('factures')) tasks.push(renderInvoicesAdmin());
    if (canAccess('compta')) { tasks.push(renderStockAdmin()); tasks.push(renderTransactionsAdmin()); tasks.push(renderComptaSummary()); }
    if (currentSession.role === 'admin') tasks.push(renderAdminsAdmin());
    await Promise.all(tasks);
  }
  function showLogin() {
    adminShell.style.display = 'none';
    loginShell.style.display = 'flex';
  }

  // Vérifie si une session admin est déjà active côté serveur
  api('/api/session').then(({ isAdmin, username, role, permissions }) => {
    if (isAdmin) showAdmin(username, role, permissions);
  }).catch(() => {});

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorMsg.style.display = 'none';
    const username = document.getElementById('login-username').value;
    const pwd = document.getElementById('login-password').value;
    try {
      const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password: pwd }) });
      loginForm.reset();
      showAdmin(res.username, res.role, res.permissions);
    } catch (err) {
      errorMsg.textContent = err.message;
      errorMsg.style.display = 'block';
    }
  });

  logoutBtn?.addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
    showLogin();
  });

  // Onglets admin
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.add('active');
    });
  });
}

/* --- Messages de contact --- */
async function renderMessages() {
  const tbody = document.getElementById('messages-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/messages');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-muted)">Aucune demande de contact pour le moment.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(m => `
    <tr>
      <td>${escapeHtml(new Date(m.created_at).toLocaleDateString('fr-FR'))}</td>
      <td>${escapeHtml(m.nom)}<br><span style="color:var(--text-muted);font-size:12.5px">${escapeHtml(m.email)}</span></td>
      <td>${escapeHtml(m.sujet)}</td>
      <td><span class="badge ${m.statut}">${m.statut === 'new' ? 'Nouveau' : 'Lu'}</span></td>
      <td>
        <button class="mini-btn" onclick="markRead(${m.id})">Marquer lu</button>
        <button class="mini-btn danger" onclick="deleteMessage(${m.id})">Supprimer</button>
      </td>
    </tr>
  `).join('');
}
async function markRead(id) {
  try { await api(`/api/messages/${id}/read`, { method: 'PATCH' }); renderMessages(); }
  catch (err) { alert(err.message); }
}
async function deleteMessage(id) {
  try { await api(`/api/messages/${id}`, { method: 'DELETE' }); renderMessages(); }
  catch (err) { alert(err.message); }
}

/* --- Artistes (admin) --- */
async function renderArtistsAdmin() {
  const tbody = document.getElementById('artists-admin-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/artists');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  cachedArtists = list; // garde la page Artistes publique synchronisée si elle est ouverte ailleurs
  tbody.innerHTML = list.map(a => `
    <tr>
      <td style="display:flex; align-items:center; gap:10px;">
        ${a.cover_image ? `<img src="${a.cover_image}" alt="" class="admin-cover-thumb">` : ''}
        ${escapeHtml(a.nom)}
      </td>
      <td>${escapeHtml(a.genre)}</td>
      <td>${escapeHtml(a.statut)}</td>
      <td>${a.has_track
        ? `<div style="min-width:160px"><div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${escapeHtml(a.track_titre || 'Sans titre')}</div><button type="button" class="mini-btn play-btn" onclick="playArtistTrack(${a.id}, this)">▶ Aperçu</button></div>`
        : `<span style="color:var(--text-muted);font-size:13px">Aucun morceau</span>`}
      </td>
      <td>
        <button class="mini-btn danger" onclick="deleteArtistAdmin(${a.id})">Retirer</button>
      </td>
    </tr>
  `).join('');
}
async function deleteArtistAdmin(id) {
  try { await api(`/api/artists/${id}`, { method: 'DELETE' }); renderArtistsAdmin(); }
  catch (err) { alert(err.message); }
}
function initArtistAdminForm() {
  const form = document.getElementById('artist-admin-form');
  if (!form) return;
  const fileError = document.getElementById('a-audio-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (fileError) fileError.style.display = 'none';

    const formData = new FormData(form); // inclut le fichier audio s'il y en a un
    try {
      await api('/api/artists', { method: 'POST', body: formData });
      form.reset();
      renderArtistsAdmin();
    } catch (err) {
      if (fileError) { fileError.textContent = err.message; fileError.style.display = 'block'; }
      else alert(err.message);
    }
  });
}

/* --- Formules (admin) --- */
async function renderFormulesAdmin() {
  const tbody = document.getElementById('formules-admin-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/formules');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(f => `
    <tr>
      <td>${escapeHtml(f.nom)}</td>
      <td>${escapeHtml(f.prix)}</td>
      <td>${escapeHtml(f.description)}</td>
      <td><button class="mini-btn danger" onclick="deleteFormuleAdmin(${f.id})">Retirer</button></td>
    </tr>
  `).join('');
}
async function deleteFormuleAdmin(id) {
  try { await api(`/api/formules/${id}`, { method: 'DELETE' }); renderFormulesAdmin(); }
  catch (err) { alert(err.message); }
}
function initFormuleAdminForm() {
  const form = document.getElementById('formule-admin-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/formules', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      renderFormulesAdmin();
    } catch (err) {
      alert(err.message);
    }
  });
}

/* --- Boissons (admin, carte du bar) --- */
async function renderDrinksAdmin() {
  const tbody = document.getElementById('drinks-admin-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/drinks');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  cachedDrinks = list;
  tbody.innerHTML = list.map(d => `
    <tr>
      <td>${escapeHtml(d.nom)}${d.description ? `<br><span style="color:var(--text-muted);font-size:12px">${escapeHtml(d.description)}</span>` : ''}</td>
      <td>${escapeHtml(d.categorie)}</td>
      <td>${Number(d.prix).toFixed(2).replace('.', ',')} €</td>
      <td><button class="mini-btn danger" onclick="deleteDrinkAdmin(${d.id})">Retirer</button></td>
    </tr>
  `).join('');
}
async function deleteDrinkAdmin(id) {
  try { await api(`/api/drinks/${id}`, { method: 'DELETE' }); renderDrinksAdmin(); }
  catch (err) { alert(err.message); }
}
function initDrinkAdminForm() {
  const form = document.getElementById('drink-admin-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/drinks', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      renderDrinksAdmin();
    } catch (err) { alert(err.message); }
  });
}

/* --- Stock (admin) --- */
async function renderStockAdmin() {
  const tbody = document.getElementById('stock-admin-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/stock');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted)">Aucune entrée de stock pour le moment.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(s => `
    <tr>
      <td>${escapeHtml(formatDateFr(s.date))}</td>
      <td>${escapeHtml(s.produit)}</td>
      <td>${s.quantite}</td>
      <td>${Number(s.prix_unitaire).toFixed(2).replace('.', ',')} €</td>
      <td>${escapeHtml(s.notes || '')}</td>
      <td><button class="mini-btn danger" onclick="deleteStockAdmin(${s.id})">Retirer</button></td>
    </tr>
  `).join('');
}
async function deleteStockAdmin(id) {
  try { await api(`/api/stock/${id}`, { method: 'DELETE' }); renderStockAdmin(); }
  catch (err) { alert(err.message); }
}
function initStockAdminForm() {
  const form = document.getElementById('stock-admin-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/stock', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      renderStockAdmin();
    } catch (err) { alert(err.message); }
  });
}

/* =========================================================
   FACTURES — formulaire à lignes dynamiques + génération PDF
   ========================================================= */
let jsPdfLoading = null;
function ensureJsPDF() {
  if (window.jspdf) return Promise.resolve();
  if (jsPdfLoading) return jsPdfLoading;
  jsPdfLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js';
    s.onload = resolve;
    s.onerror = () => { jsPdfLoading = null; reject(new Error('Impossible de charger le générateur de PDF (connexion internet nécessaire).')); };
    document.head.appendChild(s);
  });
  return jsPdfLoading;
}

function formatEurosPlain(n) {
  return Number(n || 0).toFixed(2).replace('.', ',') + ' €';
}

function addInvoiceLine(description = '', quantite = 1, prixUnitaire = '') {
  const container = document.getElementById('invoice-lines');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'invoice-line';
  row.innerHTML = `
    <input type="text" placeholder="Description" class="inv-line-desc" value="${escapeHtml(description)}">
    <input type="number" placeholder="Qté" min="0" step="0.01" class="inv-line-qte" value="${quantite}">
    <input type="number" placeholder="Prix unit. €" min="0" step="0.01" class="inv-line-prix" value="${prixUnitaire}">
    <button type="button" class="invoice-line-remove" aria-label="Retirer la ligne">✕</button>
  `;
  row.querySelector('.invoice-line-remove').addEventListener('click', () => { row.remove(); updateInvoiceTotals(); });
  row.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateInvoiceTotals));
  container.appendChild(row);
}

function getInvoiceLines() {
  return Array.from(document.querySelectorAll('#invoice-lines .invoice-line')).map(row => ({
    description: row.querySelector('.inv-line-desc').value.trim(),
    quantite: parseFloat(row.querySelector('.inv-line-qte').value) || 0,
    prix_unitaire: parseFloat(row.querySelector('.inv-line-prix').value) || 0,
  }));
}

function updateInvoiceTotals() {
  const totalsEl = document.getElementById('invoice-totals');
  if (!totalsEl) return;
  const lines = getInvoiceLines();
  const sousTotal = lines.reduce((sum, l) => sum + l.quantite * l.prix_unitaire, 0);
  const reductionTaux = parseFloat(document.getElementById('inv-reduction')?.value) || 0;
  const reduction = sousTotal * (reductionTaux / 100);
  const total = sousTotal - reduction;
  totalsEl.innerHTML = reductionTaux > 0
    ? `Sous-total : ${formatEuros(sousTotal)}<br>Réduction (${reductionTaux}%) : − ${formatEuros(reduction)}<br><strong style="color:var(--text);font-size:16px;">Total : ${formatEuros(total)}</strong>`
    : `<strong style="color:var(--text);font-size:16px;">Total : ${formatEuros(total)}</strong>`;
}

function initInvoiceForm() {
  const form = document.getElementById('invoice-form');
  if (!form) return;
  const linesContainer = document.getElementById('invoice-lines');
  const addBtn = document.getElementById('invoice-add-line');
  const errorBox = document.getElementById('invoice-form-error');
  const dateInput = document.getElementById('inv-date');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

  if (linesContainer && linesContainer.children.length === 0) addInvoiceLine();
  addBtn?.addEventListener('click', () => { addInvoiceLine(); updateInvoiceTotals(); });
  document.getElementById('inv-reduction')?.addEventListener('input', updateInvoiceTotals);
  updateInvoiceTotals();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';

    const lines = getInvoiceLines().filter(l => l.description);
    if (!lines.length) {
      errorBox.textContent = 'Ajoutez au moins une ligne avec une description.';
      errorBox.style.display = 'block';
      return;
    }

    const payload = {
      client_nom: document.getElementById('inv-client-nom').value.trim(),
      client_email: document.getElementById('inv-client-email').value.trim(),
      client_adresse: document.getElementById('inv-client-adresse').value.trim(),
      date: document.getElementById('inv-date').value,
      reduction_taux: document.getElementById('inv-reduction').value,
      notes: document.getElementById('inv-notes').value.trim(),
      items: lines,
    };

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalLabel = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Génération…';

    try {
      const invoice = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
      await downloadInvoicePDF(invoice);
      form.reset();
      linesContainer.innerHTML = '';
      addInvoiceLine();
      if (dateInput) dateInput.value = new Date().toISOString().slice(0, 10);
      document.getElementById('inv-reduction').value = 0;
      updateInvoiceTotals();
      renderInvoicesAdmin();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });
}

async function downloadInvoicePDF(invoice) {
  await ensureJsPDF();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 18;
  let y = 20;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text('THE HORDE STUDIO', marginX, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text('Studio & label indépendant', marginX, y + 6);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(20, 20, 20);
  doc.text('FACTURE', pageWidth - marginX, y, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90);
  doc.text(`N° ${invoice.numero}`, pageWidth - marginX, y + 6, { align: 'right' });
  doc.text(`Date : ${formatDateFr(invoice.date)}`, pageWidth - marginX, y + 11, { align: 'right' });

  y += 22;
  doc.setDrawColor(220);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 10;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text('Facturé à :', marginX, y);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(60);
  y += 6;
  doc.text(invoice.client_nom, marginX, y);
  if (invoice.client_email) { y += 5; doc.text(invoice.client_email, marginX, y); }
  if (invoice.client_adresse) {
    doc.splitTextToSize(invoice.client_adresse, 80).forEach(line => { y += 5; doc.text(line, marginX, y); });
  }

  y += 12;
  const colDesc = marginX, colQte = pageWidth - marginX - 70, colPrix = pageWidth - marginX - 45, colTotal = pageWidth - marginX;

  doc.setFillColor(23, 15, 16);
  doc.rect(marginX, y, pageWidth - marginX * 2, 8, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('Description', colDesc + 2, y + 5.5);
  doc.text('Qté', colQte, y + 5.5, { align: 'right' });
  doc.text('Prix unit.', colPrix, y + 5.5, { align: 'right' });
  doc.text('Total', colTotal, y + 5.5, { align: 'right' });
  y += 8;

  doc.setFont('helvetica', 'normal');
  let sousTotal = 0;
  invoice.items.forEach((item, i) => {
    const ligneTotal = item.quantite * item.prix_unitaire;
    sousTotal += ligneTotal;
    if (i % 2 === 1) { doc.setFillColor(245, 245, 245); doc.rect(marginX, y, pageWidth - marginX * 2, 8, 'F'); }
    doc.setTextColor(40, 40, 40);
    doc.text(String(item.description), colDesc + 2, y + 5.5, { maxWidth: colQte - colDesc - 6 });
    doc.text(String(item.quantite), colQte, y + 5.5, { align: 'right' });
    doc.text(formatEurosPlain(item.prix_unitaire), colPrix, y + 5.5, { align: 'right' });
    doc.text(formatEurosPlain(ligneTotal), colTotal, y + 5.5, { align: 'right' });
    y += 8;
  });

  y += 4;
  doc.setDrawColor(220);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 8;

  const reduction = sousTotal * ((invoice.reduction_taux || 0) / 100);
  const total = sousTotal - reduction;

  doc.setFontSize(10);
  doc.setTextColor(60);
  if (invoice.reduction_taux > 0) {
    doc.text('Sous-total :', colPrix, y, { align: 'right' });
    doc.text(formatEurosPlain(sousTotal), colTotal, y, { align: 'right' });
    y += 6;
    doc.text(`Réduction (${invoice.reduction_taux}%) :`, colPrix, y, { align: 'right' });
    doc.text(`− ${formatEurosPlain(reduction)}`, colTotal, y, { align: 'right' });
    y += 8;
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(20, 20, 20);
  doc.text('Total :', colPrix, y, { align: 'right' });
  doc.text(formatEurosPlain(total), colTotal, y, { align: 'right' });

  if (invoice.notes) {
    y += 16;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(100);
    doc.splitTextToSize(invoice.notes, pageWidth - marginX * 2).forEach(line => { doc.text(line, marginX, y); y += 5; });
  }

  doc.save(`${invoice.numero}.pdf`);
}

let cachedInvoices = [];
async function renderInvoicesAdmin() {
  const tbody = document.getElementById('invoices-admin-body');
  if (!tbody) return;
  try {
    cachedInvoices = await api('/api/invoices');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (!cachedInvoices.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted)">Aucune facture pour le moment.</td></tr>`;
    return;
  }
  tbody.innerHTML = cachedInvoices.map(inv => {
    const sousTotal = inv.items.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0);
    const total = sousTotal * (1 - (inv.reduction_taux || 0) / 100);
    return `
      <tr>
        <td>${escapeHtml(inv.numero)}</td>
        <td>${escapeHtml(formatDateFr(inv.date))}</td>
        <td>${escapeHtml(inv.client_nom)}</td>
        <td>${formatEuros(total)}</td>
        <td>
          <select onchange="updateInvoiceStatut(${inv.id}, this.value)" style="background:var(--bg-panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:5px 8px;font-size:12.5px;">
            <option value="En attente" ${inv.statut === 'En attente' ? 'selected' : ''}>En attente</option>
            <option value="Payée" ${inv.statut === 'Payée' ? 'selected' : ''}>Payée</option>
          </select>
        </td>
        <td>
          <button class="mini-btn" onclick="redownloadInvoice(${inv.id})">PDF</button>
          <button class="mini-btn danger" onclick="deleteInvoiceAdmin(${inv.id})">Retirer</button>
        </td>
      </tr>
    `;
  }).join('');
}
function redownloadInvoice(id) {
  const inv = cachedInvoices.find(i => i.id === id);
  if (inv) downloadInvoicePDF(inv);
}
async function updateInvoiceStatut(id, statut) {
  try {
    await api(`/api/invoices/${id}/statut`, { method: 'PATCH', body: JSON.stringify({ statut }) });
    renderInvoicesAdmin();
    // Le changement de statut ajoute/retire une entrée en Comptabilité : on rafraîchit
    // ces vues si elles sont présentes sur la page (sans erreur si l'onglet n'est pas visible).
    if (canAccess('compta')) {
      renderTransactionsAdmin();
      renderComptaSummary();
    }
  } catch (err) {
    alert(err.message);
    renderInvoicesAdmin();
  }
}
async function deleteInvoiceAdmin(id) {
  if (!confirm('Retirer cette facture de l\'historique ? Cette action est définitive.')) return;
  try { await api(`/api/invoices/${id}`, { method: 'DELETE' }); renderInvoicesAdmin(); }
  catch (err) { alert(err.message); }
}

/* --- Transactions & comptabilité (admin) --- */
function formatDateFr(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString('fr-FR');
}
function formatEuros(n) {
  return Number(n || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

async function renderTransactionsAdmin() {
  const tbody = document.getElementById('transactions-admin-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/transactions');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--text-muted)">Aucune transaction pour le moment.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(t => `
    <tr>
      <td>${escapeHtml(formatDateFr(t.date))}</td>
      <td><span class="badge ${t.type}">${t.type === 'entree' ? 'Entrée' : 'Dépense'}</span></td>
      <td>${formatEuros(t.montant)}</td>
      <td>${escapeHtml(t.categorie || '—')}</td>
      <td>${escapeHtml(t.description || '')}</td>
      <td><button class="mini-btn danger" onclick="deleteTransactionAdmin(${t.id})">Retirer</button></td>
    </tr>
  `).join('');
}
async function deleteTransactionAdmin(id) {
  try {
    await api(`/api/transactions/${id}`, { method: 'DELETE' });
    renderTransactionsAdmin();
    renderComptaSummary();
  } catch (err) { alert(err.message); }
}
function initTransactionAdminForm() {
  const form = document.getElementById('transaction-admin-form');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await api('/api/transactions', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      renderTransactionsAdmin();
      renderComptaSummary();
    } catch (err) { alert(err.message); }
  });
}

let chartJsLoading = null;
function ensureChartJs() {
  if (window.Chart) return Promise.resolve();
  if (chartJsLoading) return chartJsLoading;
  chartJsLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
    s.onload = resolve;
    s.onerror = () => { chartJsLoading = null; reject(new Error('Impossible de charger le graphique (Chart.js).')); };
    document.head.appendChild(s);
  });
  return chartJsLoading;
}

let comptaChartInstance = null;
async function renderComptaSummary() {
  const canvas = document.getElementById('compta-chart');
  const elEntrees = document.getElementById('compta-total-entrees');
  const elDepenses = document.getElementById('compta-total-depenses');
  const elSolde = document.getElementById('compta-solde');
  if (!canvas && !elEntrees) return;

  let summary;
  try {
    summary = await api('/api/transactions/summary');
  } catch (err) {
    if (elEntrees) elEntrees.textContent = '—';
    if (elDepenses) elDepenses.textContent = '—';
    if (elSolde) { elSolde.textContent = 'Erreur'; elSolde.title = err.message; }
    return;
  }

  if (elEntrees) elEntrees.textContent = formatEuros(summary.totalEntrees);
  if (elDepenses) elDepenses.textContent = formatEuros(summary.totalDepenses);
  if (elSolde) {
    elSolde.textContent = formatEuros(summary.solde);
    elSolde.style.color = summary.solde >= 0 ? 'var(--gold)' : 'var(--danger)';
  }

  if (canvas) {
    try {
      await ensureChartJs();
    } catch (err) {
      console.error(err);
      return;
    }
    const labels = summary.weekly.map(w => w.semaine);
    const entrees = summary.weekly.map(w => w.entrees);
    const depenses = summary.weekly.map(w => w.depenses);

    if (comptaChartInstance) comptaChartInstance.destroy();
    comptaChartInstance = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Entrées', data: entrees, backgroundColor: '#A89C9C' },
          { label: 'Dépenses', data: depenses, backgroundColor: '#E9536B' },
        ],
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: '#F5EDFF' } } },
        scales: {
          x: { ticks: { color: '#AE9797' }, grid: { color: 'rgba(193,18,31,0.12)' } },
          y: { ticks: { color: '#AE9797' }, grid: { color: 'rgba(193,18,31,0.12)' }, beginAtZero: true },
        },
      },
    });
  }
}

/* --- Comptes Gestion (admin) --- */
const PERMISSION_LABELS = { messages: 'Contact', artists: 'Artistes', formules: 'Formules', bar: 'Bar', factures: 'Factures', compta: 'Comptabilité' };

async function renderAdminsAdmin() {
  const tbody = document.getElementById('admins-body');
  if (!tbody) return;
  let list;
  try {
    list = await api('/api/admins');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:var(--danger)">${escapeHtml(err.message)}</td></tr>`;
    return;
  }
  const adminCount = list.filter(a => a.role === 'admin').length;
  tbody.innerHTML = list.map(a => {
    const isAdmin = a.role === 'admin';
    const sections = isAdmin ? 'Toutes' : (a.permissions.map(p => PERMISSION_LABELS[p] || p).join(', ') || '—');
    const isLastAdmin = isAdmin && adminCount <= 1;
    return `
    <tr>
      <td>${escapeHtml(a.username)}</td>
      <td>${isAdmin ? 'Administrateur' : 'Collaborateur'}</td>
      <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(sections)}</td>
      <td>${escapeHtml(new Date(a.created_at).toLocaleDateString('fr-FR'))}</td>
      <td>${(list.length > 1 && !isLastAdmin) ? `<button class="mini-btn danger" onclick="deleteAdminAccount(${a.id})">Retirer</button>` : `<span style="color:var(--text-muted);font-size:12.5px">${isLastAdmin ? 'Dernier admin' : 'Dernier compte'}</span>`}</td>
    </tr>
  `;
  }).join('');
}
async function deleteAdminAccount(id) {
  if (!confirm('Retirer ce compte Gestion ? Cette action est définitive.')) return;
  try {
    const res = await api(`/api/admins/${id}`, { method: 'DELETE' });
    if (res.selfDeleted) { location.reload(); return; } // on vient de se supprimer soi-même
    renderAdminsAdmin();
  } catch (err) { alert(err.message); }
}
function initAdminAccountForm() {
  const form = document.getElementById('admin-account-form');
  if (!form) return;
  const errorBox = document.getElementById('account-form-error');
  const roleSelect = document.getElementById('c-role');
  const permsGroup = document.getElementById('c-permissions-group');

  roleSelect?.addEventListener('change', () => {
    if (permsGroup) permsGroup.style.display = roleSelect.value === 'staff' ? 'block' : 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';

    const username = document.getElementById('c-username').value.trim();
    const password = document.getElementById('c-password').value;
    const confirmPwd = document.getElementById('c-password-confirm').value;
    const role = roleSelect ? roleSelect.value : 'admin';
    const permissions = Array.from(form.querySelectorAll('input[name="permissions"]:checked')).map(cb => cb.value);

    if (password !== confirmPwd) {
      errorBox.textContent = 'Les deux mots de passe ne correspondent pas.';
      errorBox.style.display = 'block';
      return;
    }
    if (role === 'staff' && permissions.length === 0) {
      errorBox.textContent = 'Cochez au moins une section pour un compte Collaborateur.';
      errorBox.style.display = 'block';
      return;
    }

    try {
      await api('/api/admins', { method: 'POST', body: JSON.stringify({ username, password, role, permissions }) });
      form.reset();
      if (permsGroup) permsGroup.style.display = 'none';
      renderAdminsAdmin();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    }
  });
}

/* --- Changer son propre mot de passe (n'importe quel compte) --- */
function initChangePasswordForm() {
  const form = document.getElementById('change-password-form');
  if (!form) return;
  const errorBox = document.getElementById('change-password-error');
  const successBox = document.getElementById('change-password-success');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.style.display = 'none';
    successBox.style.display = 'none';

    const currentPassword = document.getElementById('cp-current').value;
    const newPassword = document.getElementById('cp-new').value;
    const confirmNew = document.getElementById('cp-confirm').value;

    if (newPassword !== confirmNew) {
      errorBox.textContent = 'Les deux nouveaux mots de passe ne correspondent pas.';
      errorBox.style.display = 'block';
      return;
    }

    try {
      await api('/api/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      form.reset();
      successBox.style.display = 'block';
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.style.display = 'block';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initNavToggle();
  initSoftNav();
  initPublicArtistsPage();
  initPublicBarPage();
  initContactForm();
  initGestionPage();
  initArtistAdminForm();
  initFormuleAdminForm();
  initAdminAccountForm();
  initChangePasswordForm();
  initInvoiceForm();
  initDrinkAdminForm();
  initStockAdminForm();
  initTransactionAdminForm();
});

/* =========================================================
   NAVIGATION DOUCE ENTRE PAGES
   Remplace uniquement le contenu de <main> via fetch au lieu d'un
   rechargement complet du navigateur — le lecteur audio (en dehors de
   <main>) continue donc de jouer en changeant de page. Chaque page reste
   par ailleurs un fichier HTML complet et valide en accès direct (lien
   partagé, actualisation, etc.), c'est juste amélioré quand on clique
   depuis le site lui-même.
   ========================================================= */
function initSoftNav() {
  document.body.addEventListener('click', (e) => {
    const link = e.target.closest('a');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href || link.target === '_blank') return;
    if (!/^[a-zA-Z0-9_-]+\.html(\?.*)?$/.test(href)) return; // liens internes simples uniquement

    e.preventDefault();
    loadPageSoftly(href, true);
  });

  window.addEventListener('popstate', () => {
    const current = location.pathname.split('/').pop() || 'index.html';
    loadPageSoftly(current, false);
  });
}

async function loadPageSoftly(href, pushState) {
  const currentMain = document.querySelector('main');
  if (!currentMain) { location.href = href; return; }

  try {
    const res = await fetch(href, { credentials: 'include' });
    if (!res.ok) throw new Error('page indisponible');
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newMain = doc.querySelector('main');
    if (!newMain) throw new Error('contenu introuvable');

    currentMain.innerHTML = newMain.innerHTML;
    document.title = doc.title;

    const cleanHref = href.split('?')[0];
    document.querySelectorAll('.nav-links a').forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === cleanHref);
    });
    document.querySelector('.nav-links')?.classList.remove('open');
    const toggle = document.querySelector('.nav-toggle');
    if (toggle) toggle.textContent = '☰';

    if (pushState) history.pushState({}, '', href);
    window.scrollTo(0, 0);

    reinitPageScripts();
  } catch (err) {
    console.error('Navigation douce impossible, rechargement classique.', err);
    location.href = href;
  }
}

// Relance les initialisations spécifiques à chaque page — chaque fonction
// ne fait rien si les éléments de sa page ne sont pas présents dans le DOM.
function reinitPageScripts() {
  initPublicArtistsPage();
  initPublicBarPage();
  initContactForm();
  initGestionPage();
  initArtistAdminForm();
  initFormuleAdminForm();
  initAdminAccountForm();
  initChangePasswordForm();
  initInvoiceForm();
  initDrinkAdminForm();
  initStockAdminForm();
  initTransactionAdminForm();
}
