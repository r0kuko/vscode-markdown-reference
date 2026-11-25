import * as fs from 'fs';
import * as path from 'path';
import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { SyntaxHighlightTheme, SyntaxTokenKind } from './colorTheme';
import { loadGitDiff, type GitDiffResult } from './gitDiff';
import { parseGitPatch, type GitPatchFile, type GitPatchLine } from './gitPatch';
import { findGitReferenceMatches, parseGitReference, type ParsedGitReference } from './gitReference';
import {
    findReferenceMatches,
    iconForFile,
    languageForFile,
    parseReference,
    referenceHref,
    resolveReference,
    ResolvedReference,
} from './reference';

interface MarkdownEnvironment {
    currentDocument?: { fsPath?: string; scheme?: string };
}

interface PreviewLineRange {
    startLine: number;
    endLine: number;
}

export interface MarkdownReferencePluginOptions {
    uriScheme?: string;
    workspaceRootForDocument?: (documentPath: string) => string | undefined;
    fontSizeForDocument?: (documentPath: string) => number | undefined;
    tabSizeForFile?: (filePath: string) => number | undefined;
    syntaxThemeForFile?: (filePath: string) => SyntaxHighlightTheme | undefined;
    fileIconForPath?: (filePath: string, isDirectory: boolean) => { dataUri: string } | undefined;
    symbolIconForReference?: (
        filePath: string,
        symbol: string
    ) => { codicon: string; color: string; themedIcon?: { dataUri: string } } | undefined;
    symbolRangeForReference?: (
        filePath: string,
        symbol: string
    ) => PreviewLineRange | null | undefined;
    gitDiffForReference?: (
        reference: ParsedGitReference,
        documentPath: string,
        workspaceRoot?: string
    ) => GitDiffResult;
}

const iconClasses = {
    archive: 'codicon-file-zip',
    code: 'codicon-file-code',
    database: 'codicon-database',
    folder: 'codicon-folder',
    image: 'codicon-file-media',
    json: 'codicon-json',
    markdown: 'codicon-markdown',
    text: 'codicon-file-text',
} as const;

export function installMarkdownReferencePlugin(
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions = {}
): MarkdownIt {
    const originalTextRule = markdown.renderer.rules.text;
    const originalCodeRule = markdown.renderer.rules.code_inline;

    markdown.renderer.rules.text = (tokens, index, options, env: MarkdownEnvironment, renderer) => {
        if (isInsideLink(tokens, index)) {
            return originalTextRule
                ? originalTextRule(tokens, index, options, env, renderer)
                : markdown.utils.escapeHtml(tokens[index].content);
        }
        const rendered = renderTextReferences(tokens[index].content, env, markdown, pluginOptions);
        if (rendered !== undefined) return rendered;
        return originalTextRule
            ? originalTextRule(tokens, index, options, env, renderer)
            : markdown.utils.escapeHtml(tokens[index].content);
    };

    markdown.renderer.rules.code_inline = (tokens, index, options, env: MarkdownEnvironment, renderer) => {
        const rendered = renderExactReference(tokens[index].content, env, markdown, pluginOptions);
        if (rendered !== undefined) return rendered;
        if (originalCodeRule) return originalCodeRule(tokens, index, options, env, renderer);
        return `<code>${markdown.utils.escapeHtml(tokens[index].content.replace(/\n/g, ' '))}</code>`;
    };

    return markdown;
}

