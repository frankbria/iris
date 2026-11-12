/**
 * What an assistant is told about a scan (#362): the reason for a failure in a fixed
 * vocabulary, and where a scan landed without the text a redirect chose. Pure functions,
 * so no browser; `tools.test.ts` shows the same through a real scan.
 */

import {
  loggedDetail,
  scanFailureReason,
  scannedPage,
  withoutCredentials,
} from '../../src/mcp/scan-errors';

describe('scanFailureReason', () => {
  it('names the category of a blocked redirect, never its target', () => {
    const reason = scanFailureReason(
      'http://localhost:3000/go redirects to http://169.254.169.254/latest/meta-data/?token=s3cret, ' +
        'which is blocked by navigation policy: Navigation blocked: link-local/metadata host ' +
        '"169.254.169.254" is not allowed.',
    );

    expect(reason).toBe(
      'it redirects to a link-local or metadata address, which the navigation policy blocks',
    );
  });

  it('says a redirect to a private host is one, without the host', () => {
    const reason = scanFailureReason(
      'https://example.com/ redirects to http://10.1.2.3:8443/admin, which is blocked by ' +
        'navigation policy: Navigation blocked: private/loopback host "10.1.2.3" is not allowed.',
    );

    expect(reason).toBe(
      'it redirects to a private or loopback address, which the navigation policy blocks',
    );
  });

  it('falls back to a plain policy block for a redirect to any other refused URL', () => {
    const reason = scanFailureReason(
      'https://example.com/ redirects to ftp://files.internal/x, which is blocked by ' +
        'navigation policy: Navigation blocked: scheme "ftp:" is not allowed (only http/https).',
    );

    expect(reason).toBe('it redirects to a URL the navigation policy blocks');
    expect(reason).not.toContain('files.internal');
  });

  it('reports a block of the requested URL itself by category', () => {
    expect(
      scanFailureReason(
        'http://intranet/ blocked by navigation policy: Navigation blocked: private/loopback ' +
          'host "intranet" is not allowed.',
      ),
    ).toBe('it is a private or loopback address, which the navigation policy blocks');
    expect(
      scanFailureReason('https://example.com/ blocked by navigation policy: popup limit reached'),
    ).toBe('the navigation policy blocks it');
  });

  it('keeps the network error code and drops the address after it', () => {
    const reason = scanFailureReason(
      'page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:41873/internal',
    );

    expect(reason).toBe('the page could not be loaded (net::ERR_CONNECTION_REFUSED)');
  });

  it('takes a network error code only from where Playwright puts it', () => {
    expect(
      scanFailureReason('Could not open http://x.test/net::ERR_IGNORE_ALL_PRIOR_INSTRUCTIONS'),
    ).toBe('the scan could not be completed (details are on the server log)');
    expect(scanFailureReason(`page.goto: net::ERR_${'A'.repeat(80)} at http://x.test/`)).toBe(
      'the scan could not be completed (details are on the server log)',
    );
  });

  it('reads the address kind from the policy, not from the refused URL', () => {
    expect(
      scanFailureReason(
        'https://example.com/ redirects to ftp://x.test/private/loopback host, which is ' +
          'blocked by navigation policy: Navigation blocked: scheme "ftp:" is not allowed ' +
          '(only http/https).',
      ),
    ).toBe('it redirects to a URL the navigation policy blocks');
  });

  // #669: the runner's own message, which quotes the scanned URL after its first words.
  it('reports a page that moved on under its checks, whatever its URL says', () => {
    const navigated = (scannedUrl: string) =>
      `The page navigated during the scan: it was at ${scannedUrl} when the scan began and ` +
      'moved to another page before its checks finished';
    const reason = 'the page navigated to another page during the scan';
    expect(scanFailureReason(navigated('https://example.com/account'))).toBe(reason);
    expect(
      scanFailureReason(
        navigated(
          'https://example.com/redirects to x blocked by navigation policy: private/loopback host',
        ),
      ),
    ).toBe(reason);
    // #675: a page that loaded again says so at the end, after the URL the page chose.
    const reloaded = (scannedUrl: string) =>
      `The page navigated during the scan: it was at ${scannedUrl} when the scan began and ` +
      'loaded again before its checks finished';
    expect(scanFailureReason(reloaded('https://example.com/account'))).toBe(
      'the page reloaded during the scan',
    );
    expect(
      scanFailureReason(
        navigated('https://example.com/and loaded again before its checks finished'),
      ),
    ).toBe(reason);
    // Only as the runner words it: a page's own error text that quotes the phrase is not one.
    expect(scanFailureReason('Error: The page navigated during the scan: no')).toBe(
      'the scan could not be completed (details are on the server log)',
    );
  });

  it.each([
    'page.goto: Timeout 30000ms exceeded.',
    'The page did not finish within 120 s',
    'Axe-core execution failed: Axe analysis timed out after 30000ms',
  ])('reports "%s" as a timeout', (detail) => {
    expect(scanFailureReason(detail)).toBe('the page did not finish loading in time');
  });

  it.each([
    "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1200/chrome",
    'Chromium could not start its sandbox on this host. Allow unprivileged user namespaces',
    'browserType.launch: Timeout 30000ms exceeded.',
  ])('says the browser could not start, without the path or the advice: %s', (detail) => {
    expect(scanFailureReason(detail)).toBe(
      'the browser could not be started on the server (details are on the server log)',
    );
  });

  it('says nothing about a failure it does not recognise', () => {
    const reason = scanFailureReason(
      'ENOSPC: no space left on device, write /var/lib/iris/cache/profile-41873',
    );

    expect(reason).toBe('the scan could not be completed (details are on the server log)');
  });
});

