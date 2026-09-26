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

    it('allows data: only when opted in', () => {
      expect(() =>
        assertNavigationAllowed('data:text/html,<h1>hi</h1>', { allowData: true }),
      ).not.toThrow();
      // The opt-in is for data: alone, not every non-web scheme.
      expect(() => assertNavigationAllowed('javascript:alert(1)', { allowData: true })).toThrow();
    });

    it('allows file:// when opted in', () => {
      expect(() =>
        assertNavigationAllowed('file:///tmp/page.html', { allowFile: true }),
      ).not.toThrow();
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

    it('rejects IPv4-mapped IPv6 forms of the metadata IP', () => {
      expect(() => assertNavigationAllowed('http://[::ffff:169.254.169.254]/')).toThrow();
      expect(() => assertNavigationAllowed('http://[::ffff:a9fe:a9fe]/')).toThrow(); // hex 0xa9fe=169.254
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
      expect(() =>
        assertNavigationAllowed('http://localhost:3000', { blockPrivateHosts: true }),
      ).toThrow();
      expect(() =>
        assertNavigationAllowed('http://127.0.0.1/', { blockPrivateHosts: true }),
      ).toThrow();
      expect(() => assertNavigationAllowed('http://[::1]/', { blockPrivateHosts: true })).toThrow();
    });

    it('blocks IPv4-mapped IPv6 loopback/RFC1918 when blockPrivateHosts is set', () => {
      expect(() =>
        assertNavigationAllowed('http://[::ffff:127.0.0.1]/', { blockPrivateHosts: true }),
      ).toThrow();
      expect(() =>
        assertNavigationAllowed('http://[::ffff:10.0.0.5]/', { blockPrivateHosts: true }),
      ).toThrow();
    });

    it('blocks RFC1918 ranges when blockPrivateHosts is set', () => {
      expect(() =>
        assertNavigationAllowed('http://10.0.0.5/', { blockPrivateHosts: true }),
      ).toThrow();
      expect(() =>
        assertNavigationAllowed('http://172.16.5.4/', { blockPrivateHosts: true }),
      ).toThrow();
      expect(() =>
        assertNavigationAllowed('http://192.168.0.1/', { blockPrivateHosts: true }),
      ).toThrow();
    });

    it('still allows public hosts when blockPrivateHosts is set', () => {
      expect(() =>
        assertNavigationAllowed('https://example.com', { blockPrivateHosts: true }),
      ).not.toThrow();
      expect(() =>
        assertNavigationAllowed('http://8.8.8.8/', { blockPrivateHosts: true }),
      ).not.toThrow();
    });
  });

  // Issue #333: the range table, and every spelling that reaches it. The policy
  // sees the WHATWG-parsed hostname — the same parse Chromium does — so integer,
  // hex and octal IPv4 and every IPv6 spelling arrive in canonical form. These
  // tables pin that the canonical form is what gets classified.
  describe('range table and host encodings (issue #333)', () => {
    const strict = { blockPrivateHosts: true };

    it.each([
      ['169.254.169.254', 'http://169.254.169.254/'],
      ['169.254.169.254 as an integer', 'http://2852039166/'],
      ['169.254.169.254 in hex', 'http://0xa9.0xfe.0xa9.0xfe/'],
      ['169.254.169.254 in octal', 'http://0251.0376.0251.0376/'],
      ['169.254.169.254 IPv4-compatible', 'http://[::169.254.169.254]/'],
      ['169.254.169.254 via NAT64', 'http://[64:ff9b::169.254.169.254]/'],
      ['AWS IPv6 metadata', 'http://[fd00:ec2::254]/'],
      ['Alibaba metadata', 'http://100.100.100.200/'],
      ['Alibaba metadata IPv4-mapped', 'http://[::ffff:100.100.100.200]/'],
      ['IPv6 link-local', 'http://[febf::1]/'],
      ['169.254.169.254 via local-use NAT64', 'http://[64:ff9b:1::169.254.169.254]/'],
    ])('always blocks %s', (_label, url) => {
      expect(() => assertNavigationAllowed(url)).toThrow(/link-local\/metadata/);
    });

    it.each([
      ['0.0.0.0/8', 'http://0.0.0.0/'],
      ['0.0.0.0/8 as "0"', 'http://0/'],
      ['0.0.0.0/8 upper edge', 'http://0.255.255.255/'],
      ['CGNAT 100.64.0.0/10', 'http://100.64.0.0/'],
      ['CGNAT upper edge', 'http://100.127.255.255/'],
      ['loopback as an integer', 'http://2130706433/'],
      ['loopback in hex', 'http://0x7f.1/'],
      ['loopback in octal', 'http://0177.0.0.1/'],
      ['loopback shorthand', 'http://127.1/'],
      ['172.16.0.0/12 upper edge', 'http://172.31.255.255/'],
      ['RFC1918 in hex', 'http://0xc0a80001/'],
      ['IPv6 unspecified', 'http://[::]/'],
      ['IPv4-compatible loopback', 'http://[::127.0.0.1]/'],
      ['IPv4-mapped CGNAT', 'http://[::ffff:100.64.0.0]/'],
      ['NAT64 to RFC1918', 'http://[64:ff9b::10.0.0.1]/'],
      ['NAT64 to loopback', 'http://[64:ff9b::7f00:1]/'],
      ['IPv6 ULA', 'http://[fd12:3456::1]/'],
      ['IPv6 site-local', 'http://[fec0::1]/'],
      ['IPv6 multicast', 'http://[ff02::1]/'],
      ['IETF protocol assignments', 'http://192.0.0.8/'],
      ['TEST-NET-1', 'http://192.0.2.1/'],
      ['benchmarking 198.18.0.0/15 upper edge', 'http://198.19.255.255/'],
      ['TEST-NET-2', 'http://198.51.100.1/'],
      ['TEST-NET-3', 'http://203.0.113.1/'],
      ['multicast', 'http://239.255.255.250/'],
      ['reserved 240.0.0.0/4', 'http://240.0.0.1/'],
      ['limited broadcast', 'http://255.255.255.255/'],
      ['localhost with a trailing dot', 'http://localhost./'],
      ['localhost with two trailing dots', 'http://localhost../'],
      ['local-use NAT64 to a public IPv4', 'http://[64:ff9b:1::8.8.8.8]/'],
      ['a *.localhost subdomain', 'http://app.localhost:3000/'],
      ['a mixed-case *.localhost subdomain', 'http://A.B.LocalHost/'],
    ])('blocks %s only when blockPrivateHosts is set', (_label, url) => {
      expect(() => assertNavigationAllowed(url)).not.toThrow();
      expect(() => assertNavigationAllowed(url, strict)).toThrow(/private\/loopback/);
    });

    it.each([
      ['just below 0.0.0.0/8', 'http://1.0.0.0/'],
      ['just below CGNAT', 'http://100.63.255.255/'],
      ['just above CGNAT', 'http://100.128.0.0/'],
      ['just below 169.254.0.0/16', 'http://169.253.255.255/'],
      ['just above 169.254.0.0/16', 'http://169.255.0.0/'],
      ['just above 172.16.0.0/12', 'http://172.32.0.0/'],
      ['a public IPv6 address', 'http://[2001:4860:4860::8888]/'],
      ['IPv4-mapped public', 'http://[::ffff:8.8.8.8]/'],
      ['NAT64 to a public IPv4', 'http://[64:ff9b::8.8.8.8]/'],
      ['a name that only contains "localhost"', 'http://localhost.example.com/'],
      ['a name ending in "localhost" without a dot', 'http://notlocalhost/'],
    ])('allows %s even when blockPrivateHosts is set', (_label, url) => {
      expect(() => assertNavigationAllowed(url, strict)).not.toThrow();
    });

    it('treats the AWS IPv6 metadata entry as one address, not its whole ULA prefix', () => {
      expect(() => assertNavigationAllowed('http://[fd00:ec2::253]/')).not.toThrow();
    });
  });
});

