require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const db = require('./database');
const { hashPassword, verifyPassword } = require('./password-utils');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_AUDIO_MB = 8;

// Nécessaire derrière un proxy HTTPS (Render, etc.) pour que les cookies "secure" fonctionnent.
app.set('trust proxy', 1);

app.use(express.json());

// --- Sessions (connexion admin) ---
app.use(session({
  secret: process.env.SESSION_SECRET || 'change_moi',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 } // 8h
}));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Non autorisé — merci de vous connecter.' });
}

// Sections d'accès possibles pour un compte "Collaborateur" à droits limités.
const PERMISSION_KEYS = ['messages', 'artists', 'formules', 'bar', 'compta', 'factures'];

// Seuls les comptes "Administrateur" ont un accès total et peuvent gérer les
// autres comptes ; un compte "Collaborateur" n'a que les sections cochées à
// sa création (voir req.session.permissions).
function requirePermission(key) {
  return (req, res, next) => {
    if (!req.session || !req.session.isAdmin) {
      return res.status(401).json({ error: 'Non autorisé — merci de vous connecter.' });
    }
    if (req.session.role === 'admin') return next();
    const perms = req.session.permissions || [];
    if (perms.includes(key)) return next();
    return res.status(403).json({ error: "Vous n'avez pas accès à cette section." });
  };
}

// Réservé strictement aux comptes "Administrateur" (gestion des comptes eux-mêmes).
function requireSuperAdmin(req, res, next) {
  if (req.session && req.session.isAdmin && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Seul un compte Administrateur peut faire ça.' });
}

// --- Upload audio + pochette ---
// Les fichiers sont gardés en mémoire (pas sur disque) puis encodés en base64
// et stockés directement dans la base de données Turso — aucun disque
// persistant nécessaire.
const MAX_COVER_MB = 4;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AUDIO_MB * 1024 * 1024 }, // limite haute commune ; on affine par champ ci-dessous
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'audio' && !file.mimetype.startsWith('audio/')) {
      return cb(new Error('Seuls les fichiers audio sont acceptés pour le morceau.'));
    }
    if (file.fieldname === 'cover' && !file.mimetype.startsWith('image/')) {
      return cb(new Error('Seuls les fichiers image sont acceptés pour la pochette.'));
    }
    cb(null, true);
  }
});
const uploadArtistFiles = upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'cover', maxCount: 1 }]);

// Petit utilitaire pour éviter un try/catch dans chaque route async
function h(fn) {
  return (req, res) => fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: "Erreur serveur. Réessayez, ou contactez la personne qui gère le site." });
  });
}

// --- Vérification de mot de passe : voir server/password-utils.js (PBKDF2 natif, aucune dépendance externe) ---

// ==================== AUTH ====================
app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });

  const admin = await db.get('SELECT * FROM admins WHERE username = ?', [username]);
  if (!admin || !verifyPassword(password, admin.password_hash)) {
    return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
  }
  req.session.isAdmin = true;
  req.session.adminId = admin.id;
  req.session.username = admin.username;
  req.session.role = admin.role || 'admin';
  req.session.permissions = admin.permissions ? JSON.parse(admin.permissions) : [];
  res.json({ ok: true, username: admin.username, role: req.session.role, permissions: req.session.permissions });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  if (!req.session || !req.session.isAdmin) return res.json({ isAdmin: false, username: null });
  res.json({
    isAdmin: true,
    username: req.session.username,
    role: req.session.role || 'admin',
    permissions: req.session.permissions || [],
  });
});

// Changement de mot de passe par la personne elle-même (n'importe quel compte
// connecté, quels que soient ses droits — ça ne concerne que son propre compte).
app.post('/api/change-password', requireAdmin, h(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Mot de passe actuel et nouveau mot de passe requis.' });
  if (newPassword.length < 8) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 8 caractères.' });

  const admin = await db.get('SELECT * FROM admins WHERE id = ?', [req.session.adminId]);
  if (!admin || !verifyPassword(currentPassword, admin.password_hash)) {
    return res.status(401).json({ error: 'Mot de passe actuel incorrect.' });
  }
  const hash = hashPassword(newPassword);
  await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, admin.id]);
  res.json({ ok: true });
}));

