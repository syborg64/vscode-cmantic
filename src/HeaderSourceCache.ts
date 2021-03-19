import * as vscode from 'vscode';
import * as path from 'path';
import * as cfg from './configuration';
import * as util from './utility';


export default class HeaderSourceCache {
    private readonly cache = new Map<string, vscode.Uri>();

    /**
     * Gets the matching header/source file from the cache. If not cached, searches for one in the
     * workspace, caches it, and returns it. Returns undefined if not found.
     */
    async get(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
        const cachedMatchingUri = this.cache.get(uri.toString());
        if (cachedMatchingUri) {
            if (util.uriExists(cachedMatchingUri)) {
                return cachedMatchingUri;
            } else {
                this.delete(uri, cachedMatchingUri);
            }
        }

        return this.findAndSet(uri);
    }

    async add(uri: vscode.Uri): Promise<void> {
        await this.findAndSet(uri);
    }

    set(uri_a: vscode.Uri, uri_b: vscode.Uri): void {
        this.cache.set(uri_a.toString(), uri_b);
        this.cache.set(uri_b.toString(), uri_a);
    }

    delete(...uris: vscode.Uri[]): void {
        uris.forEach(uri => this.cache.delete(uri.toString()));
    }

    private async findAndSet(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
        const matchingUri = await findMatchingHeaderSource(uri);
        if (!matchingUri) {
            return;
        }

        this.set(uri, matchingUri);

        return matchingUri;
    }
}

async function findMatchingHeaderSource(uri: vscode.Uri): Promise<vscode.Uri | undefined> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!workspaceFolder) {
        return;
    }

    const extension = util.fileExtension(uri.fsPath);
    const baseName = util.fileNameBase(uri.fsPath);
    const directory = path.dirname(uri.fsPath);
    const parentDirectory = path.dirname(directory);
    const headerExtensions = cfg.headerExtensions(uri);
    const sourceExtensions = cfg.sourceExtensions(uri);

    let globPattern: string;
    if (headerExtensions.includes(extension)) {
        globPattern = `**/${baseName}.{${sourceExtensions.join(",")}}`;
    } else if (sourceExtensions.includes(extension)) {
        globPattern = `**/${baseName}.{${headerExtensions.join(",")}}`;
    } else {
        return;
    }

    const parentDirRelativePattern = new vscode.RelativePattern(parentDirectory, globPattern);
    const parentDirRelativeUris = await vscode.workspace.findFiles(parentDirRelativePattern);
    const bestParentDirRelativeMatch = findBestMatchingUri(directory, parentDirRelativeUris);
    if (bestParentDirRelativeMatch) {
        return bestParentDirRelativeMatch;
    }

    const workspaceRelativePattern = new vscode.RelativePattern(workspaceFolder, globPattern);
    const workspaceRelativeUris = await vscode.workspace.findFiles(workspaceRelativePattern, parentDirectory);
    return findBestMatchingUri(directory, workspaceRelativeUris);
}

function findBestMatchingUri(directoryToCompare: string, uris: vscode.Uri[]): vscode.Uri | undefined {
    let bestMatch: vscode.Uri | undefined;
    let smallestDiff: number | undefined;

    for (const uri of uris) {
        if (uri.scheme !== 'file') {
            continue;
        }

        const diff = util.compareDirectoryPaths(path.dirname(uri.fsPath), directoryToCompare);
        if (smallestDiff === undefined || diff < smallestDiff) {
            smallestDiff = diff;
            bestMatch = uri;
        }
    }

    return bestMatch;
}