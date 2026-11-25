import * as fs from 'fs';
import * as path from 'path';

export interface LineRange {
    start: number;
    end: number;
}

export interface ParsedReference {
    raw: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
    symbol?: string;
    preview: boolean;
    highlightLines?: LineRange[];
    focusLines?: LineRange[];
}

export interface ResolvedReference extends ParsedReference {
    absolutePath: string;
    isDirectory: boolean;
}

export interface ReferenceMatch {
    index: number;
    length: number;
    value: string;
}

const segment = String.raw`[A-Za-z0-9_@+~.-]*[A-Za-z0-9_@+~-]`;
const pathWithDirectory = String.raw`(?:(?:\.{1,2}[\\/])|${segment}[\\/])(?:${segment}[\\/])*${segment}`;
const fileWithExtension = String.raw`[A-Za-z0-9_@+~-]+\.[A-Za-z0-9_@+~.-]*[A-Za-z0-9_@+~-]`;
const symbolFragment = String.raw`#[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*`;
const lineRangeList = String.raw`\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*`;
const queryParameter = String.raw`(?:preview=true|(?:highlight|focus)=${lineRangeList})`;
const referenceQuery = String.raw`\?${queryParameter}(?:&${queryParameter})*`;
const bareReferencePattern = new RegExp(
    String.raw`(^|[\s([{"'“‘])((?:${pathWithDirectory}|${fileWithExtension})(?::\d+(?:-\d+)?)?(?:(?:${symbolFragment})(?:${referenceQuery})?|(?:${referenceQuery})(?:${symbolFragment})?)?)(?=$|[\s)\]}"'”’.,;!?，。；！？])`,
    'gi'
);

export function parseReference(value: string): ParsedReference | undefined {
    const raw = value.trim();
    if (!raw || /[\r\n]/.test(raw)) return undefined;

    const split = splitReferenceQuery(raw);
    if (!split) return undefined;
    let body = split.body;
    const query = parseReferenceQuery(split.query);
    if (!query) return undefined;

    let symbol: string | undefined;
    const fragmentIndex = body.indexOf('#');
    if (fragmentIndex >= 0) {
        if (body.indexOf('#', fragmentIndex + 1) >= 0) return undefined;
        try {
            symbol = decodeURIComponent(body.slice(fragmentIndex + 1));
        } catch {
            return undefined;
        }
        body = body.slice(0, fragmentIndex);
        if (!symbol || /[\r\n?#]/.test(symbol)) return undefined;
    }

    let startLine: number | undefined;
    let endLine: number | undefined;
    const lineMatch = body.match(/:(\d+)(?:-(\d+))?$/);
    if (lineMatch) {
        startLine = Number(lineMatch[1]);
        endLine = lineMatch[2] ? Number(lineMatch[2]) : startLine;
        body = body.slice(0, -lineMatch[0].length);
        if (startLine < 1 || endLine < startLine) return undefined;
    }

    if (!body || /^(?:https?|mailto|data|command|vscode):/i.test(body)) return undefined;
    if (/[\0<>|*]/.test(body)) return undefined;

    return {
        raw,
        filePath: body,
        startLine,
        endLine,
        symbol,
        preview: query.preview,
        ...(query.highlightLines ? { highlightLines: query.highlightLines } : {}),
        ...(query.focusLines ? { focusLines: query.focusLines } : {}),
    };
}

interface ReferenceQueryOptions {
    preview: boolean;
    highlightLines?: LineRange[];
    focusLines?: LineRange[];
}

function splitReferenceQuery(raw: string): { body: string; query?: string } | undefined {
    const queryIndex = raw.indexOf('?');
    if (queryIndex < 0) return { body: raw };
    if (raw.indexOf('?', queryIndex + 1) >= 0) return undefined;

    const fragmentIndex = raw.indexOf('#');
    if (fragmentIndex > queryIndex) {
        return {
            body: raw.slice(0, queryIndex) + raw.slice(fragmentIndex),
            query: raw.slice(queryIndex + 1, fragmentIndex),
        };
    }
    return {
        body: raw.slice(0, queryIndex),
        query: raw.slice(queryIndex + 1),
    };
}

function parseReferenceQuery(query: string | undefined): ReferenceQueryOptions | undefined {
    if (query === undefined) return { preview: false };
    if (!query) return undefined;

    const result: ReferenceQueryOptions = { preview: false };
    const seen = new Set<string>();
    for (const [rawKey, value] of new URLSearchParams(query)) {
        const key = rawKey.toLowerCase();
        if (seen.has(key)) return undefined;
        seen.add(key);
        if (key === 'preview') {
            if (value.toLowerCase() !== 'true') return undefined;
            result.preview = true;
        } else if (key === 'highlight' || key === 'focus') {
            const ranges = parseLineRanges(value);
            if (!ranges) return undefined;
            if (key === 'highlight') result.highlightLines = ranges;
            else result.focusLines = ranges;
        } else {
            return undefined;
        }
    }
    if ((result.highlightLines || result.focusLines) && !result.preview) return undefined;
    return result;
}

function parseLineRanges(value: string): LineRange[] | undefined {
    if (!value || value.length > 1000) return undefined;
    const ranges: LineRange[] = [];
    for (const part of value.split(',')) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!match) return undefined;
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : start;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
            return undefined;
        }
        ranges.push({ start, end });
    }
    return ranges;
}

