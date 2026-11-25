import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SyntaxHighlightTheme, SyntaxTokenKind, SyntaxTokenStyle } from '../src/colorTheme';
import { installMarkdownReferencePlugin } from '../src/markdownPlugin';
import {
    findReferenceMatches,
    parseReference,
    referenceHref,
    resolveReference,
} from '../src/reference';

describe('file reference parsing', () => {
    it('parses paths, ranges, and preview flags', () => {
        expect(parseReference('src/example.ts')).toMatchObject({
            filePath: 'src/example.ts',
            preview: false,
        });
        expect(parseReference('src/example.ts:300-330?preview=true')).toEqual({
            raw: 'src/example.ts:300-330?preview=true',
            filePath: 'src/example.ts',
            startLine: 300,
            endLine: 330,
            symbol: undefined,
            preview: true,
        });
        expect(parseReference('src/example.ts#User.email')).toMatchObject({
            filePath: 'src/example.ts',
            symbol: 'User.email',
        });
        expect(parseReference('src/example.ts#add?preview=true')).toMatchObject({
            filePath: 'src/example.ts',
            symbol: 'add',
            preview: true,
        });
        expect(parseReference('src/example.ts:10-50?preview=true&highlight=1,5-10,30-35&focus=2-4')).toMatchObject({
            filePath: 'src/example.ts',
            startLine: 10,
            endLine: 50,
            preview: true,
            highlightLines: [
                { start: 1, end: 1 },
                { start: 5, end: 10 },
                { start: 30, end: 35 },
            ],
            focusLines: [{ start: 2, end: 4 }],
        });
        expect(parseReference('src/example.ts#add?focus=1-2&preview=true')).toMatchObject({
            symbol: 'add',
            preview: true,
            focusLines: [{ start: 1, end: 2 }],
        });
        expect(parseReference('src/example.ts?highlight=1')).toBeUndefined();
        expect(parseReference('src/example.ts?preview=true&focus=0,2')).toBeUndefined();
        expect(parseReference('src/example.ts?preview=true&highlight=5-2')).toBeUndefined();
        expect(parseReference('src/example.ts:0-2')).toBeUndefined();
        expect(parseReference('https://example.com/file.ts')).toBeUndefined();
    });

    it('finds bare references without swallowing sentence punctuation', () => {
        const text = 'See src/example.ts:2-3, README.md, src/example.ts#User.email and src/example.ts#add?preview=true&focus=1,3-4.';
        expect(findReferenceMatches(text).map(match => match.value)).toEqual([
            'src/example.ts:2-3',
            'README.md',
            'src/example.ts#User.email',
            'src/example.ts#add?preview=true&focus=1,3-4',
        ]);
    });
});

