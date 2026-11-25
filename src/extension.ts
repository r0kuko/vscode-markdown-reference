import * as vscode from 'vscode';
import type MarkdownIt from 'markdown-it';
import { ColorThemeService } from './colorThemeService';
import { FileIconThemeService } from './fileIconThemeService';
import { installMarkdownReferencePlugin } from './markdownPlugin';
import { ProductIconThemeService } from './productIconThemeService';
import { SymbolIconService } from './symbolIconService';
import { handleSymbolUri } from './symbolNavigation';

interface MarkdownItExtension {
    extendMarkdownIt(markdown: MarkdownIt): MarkdownIt;
}

export function activate(context: vscode.ExtensionContext): MarkdownItExtension {
    const fileIcons = new FileIconThemeService();
    const colorTheme = new ColorThemeService();
    const productIcons = new ProductIconThemeService();
    const symbolIcons = new SymbolIconService(iconId => productIcons.resolve(iconId));
    context.subscriptions.push(fileIcons, colorTheme, productIcons, symbolIcons);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('markdownReference.fontSize')) {
            void vscode.commands.executeCommand('markdown.preview.refresh');
        }
    }));
    context.subscriptions.push(vscode.window.registerUriHandler({
        handleUri(uri) {
            return handleSymbolUri(uri, symbolIcons);
        },
    }));
    return {
        extendMarkdownIt(markdown: MarkdownIt): MarkdownIt {
            return installMarkdownReferencePlugin(markdown, {
                uriScheme: vscode.env.uriScheme,
                workspaceRootForDocument(documentPath) {
                    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(documentPath))?.uri.fsPath;
                },
                fontSizeForDocument(documentPath) {
                    return vscode.workspace
                        .getConfiguration('markdownReference', vscode.Uri.file(documentPath))
                        .get<number>('fontSize', 13);
                },
                tabSizeForFile(filePath) {
                    return vscode.workspace
                        .getConfiguration('editor', vscode.Uri.file(filePath))
                        .get<number>('tabSize', 4);
                },
                syntaxThemeForFile(filePath) {
                    return colorTheme.resolve(filePath);
                },
                fileIconForPath(filePath, isDirectory) {
                    return fileIcons.resolve(filePath, isDirectory);
                },
                symbolIconForReference(filePath, symbol) {
                    return symbolIcons.resolve(filePath, symbol);
                },
                symbolRangeForReference(filePath, symbol) {
                    const target = symbolIcons.resolveTarget(filePath, symbol);
                    if (target === undefined || target === null) return target;
                    const startLine = target.fullRange.start.line + 1;
                    const endLine = target.fullRange.end.line
                        + (target.fullRange.end.character > 0 ? 1 : 0);
                    return { startLine, endLine: Math.max(startLine, endLine) };
                },
            });
        },
    };
}

export function deactivate(): void {}
