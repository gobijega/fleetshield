/**
 * Generates a bcrypt hash for ADMIN_PASSWORD_HASH.
 * Usage: npm run hash-password -- "your-password"
 */
const bcrypt = require('bcryptjs');

const MIN_LENGTH = 12;

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your-password"');
  process.exit(1);
}

if (password.length < MIN_LENGTH) {
  console.error(
    `Password is too short (${password.length} chars) — this account protects a fleet-wide ` +
    `dashboard for a council/utility/government customer, so use at least ${MIN_LENGTH} characters. ` +
    `A passphrase of 4-5 random words is easier to remember than it is to guess.`
  );
  process.exit(1);
}

console.log(bcrypt.hashSync(password, 10));
