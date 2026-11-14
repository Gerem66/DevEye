import type { GitFilesRequest, GitFilesResult, GitRepoFile } from '@deveye/types/sdk';

import { fetchBlobText, fetchTree, GitHubError, type GitHubTreeFile } from './github';

/** Combien de blobs partent à la fois : assez pour ne pas attendre, trop peu pour faire tiquer GitHub. */
const PARALLEL_BLOBS = 4;

/** Ce que l'arbre donne à lire, dans l'ordre des chemins, et ce qu'il écarte. */
export function pickTreeFiles(
    files: readonly GitHubTreeFile[],
    request: Pick<GitFilesRequest, 'wants' | 'maxFiles' | 'maxFileBytes'>
): { files: GitHubTreeFile[]; skipped: string[]; truncated: boolean } {
    const wanted = files.filter((f) => request.wants(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    const kept: GitHubTreeFile[] = [];
    const skipped: string[] = [];
    for (const file of wanted) {
        if (file.size > request.maxFileBytes) skipped.push(file.path);
        else kept.push(file);
    }
    return { files: kept.slice(0, request.maxFiles), skipped, truncated: kept.length > request.maxFiles };
}

/** Un refus de GitHub dit ce qui manque, au jeton ou au dépôt. */
function failureOf(e: unknown, label: string, token: string | null): Extract<GitFilesResult, { status: 'error' }> {
    if (e instanceof GitHubError) {
        // Un 404 sans jeton : le dépôt est privé, ou n'existe plus.
        if (e.status === 404 && token === null) {
            return { status: 'error', error: `Dépôt ${label} : privé sans jeton, ou introuvable`, userSide: true };
        }
        if ((e.status === 403 || e.status === 404) && !e.rateLimited) {
            return {
                status: 'error',
                error: `Dépôt ${label} : le jeton ne lit pas le contenu (droit Contents en lecture)`,
                userSide: true
            };
        }
        // Le quota et le jeton sont ceux de l'utilisateur ; une panne de GitHub
        // ou du réseau ne s'explique pas de son côté.
        const userSide = e.rateLimited || e.status === 401;
        return { status: 'error', error: `Dépôt ${label} : ${e.message}`, userSide };
    }
    return { status: 'error', error: `Dépôt ${label} : ${(e as Error).message}`, userSide: false };
}

/** Les fichiers voulus d'un dépôt, lus chez GitHub sans clone. */
export async function readRepoFiles(
    label: string,
    token: string | null,
    request: GitFilesRequest
): Promise<GitFilesResult> {
    const [owner, name] = label.split('/');
    try {
        const tree = await fetchTree(owner, name, token, request.ref ?? 'HEAD');
        if (tree.sha !== '' && tree.sha === request.knownTree) return { status: 'unchanged', tree: tree.sha };
        const picked = pickTreeFiles(tree.files, request);
        const files: GitRepoFile[] = [];
        for (let i = 0; i < picked.files.length; i += PARALLEL_BLOBS) {
            const batch = picked.files.slice(i, i + PARALLEL_BLOBS);
            const texts = await Promise.all(batch.map((f) => fetchBlobText(owner, name, token, f.sha)));
            batch.forEach((f, index) => files.push({ path: f.path, text: texts[index] }));
        }
        return {
            status: 'ok',
            tree: tree.sha,
            files,
            truncated: tree.truncated || picked.truncated,
            skipped: picked.skipped
        };
    } catch (e) {
        return failureOf(e, label, token);
    }
}
