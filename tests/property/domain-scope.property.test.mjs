import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { applyAssociatedDomainGroups, normalizeSiteInput, urlMatchesTarget } from '../../src/background/domain.js';
import {
  cookieMatchesCleanupTarget,
  downloadMatchesCleanupTarget,
  historyItemMatchesCleanupTarget,
  matchingOriginFromUrl,
  tabMatchesCleanupTarget
} from '../../src/shared/target-scope.js';

const label = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), { maxLength: 20 }),
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789')
  )
  .map(([first, middle, last]) => `${first}${middle.join('')}${last}`.replace(/-+$/g, ''))
  .filter((value) => value.length <= 63 && !value.includes('--'));

const configuredSeed = Number.parseInt(process.env.PROPERTY_SEED || '20260817', 10);
const PROPERTY_SEED = Number.isSafeInteger(configuredSeed) ? configuredSeed : 20260817;

function propertyOptions(numRuns) {
  // fast-check includes this seed and the shrink path in every failure, making
  // the exact counterexample reproducible with PROPERTY_SEED=<seed>.
  return { numRuns, seed: PROPERTY_SEED };
}

test('normalization never throws for arbitrary bounded input', () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 500 }), (input) => {
      const result = normalizeSiteInput(input);
      assert.equal(typeof result.ok, 'boolean');
      if (result.ok) {
        assert.ok(result.target.domain);
        assert.ok(['registrable_domain', 'exact_origin'].includes(result.target.matchMode));
      } else {
        assert.equal(typeof result.error, 'string');
        assert.ok(result.error.length > 0);
      }
    }),
    propertyOptions(1000)
  );
});

test('domain matching includes exact hosts and subdomains but rejects concatenated lookalikes', () => {
  fc.assert(
    fc.property(label, label, (site, child) => {
      fc.pre(site !== child);
      const normalized = normalizeSiteInput(`${site}.com`);
      // Some syntactically valid labels form a PSL entry themselves (for
      // example eu.com). Those are correctly rejected as public suffixes and
      // are outside this matcher property, which requires a registrable input.
      fc.pre(normalized.ok);
      const target = normalized.target;
      assert.equal(urlMatchesTarget(`https://${site}.com/path`, target), true);
      assert.equal(urlMatchesTarget(`https://${child}.${site}.com/path`, target), true);
      assert.equal(urlMatchesTarget(`https://${child}${site}.com/path`, target), false);
      assert.equal(urlMatchesTarget(`https://${site}.com.${child}.net/path`, target), false);
    }),
    propertyOptions(500)
  );
});

test('a generated public-suffix collision is rejected before matching', () => {
  const normalized = normalizeSiteInput('eu.com');
  assert.equal(normalized.ok, false);
});

test('private-suffix sibling tenants remain outside every destructive and verification matcher', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('blogspot.com', 'github.io', 'pages.dev', 'appspot.com', 'web.app'),
      label,
      label,
      (suffix, selected, sibling) => {
        fc.pre(selected !== sibling);
        const normalized = normalizeSiteInput(`https://${selected}.${suffix}/private`);
        assert.equal(normalized.ok, true);
        const target = normalized.target;
        const siblingUrl = `https://${sibling}.${suffix}/canary?secret=value`;
        assert.equal(urlMatchesTarget(siblingUrl, target), false);
        assert.equal(tabMatchesCleanupTarget({ id: 1, url: siblingUrl }, target), false);
        assert.equal(historyItemMatchesCleanupTarget({ url: siblingUrl }, target), false);
        assert.equal(
          downloadMatchesCleanupTarget({ url: siblingUrl, finalUrl: siblingUrl, referrer: siblingUrl }, target),
          false
        );
        assert.equal(cookieMatchesCleanupTarget({ domain: `.${sibling}.${suffix}` }, target), false);
        assert.equal(matchingOriginFromUrl(siblingUrl, target), null);
      }
    ),
    propertyOptions(750)
  );
});

test('the conventional www label is never removed from a PRIVATE-suffix tenant', () => {
  fc.assert(
    fc.property(fc.constantFrom('blogspot.com', 'github.io', 'pages.dev', 'appspot.com', 'web.app'), (suffix) => {
      const normalized = normalizeSiteInput(`https://www.${suffix}/private`);
      assert.equal(normalized.ok, true);
      const target = normalized.target;
      assert.equal(target.domain, `www.${suffix}`);
      assert.equal(urlMatchesTarget(`https://www.${suffix}/selected`, target), true);
      assert.equal(urlMatchesTarget(`https://${suffix}/platform-root`, target), false);
      assert.equal(urlMatchesTarget(`https://sibling.${suffix}/private`, target), false);
      assert.equal(matchingOriginFromUrl(`https://${suffix}/platform-root`, target), null);
    }),
    propertyOptions(100)
  );
});

test('case and a single trailing root dot do not broaden registrable scope', () => {
  fc.assert(
    fc.property(label, (site) => {
      const lower = normalizeSiteInput(`${site}.co.uk`);
      const decorated = normalizeSiteInput(`HTTPS://${site.toUpperCase()}.CO.UK./path`);
      assert.equal(lower.ok, true);
      assert.equal(decorated.ok, true);
      assert.equal(decorated.target.domain, lower.target.domain);
      assert.equal(urlMatchesTarget(`https://not-${site}.co.uk/`, lower.target), false);
    }),
    propertyOptions(300)
  );
});

