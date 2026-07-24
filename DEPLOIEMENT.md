# Déployer The Horde Studio en ligne (gratuitement, sur Render + Turso)

Guide pas à pas, sans connaissances techniques préalables. Comptez 20-25 minutes.

Le site utilise maintenant une base de données **Turso** (SQLite hébergé gratuitement dans le cloud) au lieu d'un disque local — ça permet de rester sur le plan **gratuit** de Render, qui ne supporte pas les disques persistants.

## Étape 1 — Créer la base de données sur Turso

1. Allez sur [turso.tech](https://turso.tech) et créez un compte (le plus simple : "Continue with GitHub").
2. Une fois connecté·e, créez une nouvelle base de données depuis le tableau de bord (bouton **"Create Database"** ou équivalent). Donnez-lui un nom, par exemple `sunny-record`. Choisissez une région proche de vous.
3. Une fois la base créée, ouvrez sa page de détails et cherchez :
   - L'**URL de connexion** (commence par `libsql://...`)
   - Un bouton pour créer/afficher un **token d'authentification** (auth token) — générez-en un et copiez-le
4. Gardez ces deux valeurs de côté (URL et token), on s'en sert à l'étape 4.

⚠️ Le token n'est affiché qu'une fois à sa création dans certains cas — copiez-le tout de suite dans un endroit sûr (bloc-notes) si l'interface le précise.

## Étape 2 — Mettre le projet sur GitHub

1. Créez un compte sur [github.com](https://github.com) si vous n'en avez pas.
2. **"New repository"** → nommez-le `sunny-record` → **"Create repository"** (ne cochez aucune case d'initialisation).
3. Sur la page du dépôt, **"Add file"** → **"Upload files"**.
4. Glissez-déposez tout le contenu du dossier `sunny-record` (le contenu, pas le dossier lui-même) : `public/`, `server/`, `README.md`, `.gitignore`, etc.
   - ⚠️ N'envoyez pas `server/node_modules` s'il existe chez vous.
   - ⚠️ N'envoyez pas `server/.env` (secrets) — `.env.example` suffit.
5. **"Commit changes"**.

## Étape 3 — Créer le service sur Render

1. Compte sur [render.com](https://render.com) (idéalement "Sign up with GitHub").
2. **"New +"** → **"Web Service"**.
3. **"Build and deploy from a Git repository"** → connectez GitHub si demandé → sélectionnez `sunny-record` → **"Connect"**.
4. Remplissez :

| Champ | Valeur |
|---|---|
| **Name** | `sunny-record` |
| **Root Directory** | `server` |
| **Runtime** | Node |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

**Pas besoin d'ajouter de disque cette fois** — la base de données vit sur Turso, pas sur Render.

## Étape 4 — Variables d'environnement

Section **"Environment Variables"**, ajoutez :

| Key | Value |
|---|---|
| `NODE_VERSION` | `20` |
| `SESSION_SECRET` | une longue chaîne aléatoire (40+ caractères) |
| `TURSO_DATABASE_URL` | l'URL copiée à l'étape 1 (commence par `libsql://`) |
| `TURSO_AUTH_TOKEN` | le token copié à l'étape 1 |
| `INITIAL_ADMIN_USERNAME` | l'identifiant que vous voulez pour vous connecter |
| `INITIAL_ADMIN_PASSWORD` | un mot de passe (8 caractères minimum) |

## Étape 5 — Déployer

**"Create Web Service"** en bas de page. Suivez les **"Logs"** à l'écran (2-3 minutes). Quand vous voyez `🩸 The Horde Studio — serveur lancé sur http://localhost:...`, c'est en ligne.

Votre adresse est affichée en haut de la page Render (ex. `https://sunny-record.onrender.com`). Allez sur `/gestion.html` et connectez-vous avec l'identifiant/mot de passe de l'étape 4.

## Mettre à jour le site après ce premier déploiement

Re-uploadez les fichiers modifiés sur GitHub ("Add file" → "Upload files" écrase les fichiers existants) — Render redéploie automatiquement. Vos données (artistes, messages, comptabilité...) ne sont pas affectées : elles vivent sur Turso, séparément du code.

## Limites à connaître

- **Plan gratuit Render** : le serveur s'endort après 15 minutes sans visite, et met 30-60 secondes à se réveiller à la prochaine visite. Le premier plan payant (~7$/mois) supprime cette limite.
- **Plan gratuit Turso** : très généreux pour un site comme celui-ci (plusieurs Go de stockage, des centaines de millions de lectures/mois) — largement suffisant pour démarrer.
- **Fichiers audio** : stockés directement dans la base de données (encodés), limités à 8 Mo par morceau (modifiable dans `server/server.js`, constante `MAX_AUDIO_MB`). Plus vous ajoutez de morceaux volumineux, plus l'espace utilisé sur Turso grandit — surveillez votre usage dans le tableau de bord Turso si vous en ajoutez beaucoup.

## En cas de problème

L'onglet **"Logs"** de votre service Render affiche les erreurs en direct. Copiez-collez-moi le message d'erreur (une capture d'écran fonctionne aussi) si quelque chose bloque.