describe('pinnedOrigin (agent origin confinement, issue #151)', () => {
  it('allows the pinned origin itself', () => {
    expect(() =>
      assertNavigationAllowed('https://app.example.com/x', {
        pinnedOrigin: 'https://app.example.com',
      }),
    ).not.toThrow();
  });

  it('refuses another origin', () => {
    expect(() =>
      assertNavigationAllowed('https://evil.example.net/', {
        pinnedOrigin: 'https://app.example.com',
      }),
    ).toThrow(/leaves the pinned origin/);
  });

  it('allows an http to https upgrade of the same host', () => {
    // Refusing a site that upgrades itself treats a security improvement as an
    // escape, which teaches users to pass --allow-cross-origin and lose the
    // control entirely.
    expect(() =>
      assertNavigationAllowed('https://app.example.com/x', {
        pinnedOrigin: 'http://app.example.com',
      }),
    ).not.toThrow();
  });

  it('refuses an https to http downgrade', () => {
    expect(() =>
      assertNavigationAllowed('http://app.example.com/x', {
        pinnedOrigin: 'https://app.example.com',
      }),
    ).toThrow(/leaves the pinned origin/);
  });

  it('refuses a different host even on an upgrade', () => {
    expect(() =>
      assertNavigationAllowed('https://evil.example.net/', {
        pinnedOrigin: 'http://app.example.com',
      }),
    ).toThrow(/leaves the pinned origin/);
  });

  it.each([
    // The gap: both normalise to port 80, but :80 on https is an explicit
    // non-default port, i.e. a different service.
    ['https://app.example.com:80/', 'http://app.example.com'],
    ['https://app.example.com/', 'http://app.example.com:443'],
    ['https://app.example.com:8443/', 'http://app.example.com'],
  ])('refuses %s against pinned %s despite the scheme upgrade', (url, pinnedOrigin) => {
    expect(() => assertNavigationAllowed(url, { pinnedOrigin })).toThrow(
      /leaves the pinned origin/,
    );
  });

  it('allows an upgrade that keeps the same explicit port', () => {
    expect(() =>
      assertNavigationAllowed('https://app.example.com:3000/x', {
        pinnedOrigin: 'http://app.example.com:3000',
      }),
    ).not.toThrow();
  });

  it('refuses an explicit port change', () => {
    expect(() =>
      assertNavigationAllowed('https://app.example.com:8443/', {
        pinnedOrigin: 'http://app.example.com:3000',
      }),
    ).toThrow(/leaves the pinned origin/);
  });

  it('is inert when no origin is pinned', () => {
    expect(() => assertNavigationAllowed('https://anywhere.example/')).not.toThrow();
  });
});
