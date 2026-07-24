# The Horde Studio — site web + base de données

Le site a maintenant une vraie base de données derrière : les artistes, les demandes
de contact et les formules sont stockés dans un fichier de base de données
(SQLite) sur le serveur, partagés entre tous les navigateurs/appareils —
contrairement à une simple démo qui ne stockait les données que dans votre
navigateur.

## Structure du projet

```
sunny-record/
├── public/          → le site (pages HTML, CSS, JS) — servi par le serveur
│   ├── index.html, artistes.html, formules.html, contact.html, gestion.html
│   ├── css/style.css
│   └── js/main.js
└── server/          → le serveur + la base de données
    ├── server.js           (le serveur qui répond aux pages et à l'API)
    ├── database.js         (connexion à la base — Turso en ligne, fichier local en dev)
    ├── password-utils.js   (hachage/vérification des mots de passe)
    ├── create-admin.js     (créer ou changer le mot de passe d'un compte Gestion)
    ├── package.json
    ├── .env                 (réglages non sensibles : port, secret de session, Turso)
    └── data/sunny.db        (base de données locale — utilisée seulement en dev, sans Turso)
```

En local (votre ordinateur), sans rien configurer, le site utilise un simple fichier `server/data/sunny.db`. En ligne (Render ou autre), on utilise **Turso**, une base de données gratuite hébergée dans le cloud — voir `DEPLOIEMENT.md`. Les fichiers audio importés sont stockés directement dans la base de données (encodés), plus besoin de dossier séparé.

## Installation (une seule fois)

