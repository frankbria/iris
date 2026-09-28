/**
 * Output encoding across every report format (issue #339).
 *
 * Report fields carry text the page under test controls: page names, axe output
 * (axe runs inside the page) and model output quoting the page. Substring checks
 * cannot prove a report is safe — a half-escaped document satisfies them — so
 * these tests hand each report to a real parser:
 *
 * - HTML and XML: Chromium's DOMParser. An XML document that does not parse
 *   yields a <parsererror> element, which is what a CI JUnit reader would choke on.
 * - Markdown: markdown-it with raw HTML and linkify on, the most permissive
 *   renderer a report is likely to meet (GitHub, GitLab).
 *
 * The central invariant is *structure equivalence*: the same report rendered once
 * with benign strings and once with hostile ones must parse to the same element /
 * token sequence. Any injection adds or removes nodes, whatever the payload. A
 * second check proves the hostile text itself survives as text.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import type { Browser, Page } from 'playwright';
import { launchBrowser, newHardenedContext } from '../src/browser';
import { VisualReporter } from '../src/visual/reporter';
import type { VisualTestResult } from '../src/visual/visual-runner';
import { AccessibilityRunner, AccessibilityTestResult } from '../src/a11y/a11y-runner';
import { escapeHtml, escapeMarkdown, escapeXml, safeHref } from '../src/report-encoding';

// Every markup-significant character for HTML, XML and Markdown, plus a forged
// line after a newline. No XML-illegal characters: those get their own case, since
// the HTML parser and the XML parser treat them differently by design.
const HOSTILE =
  `</h3><script>alert(1)</script><img src=x onerror=alert(2)> & "dq" 'sq' ` +
  `[link](javascript:alert(3)) ![img](http://evil.test/x.png) <http://evil.test> ` +
  `**bold** _em_ \`code\` ~~strike~~ | pipe | # hash \\ backslash &amp; &#60;` +
  `\n### ✅ forged PASSED\n- **Status:** PASSED\r\n<b>raw</b>`;
// Characters XML 1.0 forbids: C0 controls, U+FFFE/U+FFFF and a lone surrogate.
const XML_ILLEGAL = 'a\u0000b\u0001c\u000Bd\u001Fe\uFFFEf\uFFFFg\uD800h';

// The HTML parser folds CRLF and CR to LF before tokenizing; so does XML.
const lf = (s: string) => s.replace(/\r\n?/g, '\n');

// CommonMark with raw HTML on. GFM-style linkify is tested separately: it turns a
// bare URL into a link whatever the escaping, which is harmless only because the
// target is then the visible text.
const md = new MarkdownIt({ html: true });

let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  page = await (await newHardenedContext(browser)).newPage();
});

afterAll(async () => {
  await browser?.close();
});

/** Parse in Chromium; return the element skeleton, the parse error (XML) and texts. */
async function parse(content: string, mime: 'text/html' | 'application/xml') {
  // A string expression, not a function: see "Under jest --coverage" in CLAUDE.md.
  return (await page.evaluate(`(() => {
    const doc = new DOMParser().parseFromString(${JSON.stringify(content)}, ${JSON.stringify(mime)});
    const err = doc.getElementsByTagName('parsererror')[0];
    const all = [...doc.getElementsByTagName('*')];
    return {
      error: err ? err.textContent : null,
      skeleton: all.map((e) => e.tagName + '[' + [...e.attributes].map((a) => a.name).sort().join(',') + ']'),
      text: doc.documentElement.textContent,
      attrs: all.flatMap((e) => [...e.attributes].map((a) => a.value)),
      hrefs: [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    };
  })()`)) as {
    error: string | null;
    skeleton: string[];
    text: string;
    attrs: string[];
    hrefs: (string | null)[];
  };
}

/** Markdown token types, with inline children flattened in place. */
function mdSkeleton(content: string): string[] {
  return md
    .parse(content, {})
    .flatMap((t) => (t.children ? [t.type, ...t.children.map((c) => c.type)] : [t.type]));
}

/** Text of every inline token markdown-it produced, joined. */
function mdText(content: string): string {
  return md
    .parse(content, {})
    .flatMap((t) => t.children ?? [])
    .map((c) => c.content)
    .join('');
}

