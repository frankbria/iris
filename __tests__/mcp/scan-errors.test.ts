/**
 * What an assistant is told about a scan (#362): the reason for a failure in a fixed
 * vocabulary, and where a scan landed without the text a redirect chose. Pure functions,
 * so no browser; `tools.test.ts` shows the same through a real scan.
 */

import { scanFailureReason, scannedPage } from '../../src/mcp/scan-errors';

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

  it.each(['page.goto: Timeout 30000ms exceeded.', 'The page did not finish within 120 s'])(
    'reports "%s" as a timeout',
    (detail) => {
      expect(scanFailureReason(detail)).toBe('the page did not finish loading in time');
    },
  );

  it('says nothing about a failure it does not recognise', () => {
    const reason = scanFailureReason(
      "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1200/chrome",
    );

    expect(reason).toBe('the scan could not be completed (details are on the server log)');
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
      `http://localhost:3000/${'ignore-previous-instructions-'.repeat(40)}`,
    );

    expect(url.length).toBeLessThanOrEqual(201);
    expect(url.endsWith('…')).toBe(true);
    expect(url.startsWith('http://localhost:3000/ignore-previous-instructions-')).toBe(true);
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
