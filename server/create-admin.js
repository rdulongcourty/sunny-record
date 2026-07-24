// Crée un compte admin directement dans la base de données.
// Le mot de passe n'est JAMAIS écrit dans un fichier de code : il est saisi
// au clavier (masqué) puis haché avant d'être stocké.
//
// Usage : node create-admin.js
const readline = require('readline');
const db = require('./database');
const { hashPassword } = require('./password-utils');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer.trim()); }));
}

// Saisie masquée (affiche des * à la place des caractères tapés)
function askPassword(question) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');

    let password = '';
    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') { // Ctrl+C
        process.exit(1);
      } else if (char === '\u007f' || char === '\b') { // retour arrière
        if (password.length) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += char;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

(async () => {
  console.log('\n🩸 The Horde Studio — création d\'un compte Gestion\n');

  await db.init(); // s'assure que la table admins existe avant de l'utiliser

  const username = await ask("Nom d'utilisateur : ");
  if (!username) { console.error('Nom d\'utilisateur obligatoire.'); process.exit(1); }

  const existing = await db.get('SELECT id FROM admins WHERE username = ?', [username]);
  if (existing) {
    const confirmOverwrite = await ask(`Le compte "${username}" existe déjà. Changer son mot de passe ? (o/N) : `);
    if (confirmOverwrite.toLowerCase() !== 'o') { console.log('Annulé.'); process.exit(0); }
  }

  const password = await askPassword('Mot de passe (8 caractères minimum) : ');
  if (!password || password.length < 8) { console.error('Mot de passe trop court (8 caractères minimum).'); process.exit(1); }

  const confirm = await askPassword('Confirmez le mot de passe : ');
  if (confirm !== password) { console.error('Les deux mots de passe ne correspondent pas.'); process.exit(1); }

  const hash = hashPassword(password);
  if (existing) {
    await db.run('UPDATE admins SET password_hash = ? WHERE id = ?', [hash, existing.id]);
    console.log(`\n✅ Mot de passe de "${username}" mis à jour.\n`);
  } else {
    await db.run('INSERT INTO admins (username, password_hash) VALUES (?, ?)', [username, hash]);
    console.log(`\n✅ Compte "${username}" créé. Vous pouvez vous connecter sur la page Gestion.\n`);
  }
  process.exit(0);
})();