test('exact-origin local targets never cross scheme or port boundaries', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1024, max: 65535 }),
      fc.integer({ min: 1024, max: 65535 }),
      (selectedPort, otherPort) => {
        fc.pre(selectedPort !== otherPort);
        const normalized = normalizeSiteInput(`http://localhost:${selectedPort}`, { allowLocalTargets: true });
        assert.equal(normalized.ok, true);
        const target = normalized.target;
        assert.equal(urlMatchesTarget(`http://localhost:${selectedPort}/path`, target), true);
        assert.equal(urlMatchesTarget(`https://localhost:${selectedPort}/path`, target), false);
        assert.equal(urlMatchesTarget(`http://localhost:${otherPort}/path`, target), false);
        assert.equal(matchingOriginFromUrl(`http://localhost:${otherPort}/path`, target), null);
      }
    ),
    propertyOptions(300)
  );
});

test('associated PRIVATE-suffix targets are independently normalized and controls remain isolated', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('blogspot.com', 'github.io', 'pages.dev', 'appspot.com', 'web.app'),
      fc.uniqueArray(label, { minLength: 3, maxLength: 3 }),
      (suffix, [primaryLabel, associatedLabel, controlLabel]) => {
        const primary = normalizeSiteInput(`https://${primaryLabel}.${suffix}/primary`);
        assert.equal(primary.ok, true);
        const associated = applyAssociatedDomainGroups(
          primary.target,
          `${primaryLabel}.${suffix} => ${associatedLabel}.${suffix}`
        );
        assert.deepEqual(associated.errors, []);
        assert.equal(associated.target.associatedTargets?.length, 1);
        assert.equal(associated.target.associatedTargets[0].domain, `${associatedLabel}.${suffix}`);

        const associatedUrl = `https://${associatedLabel}.${suffix}/bound`;
        const controlUrl = `https://${controlLabel}.${suffix}/control`;
        assertScopeAgreement(associatedUrl, associated.target, true);
        assertScopeAgreement(controlUrl, associated.target, false);
      }
    ),
    propertyOptions(500)
  );
});

test('all URL-based adapters agree with the canonical authorization boundary', () => {
  fc.assert(
    fc.property(fc.uniqueArray(label, { minLength: 3, maxLength: 3 }), ([site, child, lookalike]) => {
      const normalized = normalizeSiteInput(`${site}.com`);
      fc.pre(normalized.ok);
      const target = normalized.target;
      for (const [url, expected] of [
        [`https://${site}.com/path`, true],
        [`https://${child}.${site}.com/path`, true],
        [`https://${lookalike}${site}.com/path`, false],
        [`https://${site}.com.${lookalike}.net/path`, false]
      ]) {
        assertScopeAgreement(url, target, expected);
      }
    }),
    propertyOptions(500)
  );
});

test('credential-bearing URLs fail closed regardless of generated credentials', () => {
  fc.assert(
    fc.property(label, label, label, (username, password, site) => {
      const result = normalizeSiteInput(`https://${username}:${password}@${site}.com/private`);
      assert.equal(result.ok, false);
      assert.match(result.error, /credential|username|password|not supported/i);
    }),
    propertyOptions(300)
  );
});

test('IPv4 and bracketed IPv6 exact-origin targets retain scheme and effective port', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 254 }),
      fc.integer({ min: 1024, max: 65535 }),
      fc.integer({ min: 1024, max: 65535 }),
      (hostPart, selectedPort, otherPort) => {
        fc.pre(selectedPort !== otherPort);
        for (const host of [`127.0.0.${hostPart}`, `[fd00::${hostPart.toString(16)}]`]) {
          const normalized = normalizeSiteInput(`http://${host}:${selectedPort}`, { allowLocalTargets: true });
          assert.equal(normalized.ok, true);
          assertScopeAgreement(`http://${host}:${selectedPort}/selected`, normalized.target, true);
          // Browser cookie scope has no scheme or port dimension. SiteWipe
          // documents this deliberate exception while every URL/origin adapter
          // remains exact-origin bound.
          assertScopeAgreement(`https://${host}:${selectedPort}/wrong-scheme`, normalized.target, false, true);
          assertScopeAgreement(`http://${host}:${otherPort}/wrong-port`, normalized.target, false, true);
        }
      }
    ),
    propertyOptions(300)
  );
});

function assertScopeAgreement(url, target, expected, cookieExpected = expected) {
  assert.equal(urlMatchesTarget(url, target), expected, `domain matcher disagreed for ${url}`);
  assert.equal(tabMatchesCleanupTarget({ id: 1, url }, target), expected, `tab matcher disagreed for ${url}`);
  assert.equal(historyItemMatchesCleanupTarget({ url }, target), expected, `history matcher disagreed for ${url}`);
  assert.equal(
    downloadMatchesCleanupTarget({ url, finalUrl: url, referrer: url }, target),
    expected,
    `download matcher disagreed for ${url}`
  );
  assert.equal(Boolean(matchingOriginFromUrl(url, target)), expected, `origin matcher disagreed for ${url}`);
  const hostname = new URL(url).hostname;
  assert.equal(
    cookieMatchesCleanupTarget({ domain: `.${hostname.replace(/^\[|\]$/g, '')}` }, target),
    cookieExpected,
    `cookie matcher disagreed for ${url}`
  );
}
