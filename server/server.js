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
  res.json({ ok: true, username: admin.username });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin), username: (req.session && req.session.username) || null });
});

// ==================== COMPTES GESTION (admins) ====================
// Réservé aux admins connectés. Le mot de passe n'est jamais renvoyé au client.
app.get('/api/admins', requireAdmin, h(async (req, res) => {
  res.json(await db.all('SELECT id, username, created_at FROM admins ORDER BY created_at ASC'));
}));

app.post('/api/admins', requireAdmin, h(async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Identifiant et mot de passe requis." });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });

  const existing = await db.get('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing) return res.status(409).json({ error: 'Cet identifiant existe déjà.' });

  const hash = hashPassword(password);
  const info = await db.run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
  res.json(await db.get('SELECT id, username, created_at FROM admins WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/admins/:id', requireAdmin, h(async (req, res) => {
  const total = (await db.get('SELECT COUNT(*) AS c FROM admins')).c;
  if (total <= 1) return res.status(400).json({ error: "Impossible de supprimer le dernier compte Gestion restant." });

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
app.post('/api/artists', requireAdmin, (req, res) => {
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

app.delete('/api/artists/:id', requireAdmin, h(async (req, res) => {
  await db.run('DELETE FROM artists WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== FORMULES ====================
app.get('/api/formules', h(async (req, res) => {
  res.json(await db.all('SELECT * FROM formules ORDER BY created_at ASC'));
}));

app.post('/api/formules', requireAdmin, h(async (req, res) => {
  const { nom, prix, description } = req.body;
  if (!nom) return res.status(400).json({ error: 'Le nom de la formule est obligatoire.' });
  const info = await db.run('INSERT INTO formules (nom, prix, description) VALUES (?, ?, ?)', [nom, prix || '', description || '']);
  res.json(await db.get('SELECT * FROM formules WHERE id = ?', [info.lastInsertRowid]));
}));

app.delete('/api/formules/:id', requireAdmin, h(async (req, res) => {
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
app.get('/api/messages', requireAdmin, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM messages ORDER BY created_at DESC'));
}));
app.patch('/api/messages/:id/read', requireAdmin, h(async (req, res) => {
  await db.run("UPDATE messages SET statut = 'read' WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
}));
app.delete('/api/messages/:id', requireAdmin, h(async (req, res) => {
  await db.run('DELETE FROM messages WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== BOISSONS (carte du bar) ====================
// Lecture publique (page Bar), gestion réservée aux admins.
app.get('/api/drinks', h(async (req, res) => {
  res.json(await db.all('SELECT * FROM drinks ORDER BY categorie ASC, nom ASC'));
}));

app.post('/api/drinks', requireAdmin, h(async (req, res) => {
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

app.delete('/api/drinks/:id', requireAdmin, h(async (req, res) => {
  await db.run('DELETE FROM drinks WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// ==================== COMPTABILITÉ ====================
// Tout est réservé aux admins connectés — données sensibles de l'entreprise.

// --- Entrées de stock ---
app.get('/api/stock', requireAdmin, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM stock_entries ORDER BY date DESC, created_at DESC'));
}));

app.post('/api/stock', requireAdmin, h(async (req, res) => {
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

app.delete('/api/stock/:id', requireAdmin, h(async (req, res) => {
  await db.run('DELETE FROM stock_entries WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// --- Transactions (dépenses / entrées d'argent) ---
app.get('/api/transactions', requireAdmin, h(async (req, res) => {
  res.json(await db.all('SELECT * FROM transactions ORDER BY date DESC, created_at DESC'));
}));

app.post('/api/transactions', requireAdmin, h(async (req, res) => {
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

app.delete('/api/transactions/:id', requireAdmin, h(async (req, res) => {
  await db.run('DELETE FROM transactions WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

// Résumé : solde total + totaux par semaine, pour le graphique et les cartes de synthèse
app.get('/api/transactions/summary', requireAdmin, h(async (req, res) => {
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