// ==================== COMPTES GESTION (admins) ====================
// Réservé aux comptes "Administrateur". Le mot de passe n'est jamais renvoyé au client.
app.get('/api/admins', requireSuperAdmin, h(async (req, res) => {
  const rows = await db.all('SELECT id, username, role, permissions, created_at FROM admins ORDER BY created_at ASC');
  res.json(rows.map(r => ({ ...r, permissions: r.permissions ? JSON.parse(r.permissions) : [] })));
}));

app.post('/api/admins', requireSuperAdmin, h(async (req, res) => {
  const { username, password, role, permissions } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });

  const finalRole = role === 'staff' ? 'staff' : 'admin';
  let finalPermissions = null;
  if (finalRole === 'staff') {
    const perms = Array.isArray(permissions) ? permissions.filter(p => PERMISSION_KEYS.includes(p)) : [];
    finalPermissions = JSON.stringify(perms);
  }

  const existing = await db.get('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing) return res.status(409).json({ error: 'Cet identifiant existe déjà.' });

  const hash = hashPassword(password);
  const info = await db.run(
    'INSERT INTO admins (username, password_hash, role, permissions) VALUES (?, ?, ?, ?)',
    [username, hash, finalRole, finalPermissions]
  );
  const created = await db.get('SELECT id, username, role, permissions, created_at FROM admins WHERE id = ?', [info.lastInsertRowid]);
  res.json({ ...created, permissions: created.permissions ? JSON.parse(created.permissions) : [] });
}));

app.delete('/api/admins/:id', requireSuperAdmin, h(async (req, res) => {
  const total = (await db.get('SELECT COUNT(*) AS c FROM admins')).c;
  if (total <= 1) return res.status(400).json({ error: "Impossible de supprimer le dernier compte Gestion restant." });

  const target = await db.get('SELECT role FROM admins WHERE id = ?', [req.params.id]);
  if (target && target.role === 'admin') {
    const adminCount = (await db.get("SELECT COUNT(*) AS c FROM admins WHERE role = 'admin'")).c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: "Impossible de supprimer le dernier compte Administrateur — il ne resterait plus personne pour gérer les comptes." });
    }
  }

  await db.run('DELETE FROM admins WHERE id = ?', [req.params.id]);

  // Si l'admin vient de supprimer son propre compte, on ferme sa session avant de répondre.
  if (req.session.adminId === Number(req.params.id)) {
    return req.session.destroy(() => res.json({ ok: true, selfDeleted: true }));
  }
  res.json({ ok: true });
}));

// ==================== ARTISTES ====================
// Lecture publique (page Artistes + onglet Gestion).
// On exclut volontairement track_data (le fichier audio, jusqu'à 8 Mo) de la
// liste : le charger pour chaque artiste rendait la page lente. Il n'est
// récupéré qu'à la demande, via /api/artists/:id/track, quand on clique
// vraiment sur "Écouter". La pochette (plus légère) reste incluse.
app.get('/api/artists', h(async (req, res) => {
  const rows = await db.all(
    `SELECT id, nom, genre, statut, bio, track_titre, cover_image, created_at,
            (track_data IS NOT NULL) AS has_track
     FROM artists ORDER BY created_at DESC`
  );
  res.json(rows);
}));

// Récupère le morceau audio d'un artiste précis, uniquement au moment de l'écoute.
app.get('/api/artists/:id/track', h(async (req, res) => {
  const row = await db.get('SELECT track_data, track_titre FROM artists WHERE id = ?', [req.params.id]);
  if (!row || !row.track_data) return res.status(404).json({ error: 'Aucun morceau pour cet artiste.' });
  res.json(row);
}));

