/**
 * Generates a TOTP secret for admin login MFA and prints a QR code you can
 * scan straight into Google Authenticator, Authy, 1Password, etc.
 *
 * This doesn't write anything to the database or .env for you — copy the
 * printed secret into ADMIN_TOTP_SECRET (locally in .env, or in Render's
 * Environment tab for production) and restart the server. Until that
 * variable is set, login stays password-only; setting it turns on the MFA
 * step immediately on the next login.
 *
 * Usage: npm run setup-mfa
 */
require('dotenv').config();
const { authenticator } = require('otplib');
const qrcodeTerminal = require('qrcode-terminal');

const ACCOUNT = process.env.ADMIN_USERNAME || 'admin';
const ISSUER = 'Fleet Shield (JEGASEC)';

const secret = authenticator.generateSecret();
const otpauthUri = authenticator.keyuri(ACCOUNT, ISSUER, secret);

console.log('\n=== Fleet Shield — MFA setup ===\n');
console.log('Secret (only shown once — store it somewhere safe, e.g. a password manager):');
console.log(`  ${secret}\n`);
console.log('Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.):\n');

qrcodeTerminal.generate(otpauthUri, { small: true }, (qr) => {
  console.log(qr);
  console.log('Next steps:');
  console.log('  1. Scan the QR code above (or enter the secret manually).');
  console.log('  2. Set ADMIN_TOTP_SECRET to the secret printed above:');
  console.log('       - Locally: add it to .env');
  console.log('       - Render: Environment tab → add ADMIN_TOTP_SECRET → Save (this restarts the service)');
  console.log('  3. From then on, logging in requires the password AND a 6-digit code from your app.\n');
  console.log('If you ever lose access to the authenticator app, remove ADMIN_TOTP_SECRET from the');
  console.log('environment to fall back to password-only login, then run this script again to re-enrol.\n');
});