describe('reference resolution and rendering', () => {
    let root: string;
    let markdownPath: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'markdown-reference-'));
        fs.mkdirSync(path.join(root, 'docs'));
        fs.mkdirSync(path.join(root, 'src'));
        markdownPath = path.join(root, 'docs', 'README.md');
        fs.writeFileSync(markdownPath, '# Demo\n');
        fs.writeFileSync(
            path.join(root, 'src', 'example.ts'),
            ['const escaped = "<safe>";', 'export function add(a: number, b: number) {', '    return a + b;', '}'].join('\n')
        );
        fs.writeFileSync(
            path.join(root, 'src', 'indented.ts'),
            [
                'class Example {',
                '    hello() {',
                '\t    const value = 1;',
                '\t    return value;',
                '    }',
                '}',
            ].join('\n')
        );
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('falls back to the workspace root and creates a VS Code line fragment', () => {
        const parsed = parseReference('src/example.ts:2-3')!;
        const resolved = resolveReference(parsed, markdownPath, root)!;
        expect(resolved.absolutePath).toBe(path.join(root, 'src', 'example.ts'));
        expect(referenceHref(resolved, markdownPath)).toBe('../src/example.ts#L2-L3');
    });

    it('renders existing bare and inline-code references as links', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('See src/example.ts:2-3 and `src/example.ts`.', env);
        expect(html.match(/class="md-ref /g)).toHaveLength(2);
        expect(html).toContain('codicon-file-code');
        expect(html).toContain('#L2-L3');
        expect(html).toContain('data-href="../src/example.ts#L2-L3"');
    });

    it('renders preview source, metadata, and escaped file content', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts:1-2?preview=true`', env);
        expect(html).toContain('md-ref-preview');
        expect(html).toContain('Lines 1-2');
        expect(html).toContain('&lt;safe&gt;');
        expect(html).not.toContain('?preview=true</span>');
        expect(html).toContain('<a class="md-ref-preview__link"');
        expect(html).toContain('>example.ts</a>');
        expect(html).not.toContain('<a class="md-ref md-ref--code"');
    });

    it('previews only the source range returned for a symbol', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            symbolRangeForReference: () => ({ startLine: 2, endLine: 4 }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts#add?preview=true`', env);

        expect(html).toContain('>example.ts#add</a>');
        expect(html).toContain('Lines 2-4');
        expect(html).toContain('export function add');
        expect(html).toContain('return a + b');
        expect(html).not.toContain('const escaped');
    });

    it('dedents symbol previews by visual columns while preserving body indentation', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            tabSizeForFile: () => 4,
            symbolRangeForReference: () => ({ startLine: 2, endLine: 5 }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/indented.ts#hello?preview=true`', env);

        expect(html).toContain('style="--md-ref-tab-size:4;"');
        expect(html).toContain('>hello() {\n    const value = 1;\n    return value;\n}</code>');
        expect(html).not.toContain('>    hello()');
    });

    it('keeps original indentation for explicit line-range previews', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            tabSizeForFile: () => 4,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/indented.ts:2-3?preview=true`', env);

        expect(html).toContain('>    hello() {\n\t    const value = 1;</code>');
    });

    it('renders highlighted and focused preview lines relative to the displayed snippet', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render(
            '`src/example.ts:1-4?preview=true&highlight=1,3-4&focus=2-3`',
            env
        );

        expect(html).toContain('md-ref-preview__code--has-focus');
        expect(html).toContain('class="md-ref-preview__line md-ref-preview__line--highlight" data-line="1"');
        expect(html).toContain('class="md-ref-preview__line md-ref-preview__line--focus" data-line="2"');
        expect(html).toContain('class="md-ref-preview__line md-ref-preview__line--highlight md-ref-preview__line--focus" data-line="3"');
        expect(html).toContain('class="md-ref-preview__line md-ref-preview__line--highlight" data-line="4"');
    });

    it('keeps multiline syntax-highlight spans balanced when decorating lines', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt({
            highlight: () => '<span class="token">first\nsecond</span>\nthird\nfourth',
        }), {
            workspaceRootForDocument: () => root,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts:1-4?preview=true&highlight=1-2`', env);

        expect(html).toContain('data-line="1"><span class="token">first</span></span>');
        expect(html).toContain('data-line="2"><span class="token">second</span></span>');
        expect(html.match(/class="md-ref-preview__line/g)).toHaveLength(4);
    });

    it('applies the active VS Code syntax theme to highlighted tokens', () => {
        const defaultStyle: SyntaxTokenStyle = {
            color: '#cccccc',
            fontStyle: 'normal',
            fontWeight: 'normal',
            textDecoration: 'none',
        };
        const tokenKinds: SyntaxTokenKind[] = [
            'addition', 'attribute', 'built-in', 'comment', 'deletion', 'function', 'keyword',
            'literal', 'meta', 'number', 'parameter', 'property', 'regexp', 'selector', 'string',
            'symbol', 'tag', 'type', 'variable',
        ];
        const syntaxTheme: SyntaxHighlightTheme = {
            foreground: '#eeeeee',
            tokens: Object.fromEntries(tokenKinds.map(kind => [kind, { ...defaultStyle }])) as SyntaxHighlightTheme['tokens'],
        };
        syntaxTheme.tokens.keyword = { ...defaultStyle, color: '#ff00aa', fontWeight: 'bold' };
        syntaxTheme.tokens.function = { ...defaultStyle, color: '#00aaff' };
        const markdown = installMarkdownReferencePlugin(new MarkdownIt({
            highlight: () => '<span class="hljs-keyword">function</span> <span class="hljs-title function_">add</span>()',
        }), {
            workspaceRootForDocument: () => root,
            syntaxThemeForFile: () => syntaxTheme,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts:2?preview=true`', env);

        expect(html).toContain('style="--md-ref-tab-size:4;color:#eeeeee"');
        expect(html).toContain('class="hljs-keyword" style="color:#ff00aa;font-style:normal;font-weight:bold;text-decoration:none"');
        expect(html).toContain('class="hljs-title function_" style="color:#00aaff;font-style:normal;font-weight:normal;text-decoration:none"');
    });

    it('renders symbol references through the extension URI handler', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            fileIconForPath: () => ({ dataUri: 'data:image/svg+xml;base64,PHN2Zy8+' }),
            symbolIconForReference: () => ({
                codicon: 'codicon-symbol-method',
                color: 'method',
            }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts#add`', env);
        expect(html).toContain('vscode://r0kuko.vscode-markdown-reference/open-symbol?');
        expect(html).toContain('symbol=add');
        expect(html).toContain('md-ref__symbol">#add');
        expect(html).toContain('<span class="md-ref__path">example.ts</span><span class="md-ref__symbol">#add</span>');
        expect(html).not.toContain('<span class="md-ref__path">src/example.ts</span>');
        expect(html).toContain('codicon-symbol-method');
        expect(html).toContain('md-ref__symbol-icon--method');
        expect(html).not.toContain('md-ref__theme-icon');
    });

    it('uses the configured host URI scheme for symbol links and preview headers', () => {
        const parsed = parseReference('src/example.ts#add')!;
        const resolved = resolveReference(parsed, markdownPath, root)!;
        expect(referenceHref(resolved, markdownPath, 'antigravity-ide')).toMatch(
            /^antigravity-ide:\/\/r0kuko\.vscode-markdown-reference\/open-symbol\?/
        );
        expect(referenceHref(resolved, markdownPath, '  ')).toMatch(
            /^vscode:\/\/r0kuko\.vscode-markdown-reference\/open-symbol\?/
        );

        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            uriScheme: 'vscode-insiders',
            symbolRangeForReference: () => ({ startLine: 2, endLine: 4 }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const linkHtml = markdown.render('`src/example.ts#add`', env);
        const previewHtml = markdown.render('`src/example.ts#add?preview=true`', env);

        expect(linkHtml).toContain('href="vscode-insiders://r0kuko.vscode-markdown-reference/open-symbol?');
        expect(previewHtml).toContain('href="vscode-insiders://r0kuko.vscode-markdown-reference/open-symbol?');
    });

    it('renders an icon from the active file icon theme instead of a Codicon fallback', () => {
        const iconData = 'data:image/svg+xml;base64,PHN2Zy8+';
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            fileIconForPath: () => ({ dataUri: iconData }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts`', env);
        expect(html).toContain(`src="${iconData}"`);
        expect(html).toContain('md-ref__theme-icon');
        expect(html).not.toContain('codicon-file-code');
    });

    it('renders the configured reference font size and active product theme symbol icon', () => {
        const iconData = 'data:image/svg+xml;base64,PHN2Zy8+';
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
            fontSizeForDocument: () => 17,
            symbolIconForReference: () => ({
                codicon: 'codicon-symbol-method',
                color: 'method',
                themedIcon: { dataUri: iconData },
            }),
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('`src/example.ts#add`', env);

        expect(html).toContain('style="--md-ref-font-size:17px"');
        expect(html).toContain('md-ref__product-icon');
        expect(html).toContain(`--md-ref-product-icon:url(${iconData})`);
        expect(html).not.toContain('codicon-symbol-method');
    });

    it('leaves missing files and existing markdown links unchanged', () => {
        const markdown = installMarkdownReferencePlugin(new MarkdownIt(), {
            workspaceRootForDocument: () => root,
        });
        const env = { currentDocument: { scheme: 'file', fsPath: markdownPath } };
        const html = markdown.render('[src/example.ts](https://example.com) and missing/file.ts', env);
        expect(html).toContain('href="https://example.com"');
        expect(html).not.toContain('class="md-ref ');
        expect(html).toContain('missing/file.ts');
    });
});
