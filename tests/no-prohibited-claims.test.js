// Build-time-equivalent claims check for Fleet Shield's static public
// surface (public/) and protected dashboard shell (protected/). Fleet
// Shield has no bundler/build step — these files are served as-is — so
// this test checks the actual served files directly rather than a
// separate dist/ output.
//
// Run with: node --test tests/*.test.js (or `npm test`)

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIRS_TO_CHECK = [
  path.join(__dirname, '..', 'public'),
  path.join(__dirname, '..', 'protected'),
];

const PROHIBITED_PATTERNS = [
  /hardware-flexible/i,
  /works with existing fleet hardware/i,
  /live gps tracking/i,
  /launch fleet shield/i,
  /\bcreate an account\b/i,
  /\bstart free trial\b/i,
  /\bbegin checkout\b/i,
  /\breal customers\b/i,
  /\bproduction customers\b/i,
  /\bgovernment customers\b/i,
  /\btrusted by\b/i,
  /\bproduction[\s-]ready\b/i,
  /\bcancel anytime\b/i,
  /active council fleet\b(?!\s+demonstrating)/i, // "Simulated ... council fleet demonstrating..." is fine; a bare claim is not
  // Fleet Shield is provided by JEGASEC PTY LTD (ACN 701 612 277). Guard
  // against the superseded sole-trader identity creeping back in, and
  // against inventing a company name that doesn't exist.
  /jegasec defence technologies pty ltd/i,
  /trading as jegasec defence technologies/i,
  /not currently an incorporated company/i,
];

function walkFiles(dir, extensions) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, extensions));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

describe('Legal documents name the incorporated entity', () => {
  test('every legal page and page footnote identifies JEGASEC PTY LTD with its ABN', () => {
    const pages = ['terms.html', 'privacy.html', 'billing-terms.html', 'acceptable-use.html', 'login.html', 'signup.html', 'signup-success.html'];
    for (const page of pages) {
      const content = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
      assert.match(content, /JEGASEC PTY LTD/, `${page} should name JEGASEC PTY LTD`);
      assert.match(content, /ABN 54 701 612 277/, `${page} should carry the company ABN`);
    }
  });

  test('the old sole-trader ABN only appears in the Terms transition notice', () => {
    const files = DIRS_TO_CHECK.flatMap((d) => walkFiles(d, ['.html', '.js']));
    const hits = files
      .filter((f) => fs.readFileSync(f, 'utf8').includes('93 582 150 337'))
      .map((f) => path.basename(f));
    assert.deepEqual(hits, ['terms.html']);
  });
});

describe('Prohibited public claims must not appear in served Fleet Shield files', () => {
  test('no prohibited phrase appears in public/ or protected/ HTML/JS', () => {
    const files = DIRS_TO_CHECK.flatMap((d) => walkFiles(d, ['.html', '.js']));
    assert.ok(files.length > 0, 'expected at least one file to check');

    const violations = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of PROHIBITED_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.relative(path.join(__dirname, '..'), file)}: matched ${pattern}`);
        }
      }
    }
    assert.deepEqual(violations, [], `Prohibited claims found:\n${violations.join('\n')}`);
  });

  test('"Continue to payment" only appears inside an authenticated add-vehicle/checkout flow, never on a public signup path', () => {
    // Distinct from the generic sweep above: "Continue to payment" is a
    // legitimate label for the *existing customer* add-vehicle Stripe
    // Checkout button (protected/), which is a real, working payment flow
    // for already-approved accounts — not a public self-service claim.
    // This test asserts it does NOT appear anywhere under public/ (which
    // unauthenticated visitors can reach).
    const publicFiles = walkFiles(path.join(__dirname, '..', 'public'), ['.html', '.js']);
    const hits = publicFiles.filter((f) => /continue to payment/i.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(hits, [], `"Continue to payment" must not appear in public/: ${hits.join(', ')}`);
  });
});
