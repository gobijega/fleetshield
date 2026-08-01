/**
 * Generates a bcrypt hash for ADMIN_PASSWORD_HASH.
 * Usage: npm run hash-password -- "your-password"
 */
const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your-password"');
  process.exit(1);
}

console.log(bcrypt.hashSync(password, 10));
