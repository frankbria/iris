import { assertNavigationAllowed } from '../src/url-policy';

describe('assertNavigationAllowed', () => {
  describe('scheme allowlist', () => {
    it('allows http and https by default', () => {
      expect(() => assertNavigationAllowed('http://example.com')).not.toThrow();
      expect(() => assertNavigationAllowed('https://example.com/path?q=1')).not.toThrow();
    });

    it('rejects file:// by default', () => {
      expect(() => assertNavigationAllowed('file:///etc/passwd')).toThrow(/file/i);
    });

    it('rejects data: URLs', () => {
      expect(() => assertNavigationAllowed('data:text/html,<h1>hi</h1>')).toThrow();
    });

    it('rejects javascript: URLs', () => {
      expect(() => assertNavigationAllowed('javascript:alert(1)')).toThrow();
    });

    it('rejects malformed URLs', () => {
      expect(() => assertNavigationAllowed('not a url')).toThrow();
      expect(() => assertNavigationAllowed('')).toThrow();
    });

    it('allows file:// when opted in', () => {
      expect(() => assertNavigationAllowed('file:///tmp/page.html', { allowFile: true })).not.toThrow();
    });
  });

  describe('cloud-metadata / link-local (always blocked)', () => {
    it('rejects the AWS/GCP metadata IP', () => {
      expect(() => assertNavigationAllowed('http://169.254.169.254/latest/meta-data/')).toThrow(
        /blocked|metadata|link-local/i,
      );
    });

    it('rejects any 169.254.0.0/16 host', () => {
      expect(() => assertNavigationAllowed('http://169.254.1.1/')).toThrow();
    });

    it('rejects IPv6 link-local (fe80::)', () => {
      expect(() => assertNavigationAllowed('http://[fe80::1]/')).toThrow();
    });

    it('rejects the GCP metadata hostname', () => {
      expect(() => assertNavigationAllowed('http://metadata.google.internal/')).toThrow();
    });

    it('does not mistake public hostnames that start like IPv6 ranges for addresses', () => {
      // "feature"/"fed"/"fc" prefixes must not trip the fe80::/ fc00:: literal checks.
      expect(() => assertNavigationAllowed('https://feature.example.com')).not.toThrow();
      expect(() => assertNavigationAllowed('https://fedex.com')).not.toThrow();
      expect(() =>
        assertNavigationAllowed('https://fc-barcelona.example', { blockPrivateHosts: true }),
      ).not.toThrow();
    });

    it('rejects the trailing-dot FQDN metadata variant', () => {
      expect(() => assertNavigationAllowed('http://metadata.google.internal./')).toThrow();
    });
  });

  describe('loopback / RFC1918 (opt-in blocking)', () => {
    it('allows localhost by default (local dev-server testing)', () => {
      expect(() => assertNavigationAllowed('http://localhost:3000')).not.toThrow();
      expect(() => assertNavigationAllowed('http://127.0.0.1:8080/app')).not.toThrow();
    });

    it('allows RFC1918 hosts by default', () => {
      expect(() => assertNavigationAllowed('http://192.168.1.10/')).not.toThrow();
      expect(() => assertNavigationAllowed('http://10.0.0.5/')).not.toThrow();
    });

    it('blocks loopback when blockPrivateHosts is set', () => {
      expect(() => assertNavigationAllowed('http://localhost:3000', { blockPrivateHosts: true })).toThrow();
      expect(() => assertNavigationAllowed('http://127.0.0.1/', { blockPrivateHosts: true })).toThrow();
      expect(() => assertNavigationAllowed('http://[::1]/', { blockPrivateHosts: true })).toThrow();
    });

    it('blocks RFC1918 ranges when blockPrivateHosts is set', () => {
      expect(() => assertNavigationAllowed('http://10.0.0.5/', { blockPrivateHosts: true })).toThrow();
      expect(() => assertNavigationAllowed('http://172.16.5.4/', { blockPrivateHosts: true })).toThrow();
      expect(() => assertNavigationAllowed('http://192.168.0.1/', { blockPrivateHosts: true })).toThrow();
    });

    it('still allows public hosts when blockPrivateHosts is set', () => {
      expect(() =>
        assertNavigationAllowed('https://example.com', { blockPrivateHosts: true }),
      ).not.toThrow();
      expect(() => assertNavigationAllowed('http://8.8.8.8/', { blockPrivateHosts: true })).not.toThrow();
    });
  });
});