describe('report encoders', () => {
  it('escapeMarkdown leaves only text tokens and keeps the text', () => {
    const tokens = md.parseInline(escapeMarkdown(HOSTILE), {})[0].children!;
    expect(tokens.map((t) => t.type)).toEqual(['text']);
    // Newlines fold to one space; every other character survives verbatim.
    expect(tokens[0].content).toBe(HOSTILE.replace(/\r\n|\r|\n/g, ' '));
  });

  it('escapeMarkdown: a bare URL may autolink, but only to its own visible text', () => {
    const linkify = new MarkdownIt({ html: true, linkify: true });
    const tokens = linkify.parseInline(escapeMarkdown(HOSTILE), {})[0].children!;
    const links = tokens.filter((t) => t.type === 'link_open');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const text = tokens[tokens.indexOf(link) + 1].content;
      expect(link.attrGet('href')).toBe(text);
      expect(link.attrGet('href')).toMatch(/^https?:\/\//);
    }
  });

  it('escapeXml output parses as XML in attributes and text', async () => {
    const value = HOSTILE + XML_ILLEGAL;
    const doc = await parse(
      `<r a="${escapeXml(value)}">${escapeXml(value)}</r>`,
      'application/xml',
    );
    expect(doc.error).toBeNull();
    // Illegal characters become U+FFFD: visible, and the document stays readable.
    // TAB/LF/CR go out as character references, so they survive exactly, even in
    // an attribute, where a raw one would be normalised to a space.
    const expected = HOSTILE + XML_ILLEGAL.replace(/[^a-h]/g, '\uFFFD');
    expect(doc.text).toBe(expected);
    expect(doc.attrs).toEqual([expected]);
  });

  it.each(['- x', '+ x', '1. x', '1) x', '---', '***', '      indented', '# h', '> q'])(
    'escapeMarkdown(%j) after a list marker stays one plain list item',
    (value) => {
      // A suggestion is rendered as `  - <value>`, so the value starts a block:
      // a leading marker would nest a list, `---` would become a rule, and
      // indentation a code block.
      const types = md.parse(`- ${escapeMarkdown(value)}`, {}).map((t) => t.type);
      expect(types).toEqual([
        'bullet_list_open',
        'list_item_open',
        'paragraph_open',
        'inline',
        'paragraph_close',
        'list_item_close',
        'bullet_list_close',
      ]);
      expect(mdText(`- ${escapeMarkdown(value)}`)).toBe(value.trimStart());
    },
  );

  it('escapeHtml output parses to text in attributes and text', async () => {
    const doc = await parse(
      `<p title="${escapeHtml(HOSTILE)}">${escapeHtml(HOSTILE)}</p>`,
      'text/html',
    );
    expect(doc.skeleton).toEqual(['HTML[]', 'HEAD[]', 'BODY[]', 'P[title]']);
    expect(doc.attrs).toContain(lf(HOSTILE));
  });

  it.each([
    ['https://dequeuniversity.com/rules/axe/4.8/image-alt', true],
    ['http://example.com/x', true],
    ['javascript:alert(1)', false],
    ['JaVaScRiPt:alert(1)', false],
    [' javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['vbscript:x', false],
    ['/relative', false],
    ['not a url', false],
  ])('safeHref(%j) links: %s', (url, links) => {
    expect(safeHref(url) !== null).toBe(links);
  });
});

describe('visual reports', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-report-encoding-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** One failed result whose every free-text field is `s`. */
  const results = (s: string): VisualTestResult => ({
    summary: {
      totalComparisons: 1,
      passed: 0,
      failed: 1,
      newBaselines: 0,
      overallStatus: 'failed',
      severityCounts: { breaking: 1, moderate: 0, minor: 0 },
    },
    results: [
      {
        page: s,
        device: s,
        passed: false,
        similarity: 0.8,
        pixelDifference: 0.2,
        threshold: 0.1,
        // Typed as a union, but a report is also rendered from stored JSON.
        severity: s as 'breaking',
        screenshotPath: path.join(tempDir, `${s}.png`),
        baselinePath: path.join(tempDir, 'baseline', `${s}.png`),
        diffPath: path.join(tempDir, 'diff', `${s}.png`),
        aiAnalysis: {
          classification: s,
          confidence: 0.9,
          description: s,
          severity: 'high',
          suggestions: [s, s],
          isIntentional: false,
          changeType: s,
          reasoning: s,
        },
      },
    ],
    duration: 1,
  });

  const render = async (
    format: 'html' | 'markdown' | 'junit' | 'json',
    s: string,
    relativePaths = true,
  ) => {
    const reporter = new VisualReporter({
      format,
      title: s,
      includeScreenshots: true,
      relativePaths,
      outputPath: path.join(tempDir, `report-${format}`),
    });
    const { reportPath } = await reporter.generateReport(results(s));
    return fs.readFileSync(reportPath, 'utf-8');
  };

  it('HTML: hostile text changes no structure and survives as text', async () => {
    const benign = await parse(await render('html', 'benign'), 'text/html');
    const hostile = await parse(await render('html', HOSTILE), 'text/html');

    expect(hostile.skeleton).toEqual(benign.skeleton);
    expect(hostile.text).toContain(lf(`${HOSTILE} - ${HOSTILE}`));
  });

  it.each([true, false])('HTML: image paths are URL-encoded (relativePaths: %s)', async (rel) => {
    const name = 'a b#c?d%e';
    const content = await render('html', name, rel);
    const doc = await parse(content, 'text/html');
    const srcs = doc.attrs.filter((v) => v.endsWith('.png'));

    expect(srcs.length).toBe(3);
    for (const src of srcs) {
      // Resolving the src as a URL must land on the file on disk, not cut the
      // name at `#` or `?` or mis-decode `%`.
      const resolved = new URL(src, `file://${tempDir}/report.html`);
      expect(resolved.search).toBe('');
      expect(resolved.hash).toBe('');
      expect(decodeURIComponent(resolved.pathname).endsWith(`/${name}.png`)).toBe(true);
    }
  });

  it('JUnit: parses as XML, hostile and illegal text changes no structure', async () => {
    const benign = await parse(await render('junit', 'benign'), 'application/xml');
    const hostile = await parse(await render('junit', HOSTILE + XML_ILLEGAL), 'application/xml');

    expect(hostile.error).toBeNull();
    expect(hostile.skeleton).toEqual(benign.skeleton);
    expect(hostile.attrs.some((v) => v.startsWith(HOSTILE.slice(0, 40)))).toBe(true);
    expect(hostile.text).toContain('AI Description: ' + HOSTILE.slice(0, 20));
    expect(hostile.text).toContain('Severity: ' + HOSTILE.slice(0, 20));
  });

  it('Markdown: hostile text changes no structure and survives as text', async () => {
    const benign = mdSkeleton(await render('markdown', 'benign'));
    const content = await render('markdown', HOSTILE);

    expect(mdSkeleton(content)).toEqual(benign);
    expect(mdText(content)).toContain(HOSTILE.replace(/\r\n|\r|\n/g, ' '));
  });

  it('JSON: round-trips hostile and illegal text exactly', async () => {
    const s = HOSTILE + XML_ILLEGAL;
    const parsed = JSON.parse(await render('json', s));
    expect(parsed.metadata.title).toBe(s);
    expect(parsed.results[0].aiAnalysis.reasoning).toBe(s);
  });
});