// Ajout : réservé aux admins connectés, upload audio + pochette inclus dans le même formulaire
app.post('/api/artists', requirePermission('artists'), (req, res) => {
  uploadArtistFiles(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { nom, genre, statut, bio, trackTitre } = req.body;
      if (!nom || !genre) return res.status(400).json({ error: 'Le nom et le genre sont obligatoires.' });

      const audioFile = req.files?.audio?.[0];
      const coverFile = req.files?.cover?.[0];

      if (coverFile && coverFile.size > MAX_COVER_MB * 1024 * 1024) {
        return res.status(400).json({ error: `La pochette est trop lourde (max ${MAX_COVER_MB} Mo).` });
      }

      let trackData = null;
      let finalTitre = null;
      if (audioFile) {
        trackData = `data:${audioFile.mimetype};base64,${audioFile.buffer.toString('base64')}`;
        finalTitre = (trackTitre && trackTitre.trim()) ? trackTitre.trim() : audioFile.originalname.replace(/\.[^.]+$/, '');
      }

      let coverData = null;
      if (coverFile) {
        coverData = `data:${coverFile.mimetype};base64,${coverFile.buffer.toString('base64')}`;
      }

      const info = await db.run(
        'INSERT INTO artists (nom, genre, statut, bio, track_titre, track_data, cover_image) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [nom, genre, statut || 'Signé', bio || '', finalTitre, trackData, coverData]
      );
      res.json(await db.get('SELECT * FROM artists WHERE id = ?', [info.lastInsertRowid]));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Erreur serveur.' });
    }
  });
});