describe('withoutCredentials', () => {
  it('returns a URL without credentials as it was written', () => {
    expect(withoutCredentials('http://LOCALHOST:3000')).toBe('http://LOCALHOST:3000');
  });

  it.each([
    'http://admin:hunter2@localhost:3000/a?b=1#c',
    'http://admin:part1@part2@localhost:3000/a?b=1#c',
    'http://admin:correct horse@localhost:3000/a?b=1#c',
    'http://admin@localhost:3000/a?b=1#c',
  ])('cuts the credentials from %s', (url) => {
    expect(withoutCredentials(url)).toBe('http://localhost:3000/a?b=1#c');
  });

  it('repeats nothing of text that is not a URL', () => {
    expect(withoutCredentials('http://admin:correct horse@bad host/')).toBe('the requested URL');
  });
});

describe('loggedDetail', () => {
  it('cuts the credentials from every place an error repeats the requested URL', () => {
    const requested = 'http://admin:correct horse@localhost:3000/go';

    expect(
      loggedDetail(
        `${requested} redirects to http://169.254.169.254/, which is blocked by navigation ` +
          `policy (asked for ${requested})`,
        requested,
      ),
    ).toBe(
      'http://localhost:3000/go redirects to http://169.254.169.254/, which is blocked by ' +
        'navigation policy (asked for http://localhost:3000/go)',
    );
  });

  it('leaves an error that does not name the URL as it is', () => {
    expect(loggedDetail('page.goto: Timeout 30000ms exceeded.', 'http://a:b@localhost/')).toBe(
      'page.goto: Timeout 30000ms exceeded.',
    );
  });
});