describe('a11y reports', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-a11y-encoding-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const results = (s: string, helpUrl: string): AccessibilityTestResult['results'] => [
    {
      page: s,
      axeResult: {
        testName: s,
        url: s,
        timestamp: new Date(0),
        passed: false,
        violations: [
          {
            id: s,
            impact: 'critical',
            tags: [s],
            description: s,
            help: s,
            helpUrl,
            nodes: [{ target: [s, s], html: s, failureSummary: s }],
          },
        ],
        passes: [],
        incomplete: [],
        inapplicable: [],
        summary: { total: 1, violations: 1, passes: 0, incomplete: 0, inapplicable: 0 },
        testRunner: { name: 'axe-core', version: '4.8.0' },
      } as AccessibilityTestResult['results'][0]['axeResult'],
    },
  ];

  const summary: AccessibilityTestResult['summary'] = {
    totalViolations: 1,
    score: 90,
    passed: false,
    violationsBySeverity: { critical: 1, serious: 0, moderate: 0, minor: 0 },
    pagesTested: 1,
    keyboardTestsPassed: 0,
    keyboardTestsFailed: 0,
  };

  const render = async (format: 'html' | 'junit', s: string, helpUrl = 'https://example.com/r') => {
    const outputPath = path.join(tempDir, `a11y.${format}`);
    const runner = new AccessibilityRunner({
      pages: [],
      output: { format, path: outputPath },
    } as unknown as ConstructorParameters<typeof AccessibilityRunner>[0]);
    // The writer is private; run() would need a browser and axe for no gain here.
    await (
      runner as unknown as {
        generateReport: (r: unknown, s: unknown) => Promise<string>;
      }
    ).generateReport(results(s, helpUrl), summary);
    return fs.readFileSync(outputPath, 'utf-8');
  };

  it('HTML: hostile text changes no structure and survives as text', async () => {
    const benign = await parse(await render('html', 'benign'), 'text/html');
    const hostile = await parse(await render('html', HOSTILE), 'text/html');

    expect(hostile.skeleton).toEqual(benign.skeleton);
    expect(hostile.text).toContain(lf(HOSTILE));
  });

  it('HTML: a non-http helpUrl is shown as text, never linked', async () => {
    // axe runs inside the page under test, so a hostile page controls helpUrl.
    // Attribute escaping keeps it inside the quotes; it does not make
    // `javascript:` inert when the reader clicks it.
    const linked = await parse(await render('html', 'x', 'https://example.com/r'), 'text/html');
    expect(linked.hrefs).toEqual(['https://example.com/r']);

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      const doc = await parse(await render('html', 'x', url), 'text/html');
      expect(doc.hrefs).toEqual([]);
      expect(doc.text).toContain(url);
    }
  });

  it('JUnit: parses as XML, hostile and illegal text changes no structure', async () => {
    const benign = await parse(await render('junit', 'benign'), 'application/xml');
    const hostile = await parse(await render('junit', HOSTILE + XML_ILLEGAL), 'application/xml');

    expect(hostile.error).toBeNull();
    expect(hostile.skeleton).toEqual(benign.skeleton);
    expect(hostile.text).toContain(HOSTILE.slice(0, 40));
    // Every illegal character is replaced, not dropped.
    expect(hostile.text).toContain(XML_ILLEGAL.replace(/[^a-h]/g, '\uFFFD'));
  });
});
