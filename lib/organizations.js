/**
 * Organization (tenant) data access. Each signed-up customer — plus the
 * pre-existing single-admin deployment, preserved as the 'default' org — is
 * a row here. One admin login per org (no multi-user-per-org roles yet,
 * matching the MVP's existing single-admin-account scope, just replicated
 * per tenant instead of hardcoded to one env-var-configured account).
 */
const crypto = require('crypto');

function newOrgId() {
  return `org_${crypto.randomBytes(9).toString('hex')}`;
}

async function findOrgByUsername(db, username) {
  const { rows } = await db.query(
    'SELECT * FROM organizations WHERE admin_username = $1',
    [username]
  );
  return rows[0] || null;
}

async function findOrgById(db, id) {
  const { rows } = await db.query('SELECT * FROM organizations WHERE id = $1', [id]);
  return rows[0] || null;
}

async function listOrgs(db) {
  const { rows } = await db.query('SELECT * FROM organizations ORDER BY created_at');
  return rows;
}

async function createOrganization(db, { name, contactName, contactEmail, adminUsername, adminPasswordHash }) {
  const id = newOrgId();
  const { rows } = await db.query(
    `INSERT INTO organizations (id, name, contact_name, contact_email, admin_username, admin_password_hash)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [id, name, contactName || null, contactEmail, adminUsername, adminPasswordHash]
  );
  return rows[0];
}

// Idempotent bootstrap of the legacy single-admin deployment as a real org
// row, run at boot from the existing ADMIN_USERNAME/ADMIN_PASSWORD_HASH env
// vars if present. ON CONFLICT so it's safe to run on every boot; updates
// the password hash/username each boot so rotating ADMIN_PASSWORD_HASH via
// Render env vars (documented in DEPLOY.md) keeps working exactly as before.
async function upsertDefaultOrg(db, { username, passwordHash, totpSecret }) {
  await db.query(
    `INSERT INTO organizations (id, name, contact_email, admin_username, admin_password_hash, admin_totp_secret, subscription_status)
     VALUES ('default', 'Fleet Shield (default)', 'hello@jegasec.com', $1, $2, $3, 'active')
     ON CONFLICT (id) DO UPDATE SET
       admin_username = EXCLUDED.admin_username,
       admin_password_hash = EXCLUDED.admin_password_hash,
       admin_totp_secret = EXCLUDED.admin_totp_secret`,
    [username, passwordHash, totpSecret || null]
  );
}

async function setStripeCustomer(db, orgId, stripeCustomerId) {
  await db.query('UPDATE organizations SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, orgId]);
}

async function setStripeSubscription(db, orgId, { subscriptionId, subItemId, status }) {
  await db.query(
    `UPDATE organizations
     SET stripe_subscription_id = $1, stripe_sub_item_id = $2, subscription_status = $3
     WHERE id = $4`,
    [subscriptionId, subItemId, status, orgId]
  );
}

async function setSubscriptionStatusByCustomer(db, stripeCustomerId, status) {
  const { rows } = await db.query(
    `UPDATE organizations SET subscription_status = $1 WHERE stripe_customer_id = $2 RETURNING id`,
    [status, stripeCustomerId]
  );
  return rows[0] || null;
}

async function findOrgByStripeCustomer(db, stripeCustomerId) {
  const { rows } = await db.query('SELECT * FROM organizations WHERE stripe_customer_id = $1', [stripeCustomerId]);
  return rows[0] || null;
}

module.exports = {
  newOrgId,
  findOrgByUsername,
  findOrgById,
  listOrgs,
  createOrganization,
  upsertDefaultOrg,
  setStripeCustomer,
  setStripeSubscription,
  setSubscriptionStatusByCustomer,
  findOrgByStripeCustomer,
};