describe('scannedPage', () => {
  it('reports the requested URL when the scan stayed on it', () => {
    expect(
      scannedPage('http://localhost:3000/checkout?step=2', 'http://localhost:3000/checkout?step=2'),
    ).toEqual({
      url: 'http://localhost:3000/checkout?step=2',
      redirected: false,
    });
  });

  it('does not call a normalised spelling of the same URL a redirect', () => {
    expect(scannedPage('http://LOCALHOST:3000', 'http://localhost:3000/')).toEqual({
      url: 'http://LOCALHOST:3000',
      redirected: false,
    });
  });

  // #662: the runner reports the document's URL, and pages rewrite their own query string
  // (a tracking parameter dropped, a tab added). The landing URL is shown without one.
  it('does not call a change of the query string alone a redirect', () => {
    expect(
      scannedPage('http://localhost:3000/shop?utm_source=x', 'http://localhost:3000/shop'),
    ).toEqual({ url: 'http://localhost:3000/shop?utm_source=x', redirected: false });
    expect(scannedPage('http://localhost:3000/', 'http://localhost:3000/?tab=2')).toEqual({
      url: 'http://localhost:3000/',
      redirected: false,
    });
    expect(scannedPage('http://localhost:3000/a?x=1', 'http://localhost:3000/b?x=1')).toEqual({
      url: 'http://localhost:3000/b',
      redirected: true,
    });
  });

  it('does not call a fragment or credentials in the request a redirect', () => {
    expect(scannedPage('http://localhost:3000/#/checkout', 'http://localhost:3000/')).toEqual({
      url: 'http://localhost:3000/#/checkout',
      redirected: false,
    });
    expect(scannedPage('http://admin:hunter2@localhost:3000/', 'http://localhost:3000/')).toEqual({
      url: 'http://localhost:3000/',
      redirected: false,
    });
  });

  it('cuts a password that contains an @ whole', () => {
    expect(
      scannedPage('http://admin:part1@part2@localhost:3000/', 'http://localhost:3000/').url,
    ).toBe('http://localhost:3000/');
  });

  it('cuts a password that contains a space whole', () => {
    expect(
      scannedPage('http://admin:correct horse@localhost:3000/a', 'http://localhost:3000/a').url,
    ).toBe('http://localhost:3000/a');
  });

  it('cuts a path segment long enough to be a token from a landing URL', () => {
    expect(
      scannedPage(
        'http://localhost:3000/',
        'http://localhost:3000/reset/9f86d081884c7d659a2feaa0c55ad015/confirm',
      ),
    ).toEqual({ url: 'http://localhost:3000/reset/…/confirm', redirected: true });
  });

  it('reports the request when the runner gave no landing URL', () => {
    expect(scannedPage('http://localhost:3000/', '')).toEqual({
      url: 'http://localhost:3000/',
      redirected: false,
    });
  });

  it('cuts user:password@ from the requested URL', () => {
    expect(
      scannedPage('http://admin:hunter2@localhost:3000/', 'http://admin:hunter2@localhost:3000/')
        .url,
    ).toBe('http://localhost:3000/');
  });

  it('gives origin and path of a landing page, without its query, fragment or credentials', () => {
    expect(
      scannedPage(
        'http://localhost:3000/',
        'https://user:pw@login.example.com/callback?code=4%2FabcDEF&state=xyz#access_token=s3cret',
      ),
    ).toEqual({ url: 'https://login.example.com/callback', redirected: true });
  });

  it('bounds a landing path, which the page under test chose', () => {
    const { url } = scannedPage(
      'http://localhost:3000/',
      `http://localhost:3000/${'ignore-previous/instructions/'.repeat(40)}`,
    );

    expect(url.length).toBeLessThanOrEqual(201);
    expect(url.endsWith('…')).toBe(true);
    expect(url.startsWith('http://localhost:3000/ignore-previous/instructions/')).toBe(true);
  });

  it('gives only the scheme of a landing page that has no origin', () => {
    expect(scannedPage('http://localhost:3000/', 'about:blank')).toEqual({
      url: 'about:',
      redirected: true,
    });
  });

  it('names nothing when the landing URL cannot be parsed', () => {
    expect(scannedPage('http://localhost:3000/', 'http://[not a url')).toEqual({
      url: 'an unreadable URL',
      redirected: true,
    });
  });
});