app.delete('/api/artists/:id', requirePermission('artists'), h(async (req, res) => {
  await db.run('DELETE FROM artists WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== FORMULES ====================
app.get('/api/formules', h(async (req, res) => {
  res.json(await db.all('SELECT * FROM formules ORDER BY created_at ASC'));
}));

app.post('/api/formules', requirePermission('formules'), h(async (req, res) => {
  const { nom, prix, description } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom de la formule est obligatoire.' });
  const info = await db.run('INSERT INTO formules (nom, prix, description) VALUES (?, ?, ?)', [nom, prix || '', description || '']);
  res.json(await db.get('SELECT * FROM formules WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/formules/:id', requirePermission('formules'), h(async (req, res) => {
  await db.run('DELETE FROM formules WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== MESSAGES (contact) ====================
// Envoi : public (n'importe quel visiteur du site)
app.post('/api/messages', h(async (req, res) => {
  const { nom, email, sujet, message } = req.body;
  if (!nom || !email || !message) return res.status(400).json({ error: 'Nom, email et message sont obligatoires.' });
  const info = await db.run('INSERT INTO messages (nom, email, sujet, message) VALUES (?, ?, ?, ?)', [nom, email, sujet || 'Autre', message]);
  res.json(await db.get('SELECT * FROM messages WHERE id = ?', [info.lastInsertRowid]));
}));

// Lecture / gestion : réservé aux admins
app.get('/api/messages', requirePermission('messages'), h(async (req, res) => {
  res.json(await db.all('SELECT * FROM messages ORDER BY created_at DESC'));
}));
app.patch('/api/messages/:id/read', requirePermission('messages'), h(async (req, res) => {
  await db.run("UPDATE messages SET statut = 'read' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/messages/:id', requirePermission('messages'), h(async (req, res) => {
  await db.run('DELETE FROM messages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== BOISSONS (carte du bar) ====================
// Lecture publique (page Bar), gestion réservée aux admins.
app.get('/api/drinks', h(async (req, res) => {
  res.json(await db.all('SELECT * FROM drinks ORDER BY categorie ASC, nom ASC'));
}));

app.post('/api/drinks', requirePermission('bar'), h(async (req, res) => {
  const { nom, categorie, prix, description } = req.body;
  if (!nom || prix === undefined || prix === '') return res.status(400).json({ error: 'Le nom et le prix sont obligatoires.' });
  const prixNum = parseFloat(String(prix).replace(',', '.'));
  if (isNaN(prixNum) || prixNum < 0) return res.status(400).json({ error: 'Prix invalide.' });

  const info = await db.run(
    'INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)',
    [nom, categorie || 'Non-alcoolisée', prixNum, description || '']
  );
  res.json(await db.get('SELECT * FROM drinks WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/drinks/:id', requirePermission('bar'), h(async (req, res) => {
  await db.run('DELETE FROM drinks WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== COMPTABILITÉ ====================
// Tout est réservé aux admins connectés — données sensibles de l'entreprise.

// --- Entrées de stock ---
app.get('/api/stock', requirePermission('compta'), h(async (req, res) => {
  res.json(await db.all('SELECT * FROM stock_entries ORDER BY date DESC, created_at DESC'));
}));

app.post('/api/stock', requirePermission('compta'), h(async (req, res) => {
  const { produit, quantite, prix_unitaire, date, notes } = req.body;
  if (!produit || quantite === undefined || !date) {
    return res.status(400).json({ error: 'Produit, quantité et date sont obligatoires.' });
  }
  const qte = parseFloat(String(quantite).replace(',', '.'));
  const prixU = parseFloat(String(prix_unitaire || 0).replace(',', '.'));
  if (isNaN(qte)) return res.status(400).json({ error: 'Quantité invalide.' });

  const info = await db.run(
    'INSERT INTO stock_entries (produit, quantite, prix_unitaire, date, notes) VALUES (?, ?, ?, ?, ?)',
    [produit, qte, isNaN(prixU) ? 0 : prixU, date, notes || '']
  );
  res.json(await db.get('SELECT * FROM stock_entries WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/stock/:id', requirePermission('compta'), h(async (req, res) => {
  await db.run('DELETE FROM stock_entries WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// --- Transactions (dépenses / entrées d'argent) ---
app.get('/api/transactions', requirePermission('compta'), h(async (req, res) => {
  res.json(await db.all('SELECT * FROM transactions ORDER BY date DESC, created_at DESC'));
}));

app.post('/api/transactions', requirePermission('compta'), h(async (req, res) => {
  const { type, montant, categorie, description, date } = req.body;
  if (!type || !['entree', 'depense'].includes(type)) return res.status(400).json({ error: "Type invalide (entrée ou dépense)." });
  if (montant === undefined || montant === '' || !date) return res.status(400).json({ error: 'Montant et date sont obligatoires.' });
  const montantNum = parseFloat(String(montant).replace(',', '.'));
  if (isNaN(montantNum) || montantNum < 0) return res.status(400).json({ error: 'Montant invalide.' });

  const info = await db.run(
    'INSERT INTO transactions (type, montant, categorie, description, date) VALUES (?, ?, ?, ?, ?)',
    [type, montantNum, categorie || '', description || '', date]
  );
  res.json(await db.get('SELECT * FROM transactions WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/transactions/:id', requirePermission('compta'), h(async (req, res) => {
  await db.run('DELETE FROM transactions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Résumé : solde total + totaux par semaine, pour le graphique et les cartes de synthèse
app.get('/api/transactions/summary', requirePermission('compta'), h(async (req, res) => {
  const rows = await db.all('SELECT type, montant, date FROM transactions');

  let totalEntrees = 0, totalDepenses = 0;
  const weekly = {}; // clé "2026-S29" -> { entrees, depenses }

  function isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return 'Inconnue';
    const target = new Date(d.valueOf());
    const dayNr = (d.getDay() + 6) % 7; // lundi = 0
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = new Date(target.getFullYear(), 0, 4);
    const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
    return `${target.getFullYear()}-S${String(week).padStart(2, '0')}`;
  }

  for (const r of rows) {
    if (r.type === 'entree') totalEntrees += r.montant; else totalDepenses += r.montant;
    const key = isoWeekKey(r.date);
    if (!weekly[key]) weekly[key] = { semaine: key, entrees: 0, depenses: 0 };
    if (r.type === 'entree') weekly[key].entrees += r.montant; else weekly[key].depenses += r.montant;
  }

  const weeklyList = Object.values(weekly).sort((a, b) => a.semaine.localeCompare(b.semaine)).slice(-12);

  res.json({
    totalEntrees,
    totalDepenses,
    solde: totalEntrees - totalDepenses,
    weekly: weeklyList,
  });
}));

// ==================== FACTURES ====================
// Tout est réservé aux comptes ayant le droit "factures".
app.get('/api/invoices', requirePermission('factures'), h(async (req, res) => {
  const rows = await db.all('SELECT * FROM invoices ORDER BY created_at DESC');
  res.json(rows.map(r => ({ ...r, items: JSON.parse(r.items) })));
}));

app.post('/api/invoices', requirePermission('factures'), h(async (req, res) => {
  const { client_nom, client_email, client_adresse, date, items, tva_taux, notes } = req.body;

  if (!client_nom) return res.status(400).json({ error: 'Le nom du client est obligatoire.' });
  if (!date) return res.status(400).json({ error: 'La date est obligatoire.' });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Ajoutez au moins une ligne à la facture.' });

  const cleanItems = [];
  for (const it of items) {
    const description = (it.description || '').trim();
    const quantite = parseFloat(it.quantite);
    const prixUnitaire = parseFloat(it.prix_unitaire);
    if (!description) return res.status(400).json({ error: 'Chaque ligne doit avoir une description.' });
    if (isNaN(quantite) || quantite <= 0) return res.status(400).json({ error: `Quantité invalide pour "${description}".` });
    if (isNaN(prixUnitaire) || prixUnitaire < 0) return res.status(400).json({ error: `Prix invalide pour "${description}".` });
    cleanItems.push({ description, quantite, prix_unitaire: prixUnitaire });
  }

  const tvaTaux = tva_taux === undefined || tva_taux === '' ? 20 : parseFloat(tva_taux);
  if (isNaN(tvaTaux) || tvaTaux < 0) return res.status(400).json({ error: 'Taux de TVA invalide.' });

  // Numérotation automatique : FA-<année>-<numéro séquentiel sur 4 chiffres>
  const year = new Date(date).getFullYear() || new Date().getFullYear();
  const countRow = await db.get("SELECT COUNT(*) AS c FROM invoices WHERE numero LIKE ?", [`FA-${year}-%`]);
  const numero = `FA-${year}-${String(countRow.c + 1).padStart(4, '0')}`;

  const info = await db.run(
    `INSERT INTO invoices (numero, client_nom, client_email, client_adresse, date, items, tva_taux, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [numero, client_nom, client_email || '', client_adresse || '', date, JSON.stringify(cleanItems), tvaTaux, notes || '']
  );
  const created = await db.get('SELECT * FROM invoices WHERE id = ?', [info.lastInsertRowid]);
  res.json({ ...created, items: JSON.parse(created.items) });
}));

app.patch('/api/invoices/:id/statut', requirePermission('factures'), h(async (req, res) => {
  const { statut } = req.body;
  if (!['En attente', 'Payée'].includes(statut)) return res.status(400).json({ error: 'Statut invalide.' });
  await db.run('UPDATE invoices SET statut = ? WHERE id = ?', [statut, req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/invoices/:id', requirePermission('factures'), h(async (req, res) => {
  await db.run('DELETE FROM invoices WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== FICHIERS STATIQUES ====================
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== DÉMARRAGE ====================
// On initialise la base (création des tables + données de départ) avant
// d'accepter des requêtes.
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🩸 The Horde Studio — serveur lancé sur http://localhost:${PORT}\n`);
    });
  })
  .catch((err) => {
    console.error('❌ Impossible d\'initialiser la base de données :', err.message);
    process.exit(1);
  });
