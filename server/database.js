// Base de données The Horde Studio.
//
// - Si TURSO_DATABASE_URL est défini (déploiement en ligne) : utilise Turso,
//   une base SQLite hébergée gratuitement dans le cloud, persistante — aucun
//   disque nécessaire côté hébergeur.
// - Sinon (développement local, sans compte Turso) : utilise un simple
//   fichier local (server/data/sunny.db), comme avant.
//
// Dans les deux cas, le reste du code (server.js) utilise les mêmes
// fonctions db.get / db.all / db.run / db.init — il n'a pas besoin de savoir
// laquelle des deux est utilisée.

const path = require('path');
const fs = require('fs');
const { createClient } = require('@libsql/client');
const { hashPassword } = require('./password-utils');

let client;
if (process.env.TURSO_DATABASE_URL) {
  client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN, // peut être vide en local avec Turso dev
  });
} else {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  client = createClient({ url: `file:${path.join(dataDir, 'sunny.db')}` });
}

// --- Petites fonctions utilitaires, mêmes noms qu'avant pour limiter les changements ---
async function run(sql, params = []) {
  const res = await client.execute({ sql, args: params });
  return { lastInsertRowid: Number(res.lastInsertRowid ?? 0), changes: res.rowsAffected };
}
async function get(sql, params = []) {
  const res = await client.execute({ sql, args: params });
  return res.rows[0];
}
async function all(sql, params = []) {
  const res = await client.execute({ sql, args: params });
  return res.rows;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    permissions TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    genre TEXT NOT NULL,
    statut TEXT DEFAULT 'Signé',
    bio TEXT DEFAULT '',
    track_titre TEXT,
    track_data TEXT,
    cover_image TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    email TEXT NOT NULL,
    sujet TEXT DEFAULT 'Autre',
    message TEXT NOT NULL,
    statut TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS formules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    prix TEXT DEFAULT '',
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS drinks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    categorie TEXT NOT NULL DEFAULT 'Non-alcoolisée',
    prix REAL NOT NULL DEFAULT 0,
    description TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    produit TEXT NOT NULL,
    quantite REAL NOT NULL DEFAULT 0,
    prix_unitaire REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('entree','depense')),
    montant REAL NOT NULL,
    categorie TEXT DEFAULT '',
    description TEXT DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    client_nom TEXT NOT NULL,
    client_email TEXT DEFAULT '',
    client_adresse TEXT DEFAULT '',
    date TEXT NOT NULL,
    items TEXT NOT NULL,
    reduction_taux REAL NOT NULL DEFAULT 0,
    notes TEXT DEFAULT '',
    statut TEXT NOT NULL DEFAULT 'En attente',
    transaction_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`;

// Ajoute une colonne à une table existante si elle n'y est pas déjà —
// nécessaire quand la base de données a été créée avant un changement de
// schéma (CREATE TABLE IF NOT EXISTS ne modifie pas une table déjà là).
// On tente directement l'ajout et on ignore l'erreur si la colonne existe
// déjà (plus fiable que de vérifier via PRAGMA, mal supporté à distance).
async function ensureColumn(table, column, type) {
  try {
    await run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`🔧 Migration : colonne "${column}" ajoutée à la table "${table}".`);
  } catch (err) {
    const msg = (err && err.message) || '';
    if (!/duplicate column|already exists/i.test(msg)) {
      console.error(`⚠️ Migration de la colonne "${column}" sur "${table}" a échoué :`, msg);
      throw err;
    }
  }
}

async function getMeta(key) {
  const row = await get('SELECT value FROM schema_meta WHERE key = ?', [key]);
  return row ? row.value : null;
}
async function setMeta(key, value) {
  await run(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

// Initialise les tables + données de démarrage. À appeler une fois avant de
// lancer le serveur (voir server.js).
async function init() {
  await client.executeMultiple(SCHEMA);

  // Migrations pour les bases créées avec un schéma plus ancien — protégées
  // par un marqueur pour ne s'exécuter qu'une seule fois (chaque tentative
  // d'ALTER TABLE compte comme une écriture, même si la colonne existe déjà :
  // inutile de les rejouer à chaque redémarrage du serveur).
  if ((await getMeta('migration_track_data')) !== 'done') {
    await ensureColumn('artists', 'track_titre', 'TEXT');
    await ensureColumn('artists', 'track_data', 'TEXT');
    await ensureColumn('artists', 'bio', "TEXT DEFAULT ''");
    await setMeta('migration_track_data', 'done');
  }
  if ((await getMeta('migration_cover_image')) !== 'done') {
    await ensureColumn('artists', 'cover_image', 'TEXT');
    await setMeta('migration_cover_image', 'done');
  }
  if ((await getMeta('migration_admin_roles')) !== 'done') {
    // DEFAULT 'admin' : les comptes déjà créés gardent leur accès complet après cette mise à jour.
    await ensureColumn('admins', 'role', "TEXT NOT NULL DEFAULT 'admin'");
    await ensureColumn('admins', 'permissions', 'TEXT');
    await setMeta('migration_admin_roles', 'done');
  }
  if ((await getMeta('migration_invoice_reduction')) !== 'done') {
    // La TVA a été remplacée par une réduction optionnelle (usage non professionnel).
    try {
      await run('ALTER TABLE invoices RENAME COLUMN tva_taux TO reduction_taux');
    } catch (err) {
      // Colonne déjà absente sous l'ancien nom (base neuve) : on s'assure juste qu'elle existe.
      await ensureColumn('invoices', 'reduction_taux', 'REAL NOT NULL DEFAULT 0');
    }
    await ensureColumn('invoices', 'transaction_id', 'INTEGER');
    await setMeta('migration_invoice_reduction', 'done');
  }

  const artistCount = (await get('SELECT COUNT(*) AS c FROM artists')).c;
  if (artistCount === 0) {
    await run(
      "INSERT INTO artists (nom, genre, statut, bio) VALUES (?, ?, ?, ?)",
      ['Vortex Noir', 'Death Metal', 'Signé', "Riffs saturés et growls venus des tréfonds — une charge frontale de bout en bout."]
    );
    await run(
      "INSERT INTO artists (nom, genre, statut, bio) VALUES (?, ?, ?, ?)",
      ['Kaïra', 'Rap Hardcore', 'Signé', "Flow tranchant, textes sans filtre. Kaïra frappe fort et raconte le quartier sans détour."]
    );
    await run(
      "INSERT INTO artists (nom, genre, statut, bio) VALUES (?, ?, ?, ?)",
      ['Les Pendus', 'Doom / Sludge', 'En discussion', "Riffs lourds, tempo funèbre. Les Pendus construisent une messe lente et écrasante."]
    );
  }

  const formuleCount = (await get('SELECT COUNT(*) AS c FROM formules')).c;
  if (formuleCount === 0) {
    await run("INSERT INTO formules (nom, prix, description) VALUES (?, ?, ?)", ['Découverte', '0 € — 15% de commission', 'Distribution digitale de base.']);
    await run("INSERT INTO formules (nom, prix, description) VALUES (?, ?, ?)", ['Pro', '49 €/mois', 'Distribution + promo playlists + booking léger.']);
    await run("INSERT INTO formules (nom, prix, description) VALUES (?, ?, ?)", ['Signature', 'Sur devis', 'Accompagnement complet façon label.']);
  }

  const drinkCount = (await get('SELECT COUNT(*) AS c FROM drinks')).c;
  if (drinkCount === 0) {
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Bière pression 25cl', 'Alcoolisée', 4.5, '']);
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Mojito', 'Alcoolisée', 8, 'Rhum, menthe, citron vert']);
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Vin rouge (verre)', 'Alcoolisée', 5, '']);
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Soda', 'Non-alcoolisée', 3, 'Coca, Sprite, Ice Tea...']);
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Eau minérale', 'Non-alcoolisée', 2, '']);
    await run("INSERT INTO drinks (nom, categorie, prix, description) VALUES (?, ?, ?, ?)", ['Jus de fruit', 'Non-alcoolisée', 3.5, '']);
  }

  const adminCount = (await get('SELECT COUNT(*) AS c FROM admins')).c;
  if (adminCount === 0 && process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD) {
    const hash = hashPassword(process.env.INITIAL_ADMIN_PASSWORD);
    await run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [process.env.INITIAL_ADMIN_USERNAME, hash]);
    console.log(`✅ Compte Gestion initial "${process.env.INITIAL_ADMIN_USERNAME}" créé automatiquement depuis les variables d'environnement.`);
  }
}

module.exports = { get, all, run, init };