function renderTextReferences(
    text: string,
    env: MarkdownEnvironment,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string | undefined {
    const candidates = [...findReferenceMatches(text), ...findGitReferenceMatches(text)]
        .sort((left, right) => left.index - right.index || right.length - left.length);
    const matches = candidates.filter((match, index) =>
        !candidates.slice(0, index).some(selected =>
            match.index < selected.index + selected.length
            && selected.index < match.index + match.length
        )
    );
    if (!matches.length) return undefined;

    let output = '';
    let cursor = 0;
    let transformed = false;
    for (const match of matches) {
        output += markdown.utils.escapeHtml(text.slice(cursor, match.index));
        const rendered = renderExactReference(match.value, env, markdown, pluginOptions);
        if (rendered === undefined) {
            output += markdown.utils.escapeHtml(match.value);
        } else {
            output += rendered;
            transformed = true;
        }
        cursor = match.index + match.length;
    }
    output += markdown.utils.escapeHtml(text.slice(cursor));
    return transformed ? output : undefined;
}

function renderExactReference(
    value: string,
    env: MarkdownEnvironment,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string | undefined {
    const documentPath = env.currentDocument?.scheme === 'file'
        ? env.currentDocument.fsPath
        : undefined;
    if (!documentPath) return undefined;

    const gitReference = parseGitReference(value);
    if (gitReference) {
        const workspaceRoot = pluginOptions.workspaceRootForDocument?.(documentPath);
        return renderGitDiff(gitReference, documentPath, workspaceRoot, markdown, pluginOptions);
    }

    const parsed = parseReference(value);
    if (!parsed) return undefined;
    const workspaceRoot = pluginOptions.workspaceRootForDocument?.(documentPath);
    const resolved = resolveReference(parsed, documentPath, workspaceRoot);
    if (!resolved) return undefined;

    return resolved.preview && !resolved.isDirectory
        ? renderPreview(resolved, documentPath, markdown, pluginOptions)
        : renderLink(resolved, documentPath, markdown, pluginOptions);
}

function renderGitDiff(
    reference: ParsedGitReference,
    documentPath: string,
    workspaceRoot: string | undefined,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string {
    const result = pluginOptions.gitDiffForReference
        ? pluginOptions.gitDiffForReference(reference, documentPath, workspaceRoot)
        : loadGitDiff(reference, documentPath, workspaceRoot);
    if (!result.ok) {
        return renderGitDiffMessage(reference, result.message, markdown);
    }

    const label = markdown.utils.escapeHtml(result.label);
    const comparison = markdown.utils.escapeHtml(result.comparison);
    if (!result.diff) {
        return renderGitDiffMessage(reference, 'No changes were found for this comparison.', markdown, label, comparison);
    }

    const files = parseGitPatch(result.diff);
    if (!files.length) {
        return renderGitDiffMessage(reference, 'This Git change cannot be displayed as source code.', markdown, label, comparison);
    }
    const fileMarkup = files.map(file => renderGitDiffFile(
        file,
        files.length > 1 || (!reference.diffOnly && reference.kind === 'repository'),
        result.repositoryRoot,
        documentPath,
        markdown,
        pluginOptions
    )).join('');

    if (reference.diffOnly) {
        return `<span class="md-ref-git-diff md-ref-git-diff--only">${fileMarkup}</span>`;
    }
    const title = reference.filePath
        ? renderGitFileLink(result.label, reference.filePath, result.repositoryRoot, documentPath, markdown)
        : label;
    return `<span class="md-ref-preview md-ref-git-diff">`
        + `<span class="md-ref-preview__header md-ref-git-diff__header">`
        + `<span class="md-ref-git-diff__title"><span class="codicon codicon-git-compare" aria-hidden="true"></span>${title}</span>`
        + `<span class="md-ref-preview__meta">${comparison}</span></span>`
        + `<span class="md-ref-git-diff__files">${fileMarkup}</span></span>`;
}

function renderGitDiffMessage(
    reference: ParsedGitReference,
    message: string,
    markdown: MarkdownIt,
    label = markdown.utils.escapeHtml(reference.filePath ?? (reference.commit ? `Commit ${reference.commit}` : 'Repository changes')),
    comparison = markdown.utils.escapeHtml(reference.commit
        ? `${reference.commit}^ -> ${reference.commit}`
        : `${reference.base ?? '?'} -> ${reference.head}`)
): string {
    const messageMarkup = `<span class="md-ref-preview__message">${markdown.utils.escapeHtml(message)}</span>`;
    if (reference.diffOnly) {
        return `<span class="md-ref-git-diff md-ref-git-diff--only">${messageMarkup}</span>`;
    }
    return `<span class="md-ref-preview md-ref-git-diff">`
        + `<span class="md-ref-preview__header md-ref-git-diff__header">`
        + `<span class="md-ref-git-diff__title"><span class="codicon codicon-git-compare" aria-hidden="true"></span>${label}</span>`
        + `<span class="md-ref-preview__meta">${comparison}</span></span>${messageMarkup}</span>`;
}

function renderGitDiffFile(
    file: GitPatchFile,
    showFileName: boolean,
    repositoryRoot: string | undefined,
    documentPath: string,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string {
    const language = languageForFile(file.path);
    const source = file.lines.map(line => line.kind === 'separator' ? '' : line.content).join('\n');
    let code = markdown.utils.escapeHtml(source);
    if (language && typeof markdown.options.highlight === 'function') {
        try {
            code = markdown.options.highlight(source, language, '') || code;
        } catch {
            // Fall back to escaped source when the highlighter rejects it.
        }
    }
    const themePath = repositoryRoot
        ? path.join(repositoryRoot, ...file.path.split('/'))
        : documentPath;
    const syntaxTheme = pluginOptions.syntaxThemeForFile?.(themePath);
    if (syntaxTheme) code = applySyntaxTheme(code, syntaxTheme);
    const renderedCode = renderGitSourceLines(code, file.lines, markdown);
    const languageClass = language ? ` language-${markdown.utils.escapeHtml(language)}` : '';
    const languageLabel = markdown.utils.escapeHtml(languageLabelForFile(file.path, language));
    const fileName = showFileName
        ? renderGitFileLink(file.path, file.path, repositoryRoot, documentPath, markdown, 'md-ref-git-diff__file-name')
        : '<span></span>';
    return `<span class="md-ref-git-diff__file">`
        + `<span class="md-ref-git-diff__file-header">${fileName}<span class="md-ref-git-diff__language">${languageLabel}</span></span>`
        + `<code class="hljs md-ref-preview__code md-ref-git-diff__code${languageClass}"${syntaxTheme ? ` style="color:${syntaxTheme.foreground}"` : ''}>${renderedCode}</code></span>`;
}

function renderGitSourceLines(
    highlightedCode: string,
    sourceLines: GitPatchLine[],
    markdown: MarkdownIt
): string {
    const highlightedLines = splitHighlightedCodeLines(highlightedCode);
    if (highlightedLines.length > sourceLines.length) highlightedLines.length = sourceLines.length;
    while (highlightedLines.length < sourceLines.length) highlightedLines.push('');

    return highlightedLines.map((line, index) => {
        const sourceLine = sourceLines[index];
        const classes = ['md-ref-git-diff__line'];
        let marker = '';
        if (sourceLine.kind === 'addition') {
            classes.push('md-ref-git-diff__line--addition');
            marker = '+';
        } else if (sourceLine.kind === 'deletion') {
            classes.push('md-ref-git-diff__line--deletion');
            marker = '-';
        } else if (sourceLine.kind === 'separator') {
            classes.push('md-ref-git-diff__line--separator');
            line = markdown.utils.escapeHtml(sourceLine.content);
        } else if (sourceLine.kind === 'message') {
            classes.push('md-ref-git-diff__line--message');
        }
        return `<span class="${classes.join(' ')}">`
            + `<span class="md-ref-git-diff__marker">${marker}</span>`
            + `<span class="md-ref-git-diff__line-content">${line}</span></span>`;
    }).join('');
}

function languageLabelForFile(filePath: string, language: string): string {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    return extension || language || 'text';
}

function renderGitFileLink(
    label: string,
    filePath: string,
    repositoryRoot: string | undefined,
    documentPath: string,
    markdown: MarkdownIt,
    className = 'md-ref-git-diff__link'
): string {
    const escapedLabel = markdown.utils.escapeHtml(label);
    if (!repositoryRoot) return `<span class="${className}">${escapedLabel}</span>`;
    const absolutePath = path.resolve(repositoryRoot, ...filePath.split('/'));
    const repositoryRelativePath = path.relative(repositoryRoot, absolutePath);
    if (repositoryRelativePath.startsWith('..') || path.isAbsolute(repositoryRelativePath)) {
        return `<span class="${className}">${escapedLabel}</span>`;
    }
    const relativePath = path.relative(path.dirname(documentPath), absolutePath);
    const href = relativePath
        .split(path.sep)
        .map(segment => encodeURIComponent(segment))
        .join('/');
    const escapedHref = markdown.utils.escapeHtml(href || path.basename(absolutePath));
    const escapedTitle = markdown.utils.escapeHtml(absolutePath);
    return `<a class="${className}" href="${escapedHref}" data-href="${escapedHref}" title="${escapedTitle}">${escapedLabel}</a>`;
}

function renderLink(
    reference: ResolvedReference,
    documentPath: string,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string {
    const icon = iconForFile(reference.absolutePath, reference.isDirectory);
    const displayPath = markdown.utils.escapeHtml(
        reference.symbol ? reference.filePath.split(/[\\/]/).at(-1) ?? reference.filePath : reference.filePath
    );
    const href = markdown.utils.escapeHtml(referenceHref(reference, documentPath, pluginOptions.uriScheme));
    const title = markdown.utils.escapeHtml(reference.absolutePath);
    const configuredFontSize = pluginOptions.fontSizeForDocument?.(documentPath);
    const fontSize = typeof configuredFontSize === 'number' && configuredFontSize >= 8 && configuredFontSize <= 32
        ? configuredFontSize
        : 13;
    const range = reference.startLine
        ? `<span class="md-ref__range">L${reference.startLine}${reference.endLine !== reference.startLine ? `-${reference.endLine}` : ''}</span>`
        : '';
    const symbol = reference.symbol
        ? `<span class="md-ref__symbol">#${markdown.utils.escapeHtml(reference.symbol)}</span>`
        : '';
    const symbolIcon = reference.symbol
        ? pluginOptions.symbolIconForReference?.(reference.absolutePath, reference.symbol)
        : undefined;
    const themedIcon = reference.symbol
        ? undefined
        : pluginOptions.fileIconForPath?.(reference.absolutePath, reference.isDirectory);
    const symbolColorClass = symbolIcon
        ? `md-ref__symbol-icon--${markdown.utils.escapeHtml(symbolIcon.color)}`
        : '';
    const iconMarkup = symbolIcon?.themedIcon
        ? `<span class="md-ref__icon md-ref__product-icon md-ref__symbol-icon ${symbolColorClass}" style="--md-ref-product-icon:url(${markdown.utils.escapeHtml(symbolIcon.themedIcon.dataUri)})" aria-hidden="true"></span>`
        : symbolIcon
            ? `<span class="codicon ${markdown.utils.escapeHtml(symbolIcon.codicon)} md-ref__icon md-ref__symbol-icon ${symbolColorClass}" aria-hidden="true"></span>`
        : themedIcon
            ? `<img class="md-ref__icon md-ref__theme-icon" src="${markdown.utils.escapeHtml(themedIcon.dataUri)}" alt="">`
            : `<span class="codicon ${iconClasses[icon]} md-ref__icon" aria-hidden="true"></span>`;
    const linkKind = reference.symbol ? ' md-ref--symbol' : '';
    return `<a class="md-ref md-ref--${icon}${linkKind}" href="${href}" data-href="${href}" title="${title}" style="--md-ref-font-size:${fontSize}px">`
        + iconMarkup
        + `<span class="md-ref__label"><span class="md-ref__path">${displayPath}</span>${symbol}</span>${range}</a>`;
}

function renderPreview(
    reference: ResolvedReference,
    documentPath: string,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string {
    const link = renderPreviewLink(reference, documentPath, markdown, pluginOptions);
    const symbolRange = reference.symbol
        ? pluginOptions.symbolRangeForReference?.(reference.absolutePath, reference.symbol)
        : undefined;
    if (reference.symbol && symbolRange === undefined) {
        return renderPreviewMessage(link, 'Resolving symbol preview...');
    }
    if (symbolRange === null) {
        return renderPreviewMessage(link, 'This symbol cannot be previewed.');
    }
    const sourceReference = symbolRange
        ? { ...reference, startLine: symbolRange.startLine, endLine: symbolRange.endLine }
        : reference;
    const configuredTabSize = pluginOptions.tabSizeForFile?.(reference.absolutePath);
    const tabSize = typeof configuredTabSize === 'number'
        && Number.isInteger(configuredTabSize)
        && configuredTabSize >= 1
        && configuredTabSize <= 16
        ? configuredTabSize
        : 4;
    const source = readPreviewSource(sourceReference, reference.symbol ? tabSize : undefined);
    if (!source) {
        return renderPreviewMessage(link, 'This file cannot be previewed.');
    }

    const language = languageForFile(reference.absolutePath);
    let code = markdown.utils.escapeHtml(source.content);
    if (language && typeof markdown.options.highlight === 'function') {
        try {
            code = markdown.options.highlight(source.content, language, '') || code;
        } catch {
            // Fall back to escaped source when a grammar rejects the snippet.
        }
    }
    const syntaxTheme = pluginOptions.syntaxThemeForFile?.(reference.absolutePath);
    if (syntaxTheme) code = applySyntaxTheme(code, syntaxTheme);
    const languageClass = language
        ? ` language-${markdown.utils.escapeHtml(language)}`
        : '';
    const lineLabel = source.startLine === source.endLine
        ? `Line ${source.startLine}`
        : `Lines ${source.startLine}-${source.endLine}`;
    const hasFocus = Boolean(reference.focusLines?.length);
    const hasLineDecorations = hasFocus || Boolean(reference.highlightLines?.length);
    const renderedCode = hasLineDecorations
        ? renderDecoratedCodeLines(code, source, reference)
        : code;
    const focusClass = hasFocus ? ' md-ref-preview__code--has-focus' : '';

    return `<span class="md-ref-preview">`
        + `<span class="md-ref-preview__header">${link}`
        + `<span class="md-ref-preview__meta">${lineLabel}</span></span>`
        + `<code class="hljs md-ref-preview__code${focusClass}${languageClass}" style="--md-ref-tab-size:${tabSize};${syntaxTheme ? `color:${syntaxTheme.foreground}` : ''}">${renderedCode}</code></span>`;
}

function applySyntaxTheme(code: string, theme: SyntaxHighlightTheme): string {
    return code.replace(/<span\b[^>]*>/gi, tag => {
        const classMatch = /\bclass=(['"])(.*?)\1/i.exec(tag);
        if (!classMatch) return tag;
        const classes = classMatch[2]
            .split(/\s+/)
            .map(value => value.toLowerCase().replace(/^hljs-/, '').replace(/_$/, ''));
        const kind = syntaxTokenKindForClasses(classes);
        if (!kind) return tag;
        const style = theme.tokens[kind];
        const css = `color:${style.color};font-style:${style.fontStyle};font-weight:${style.fontWeight};text-decoration:${style.textDecoration}`;
        if (/\sstyle=(['"])(.*?)\1/i.test(tag)) {
            return tag.replace(/\sstyle=(['"])(.*?)\1/i, (_match, quote: string, current: string) =>
                ` style=${quote}${current};${css}${quote}`
            );
        }
        return `${tag.slice(0, -1)} style="${css}">`;
    });
}

function syntaxTokenKindForClasses(classes: string[]): SyntaxTokenKind | undefined {
    if (classes.includes('title') && classes.includes('class')) return 'type';
    if (classes.includes('title') && classes.includes('function')) return 'function';
    const mappings: Array<[SyntaxTokenKind, string[]]> = [
        ['comment', ['comment', 'quote']],
        ['keyword', ['keyword']],
        ['string', ['string', 'doctag']],
        ['number', ['number']],
        ['literal', ['literal']],
        ['regexp', ['regexp']],
        ['function', ['title', 'section']],
        ['type', ['type', 'class']],
        ['parameter', ['params']],
        ['property', ['attr', 'property']],
        ['attribute', ['attribute']],
        ['variable', ['variable', 'template-variable']],
        ['built-in', ['built_in', 'builtin-name']],
        ['meta', ['meta']],
        ['tag', ['tag', 'name']],
        ['selector', ['selector-tag', 'selector-id', 'selector-class', 'selector-attr', 'selector-pseudo']],
        ['symbol', ['symbol', 'bullet']],
        ['addition', ['addition']],
        ['deletion', ['deletion']],
    ];
    return mappings.find(([, candidates]) => candidates.some(candidate => classes.includes(candidate)))?.[0];
}

function renderDecoratedCodeLines(
    highlightedCode: string,
    source: PreviewSource,
    reference: ResolvedReference
): string {
    const sourceLineCount = source.content.split('\n').length;
    const highlightedLines = splitHighlightedCodeLines(highlightedCode);
    if (highlightedLines.length > sourceLineCount) highlightedLines.length = sourceLineCount;
    while (highlightedLines.length < sourceLineCount) highlightedLines.push('');

    return highlightedLines.map((line, index) => {
        const relativeLine = index + 1;
        const classes = ['md-ref-preview__line'];
        if (matchesLineRange(relativeLine, reference.highlightLines)) {
            classes.push('md-ref-preview__line--highlight');
        }
        if (matchesLineRange(relativeLine, reference.focusLines)) {
            classes.push('md-ref-preview__line--focus');
        }
        return `<span class="${classes.join(' ')}" data-line="${source.startLine + index}">${line}</span>`;
    }).join('');
}

function splitHighlightedCodeLines(code: string): string[] {
    const lines = [''];
    const openSpans: string[] = [];
    const tokens = /(<span\b[^>]*>|<\/span>|\r?\n)/gi;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(code))) {
        lines[lines.length - 1] += code.slice(cursor, match.index);
        const token = match[0];
        if (/\r?\n/.test(token)) {
            lines[lines.length - 1] += '</span>'.repeat(openSpans.length);
            lines.push(openSpans.join(''));
        } else {
            lines[lines.length - 1] += token;
            if (/^<span\b/i.test(token)) openSpans.push(token);
            else if (openSpans.length) openSpans.pop();
        }
        cursor = match.index + token.length;
    }
    lines[lines.length - 1] += code.slice(cursor);
    return lines;
}

function matchesLineRange(
    line: number,
    ranges: ResolvedReference['highlightLines'] | ResolvedReference['focusLines']
): boolean {
    return ranges?.some(range => line >= range.start && line <= range.end) ?? false;
}

function renderPreviewLink(
    reference: ResolvedReference,
    documentPath: string,
    markdown: MarkdownIt,
    pluginOptions: MarkdownReferencePluginOptions
): string {
    const href = markdown.utils.escapeHtml(referenceHref(reference, documentPath, pluginOptions.uriScheme));
    const title = markdown.utils.escapeHtml(reference.absolutePath);
    const fileName = markdown.utils.escapeHtml(reference.filePath.split(/[\\/]/).at(-1) ?? reference.filePath);
    const symbol = reference.symbol ? `#${markdown.utils.escapeHtml(reference.symbol)}` : '';
    const configuredFontSize = pluginOptions.fontSizeForDocument?.(documentPath);
    const fontSize = typeof configuredFontSize === 'number' && configuredFontSize >= 8 && configuredFontSize <= 32
        ? configuredFontSize
        : 13;
    return `<a class="md-ref-preview__link" href="${href}" data-href="${href}" title="${title}" style="--md-ref-font-size:${fontSize}px">${fileName}${symbol}</a>`;
}

function renderPreviewMessage(link: string, message: string): string {
    return `<span class="md-ref-preview">`
        + `<span class="md-ref-preview__header">${link}</span>`
        + `<span class="md-ref-preview__message">${message}</span></span>`;
}

interface PreviewSource {
    content: string;
    startLine: number;
    endLine: number;
}

function readPreviewSource(
    reference: ResolvedReference,
    dedentTabSize?: number
): PreviewSource | undefined {
    try {
        const stat = fs.statSync(reference.absolutePath);
        if (stat.size > 1024 * 1024) return undefined;
        const content = fs.readFileSync(reference.absolutePath, 'utf8');
        if (content.includes('\0')) return undefined;
        const lines = content.replace(/\r\n?/g, '\n').split('\n');
        const startLine = reference.startLine ?? 1;
        if (startLine > lines.length) return undefined;
        const requestedEnd = reference.endLine ?? Math.min(lines.length, startLine + 199);
        const endLine = Math.min(requestedEnd, lines.length);
        const previewLines = lines.slice(startLine - 1, endLine);
        return {
            content: (dedentTabSize ? dedentLines(previewLines, dedentTabSize) : previewLines).join('\n'),
            startLine,
            endLine,
        };
    } catch {
        return undefined;
    }
}

function dedentLines(lines: string[], tabSize: number): string[] {
    const nonEmptyIndents = lines
        .filter(line => line.trim().length > 0)
        .map(line => indentationColumns(line, tabSize));
    if (!nonEmptyIndents.length) return lines.map(() => '');
    const indentToRemove = Math.min(...nonEmptyIndents);
    if (indentToRemove === 0) return lines;
    return lines.map(line => removeIndentColumns(line, indentToRemove, tabSize));
}

function indentationColumns(line: string, tabSize: number): number {
    let columns = 0;
    for (const character of line) {
        if (character === ' ') columns++;
        else if (character === '\t') columns += tabSize - (columns % tabSize);
        else break;
    }
    return columns;
}

function removeIndentColumns(line: string, columnsToRemove: number, tabSize: number): string {
    if (!line.trim()) return '';
    let columns = 0;
    let index = 0;
    while (index < line.length && columns < columnsToRemove) {
        const character = line[index];
        if (character !== ' ' && character !== '\t') break;
        const nextColumns = character === '\t'
            ? columns + tabSize - (columns % tabSize)
            : columns + 1;
        index++;
        if (nextColumns > columnsToRemove) {
            return ' '.repeat(nextColumns - columnsToRemove) + line.slice(index);
        }
        columns = nextColumns;
    }
    return line.slice(index);
}

function isInsideLink(tokens: Token[], index: number): boolean {
    let linkDepth = 0;
    for (let i = 0; i < index; i++) {
        if (tokens[i].type === 'link_open') linkDepth++;
        if (tokens[i].type === 'link_close') linkDepth--;
    }
    return linkDepth > 0;
}
