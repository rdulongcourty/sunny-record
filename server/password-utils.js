// Utilitaires de hachage de mot de passe — module "crypto" natif de Node,
// aucune dépendance externe. Utilisé par server.js et create-admin.js.
const crypto = require('crypto');

const ITERATIONS = 100000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, 'hex'), ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${DIGEST}$${ITERATIONS}$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 5 || parts[0] !== 'pbkdf2') return false;
  const [, digest, iterStr, saltHex, hashHex] = parts;
  const iterations = parseInt(iterStr, 10);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = crypto.pbkdf2Sync(password || '', salt, iterations, expected.length, digest);
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