export function findReferenceMatches(text: string): ReferenceMatch[] {
    const matches: ReferenceMatch[] = [];
    bareReferencePattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = bareReferencePattern.exec(text))) {
        const prefixLength = match[1].length;
        matches.push({
            index: match.index + prefixLength,
            length: match[2].length,
            value: match[2],
        });
    }
    return matches;
}

export function resolveReference(
    reference: ParsedReference,
    currentDocumentPath: string,
    workspaceRoot?: string
): ResolvedReference | undefined {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(reference.filePath);
    } catch {
        return undefined;
    }

    const candidates: string[] = [];
    const workspaceRelative = /^[\\/]/.test(decodedPath) && !/^[\\/]{2}/.test(decodedPath);
    if (workspaceRelative && workspaceRoot) {
        candidates.push(path.resolve(workspaceRoot, decodedPath.replace(/^[\\/]+/, '')));
    } else if (path.isAbsolute(decodedPath)) {
        candidates.push(path.normalize(decodedPath));
    } else {
        candidates.push(path.resolve(path.dirname(currentDocumentPath), decodedPath));
        if (workspaceRoot) candidates.push(path.resolve(workspaceRoot, decodedPath));
    }

    for (const absolutePath of new Set(candidates)) {
        try {
            const stat = fs.statSync(absolutePath);
            if (!stat.isFile() && !stat.isDirectory()) continue;
            return { ...reference, absolutePath, isDirectory: stat.isDirectory() };
        } catch {
            // A candidate that does not exist is not a reference.
        }
    }
    return undefined;
}

export function referenceHref(
    reference: ResolvedReference,
    currentDocumentPath: string,
    uriScheme = 'vscode'
): string {
    if (reference.symbol) {
        const query = new URLSearchParams({
            file: reference.absolutePath,
            symbol: reference.symbol,
        });
        const scheme = uriScheme.trim() || 'vscode';
        return `${scheme}://r0kuko.vscode-markdown-reference/open-symbol?${query.toString()}`;
    }
    const relativePath = path.relative(path.dirname(currentDocumentPath), reference.absolutePath);
    const encodedPath = relativePath
        .split(path.sep)
        .map(segment => encodeURIComponent(segment))
        .join('/');
    let fragment = '';
    if (reference.startLine) {
        const end = reference.endLine ?? reference.startLine;
        fragment = end === reference.startLine
            ? `#L${reference.startLine}`
            : `#L${reference.startLine}-L${end}`;
    }
    return `${encodedPath || path.basename(reference.absolutePath)}${fragment}`;
}

export function languageForFile(filePath: string): string {
    const base = path.basename(filePath).toLowerCase();
    const extension = path.extname(base).slice(1);
    const aliases: Record<string, string> = {
        cjs: 'javascript',
        h: 'c',
        hpp: 'cpp',
        js: 'javascript',
        jsx: 'javascriptreact',
        kt: 'kotlin',
        kts: 'kotlin',
        md: 'markdown',
        mjs: 'javascript',
        ps1: 'powershell',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        sh: 'shell',
        ts: 'typescript',
        tsx: 'typescriptreact',
        yml: 'yaml',
    };
    if (base === 'dockerfile') return 'dockerfile';
    return aliases[extension] ?? extension;
}

export type FileIcon = 'archive' | 'code' | 'database' | 'folder' | 'image' | 'json' | 'markdown' | 'text';

export function iconForFile(filePath: string, isDirectory: boolean): FileIcon {
    if (isDirectory) return 'folder';
    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (['md', 'mdx', 'markdown'].includes(extension)) return 'markdown';
    if (['json', 'jsonc', 'toml', 'xml', 'yaml', 'yml'].includes(extension)) return 'json';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'].includes(extension)) return 'image';
    if (['zip', 'gz', 'tgz', 'rar', '7z', 'tar', 'jar'].includes(extension)) return 'archive';
    if (['db', 'sqlite', 'sqlite3', 'sql'].includes(extension)) return 'database';
    if (['txt', 'log', 'csv'].includes(extension)) return 'text';
    return 'code';
}