Il faut avoir **Node.js** installé sur votre ordinateur (téléchargeable sur [nodejs.org](https://nodejs.org), prenez la version "LTS").

1. Ouvrez un terminal dans le dossier `server/`
2. Installez les dépendances :
   ```
   cd server
   npm install
   ```
   Cela télécharge les quelques bibliothèques nécessaires (une seule fois, il faut une connexion internet à ce moment-là).
3. Créez votre premier compte Gestion :
   ```
   node create-admin.js
   ```
   (identifiant + mot de passe, voir section dédiée plus bas)

## Lancer le site

À chaque fois que vous voulez utiliser le site :

```
cd server
npm start
```

Puis ouvrez **http://localhost:3000** dans votre navigateur. C'est cette adresse qu'il faut utiliser — pas de double-clic sur les fichiers `.html`.

Le serveur affiche `🩸 The Horde Studio — serveur lancé sur http://localhost:3000` quand tout fonctionne. Laissez le terminal ouvert tant que vous utilisez le site ; pour l'arrêter, faites `Ctrl+C` dans le terminal.

## Se connecter à l'espace Gestion — comptes multiples

Il n'y a **plus de mot de passe unique écrit dans le code**. À la place, chaque personne a son propre compte (identifiant + mot de passe), stocké dans la base de données avec un mot de passe haché (jamais en clair, jamais lisible même en regardant le code).

### Un premier compte est déjà créé pour vous

- Identifiant : **Gouvernement**
- Mot de passe : **Sunny2026**

Connectez-vous avec ces identifiants dès le premier lancement. Comme ce mot de passe a été échangé ici en clair (dans cette conversation), **changez-le dès que possible** une fois connecté·e (voir "Changer un mot de passe" ci-dessous), ou créez votre compte définitif et supprimez celui-ci.

### Créer le tout premier compte

Avant la toute première connexion, il faut créer un compte depuis le terminal (une seule fois) :
```
cd server
node create-admin.js
```
Le script demande un identifiant puis un mot de passe (saisie masquée avec des `*`, comme sur la plupart des sites). 8 caractères minimum.

### Créer les comptes suivants

Deux façons de faire :
- **Depuis le site** (recommandé) : une fois connecté·e, allez dans Gestion → onglet **Comptes** → remplissez identifiant + mot de passe + confirmation → « Créer le compte ». La personne concernée peut ensuite se connecter directement.
- **Depuis le terminal** : relancez `node create-admin.js` avec un nouvel identifiant.

### Changer un mot de passe

Relancez `node create-admin.js` en indiquant le même identifiant : le script propose de mettre à jour le mot de passe existant.

### Retirer un compte

Depuis Gestion → onglet Comptes → bouton « Retirer » sur la ligne du compte concerné. Le dernier compte restant ne peut pas être supprimé (pour éviter de se retrouver bloqué·e dehors).

## Ce qui a changé par rapport à la version précédente (sans base de données)

- **Artistes** : ajoutés depuis Gestion → onglet Artistes (nom, genre, statut, bio, morceau audio en un seul formulaire). Visibles immédiatement sur `artistes.html`, pour tout le monde, sur n'importe quel appareil.
- **Messages de contact** : chaque message envoyé depuis `contact.html` est enregistré en base et visible dans Gestion → onglet Demandes de contact.
- **Formules** : gérables depuis Gestion → onglet Formules (ce tableau est un espace de suivi interne ; la page publique `formules.html` reste rédigée à la main — dites-moi si vous voulez que les deux soient reliées).
- **Connexion admin** : comptes multiples avec identifiant + mot de passe individuel, haché en base (voir section dédiée plus haut) — plus aucun mot de passe écrit dans le code ou dans un fichier de configuration.
- **Fichiers audio** : stockés directement dans la base de données (encodés) — limite actuelle : 8 Mo par fichier, modifiable dans `server/server.js`, constante `MAX_AUDIO_MB`.
- **Pochette d'album** : optionnelle, ajoutée en même temps que l'artiste dans Gestion (image, 4 Mo max — constante `MAX_COVER_MB`), stockée elle aussi directement en base.
- **Lecteur audio persistant** : cliquer sur « Écouter » sur la page Artistes fait apparaître un petit lecteur flottant en bas à droite (lecture/pause à tout moment) qui continue de jouer même en changeant de page — grâce à une navigation "douce" en interne (le contenu se met à jour sans recharger complètement le navigateur). Chaque page reste malgré tout un fichier HTML valide en accès direct (lien partagé, actualisation du navigateur, etc.).
- **Rôles et permissions** : chaque compte est soit **Administrateur** (accès total, y compris la gestion des autres comptes), soit **Collaborateur** (accès limité aux sections cochées à sa création : Contact, Artistes, Formules, Bar, Comptabilité). Un Collaborateur ne voit que les onglets Gestion pour lesquels il a un droit — les autres sont masqués. Choisissez le type de compte et les sections dans Gestion → Comptes → « Créer un accès pour quelqu'un d'autre » (réservé aux Administrateurs).
- **Changer son mot de passe** : chaque personne connectée peut changer son propre mot de passe dans Gestion → Comptes → « Mon compte », sans avoir besoin de droits particuliers.
- **Bar** : nouvelle page publique `bar.html` avec la carte des boissons (alcoolisées / non-alcoolisées), gérée depuis Gestion → onglet Bar.
- **Comptabilité** : nouvel onglet dans Gestion, réservé aux comptes connectés, avec :
  - un total des entrées, un total des dépenses et le **solde de la société**, mis à jour en temps réel ;
  - un **graphique par semaine** (entrées vs dépenses) sur les 12 dernières semaines actives ;
  - des **entrées de stock** (produit, quantité, prix unitaire, date, notes) ;
  - des **transactions** (entrée d'argent ou dépense, montant, catégorie, description, date).

### À savoir sur la Comptabilité

- Les montants sont stockés en euros, avec deux décimales.
- Le graphique regroupe les transactions par semaine ISO (du lundi au dimanche) — les 12 semaines les plus récentes ayant eu au moins un mouvement sont affichées.
- Toutes les routes de comptabilité (`/api/stock`, `/api/transactions`, etc.) sont réservées aux comptes connectés : personne d'extérieur ne peut y accéder, même en devinant l'adresse.
- Le graphique utilise la bibliothèque **Chart.js**, chargée depuis un CDN (`cdn.jsdelivr.net`) — une connexion internet est donc nécessaire pour l'afficher, même si le reste du site tourne en local.

## Sauvegarder vos données

- **En local (sans Turso)** : tout vit dans `server/data/sunny.db` (artistes, messages, formules, audio encodé) — une simple copie de ce fichier suffit.
- **En ligne (avec Turso)** : vos données vivent sur Turso, pas sur votre ordinateur ni sur Render. Turso propose des sauvegardes/point-in-time restore dans son tableau de bord — consultez [docs.turso.tech](https://docs.turso.tech) pour l'export/la sauvegarde si vous voulez une copie locale de temps en temps.

## Mettre le site en ligne pour de vrai (accessible depuis Internet)

⚠️ **Vercel ne convient pas à ce projet** (fonctions "serverless" sans stockage persistant). Ce site utilise **Render** (serveur) + **Turso** (base de données gratuite dans le cloud) — cette combinaison reste 100% gratuite pour démarrer, sans avoir besoin d'un disque persistant payant.

Le guide complet, pas à pas, pour déployer sur **Render** se trouve dans **`DEPLOIEMENT.md`** à la racine du projet.

## Palette & typographie (rappel)

- Couleurs : fond noir-violet profond (`#0B0710`), violet (`#6B2FA8` / `#B47AFF`), accent doré "soleil" (`#F4A736`).
- Typographies : Space Grotesk (titres), Inter (texte courant), JetBrains Mono (étiquettes/codes).
