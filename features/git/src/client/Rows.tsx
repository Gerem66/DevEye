import type { GitBranch, GitCommit, GitPullRequest, GitRelease } from '../contracts/domain';

import { PULL_STATE_LABELS } from './PullRequestDialog';
import styles from './style.module.css';

/**
 * Les lignes des quatre listes d'un dépôt, extraites parce qu'elles servent deux
 * fois : dans le panneau, tronqué, et dans le dialogue « voir tout », complet.
 */

/** Au-delà, un panneau renvoie vers son dialogue « voir tout ». */
export const PANEL_LIMIT = 15;

/** Pour les pull requests et les commits, dont les lignes sont plus hautes. */
export const PANEL_LIMIT_TALL = 10;

/** Un message de commit tient sur plusieurs lignes ; la liste n'en montre qu'une. */
export function firstLine(message: string): string {
    const line = message.split('\n')[0].trim();
    return line || '(sans message)';
}

function BranchDrift({ branch }: { branch: GitBranch }) {
    if (branch.isDefault) return null;
    if (branch.aheadCount === null && branch.behindCount === null) return null;
    return (
        <span className={styles.drift} title='Commits d’avance et de retard sur la branche principale'>
            {branch.aheadCount !== null && branch.aheadCount > 0 && (
                <span className={styles.driftAhead}>↑{branch.aheadCount}</span>
            )}
            {branch.behindCount !== null && branch.behindCount > 0 && (
                <span className={styles.driftBehind}>↓{branch.behindCount}</span>
            )}
            {branch.aheadCount === 0 && branch.behindCount === 0 && <span className={styles.driftSync}>à jour</span>}
        </span>
    );
}

/**
 * Une branche. Seul le sha est cliquable, pas la ligne entière : celle-ci
 * promettrait d'ouvrir la branche alors qu'elle ouvrirait son dernier commit.
 */
export function BranchRow({ branch, onOpenCommit }: { branch: GitBranch; onOpenCommit?: (sha: string) => void }) {
    const head = branch.headSha;
    return (
        <li>
            <span className='icon icon-branch' />
            <span className={styles.gitItemName}>{branch.name}</span>
            {branch.isDefault && <span className={styles.defaultTag}>principale</span>}
            <BranchDrift branch={branch} />
            {head &&
                (onOpenCommit ? (
                    <button
                        type='button'
                        className={styles.shaButton}
                        onClick={() => onOpenCommit(head)}
                        title='Voir les modifications de ce commit'
                    >
                        <code className={styles.sha}>{head.slice(0, 7)}</code>
                    </button>
                ) : (
                    <code className={styles.sha}>{head.slice(0, 7)}</code>
                ))}
        </li>
    );
}

export function ReleaseRow({ release }: { release: GitRelease }) {
    return (
        <li>
            <span className='icon icon-star' />
            <span className={styles.gitItemName}>{release.name || release.tag}</span>
            {release.isPrerelease && <span className={styles.preTag}>pré-version</span>}
            <span className={styles.gitDate}>{new Date(release.publishedAt * 1000).toLocaleDateString('fr-FR')}</span>
        </li>
    );
}

export function PullRow({ pull, onOpen }: { pull: GitPullRequest; onOpen: (pull: GitPullRequest) => void }) {
    return (
        <li>
            <button type='button' className={styles.gitRowButton} onClick={() => onOpen(pull)}>
                <span className={styles.pullState} data-state={pull.state}>
                    {PULL_STATE_LABELS[pull.state]}
                </span>
                <span className={styles.gitItemName}>{pull.title || 'Sans titre'}</span>
                <span className={styles.gitDate}>#{pull.number}</span>
            </button>
        </li>
    );
}

export function CommitRow({ commit, onOpen }: { commit: GitCommit; onOpen: (sha: string) => void }) {
    return (
        <li>
            <button
                type='button'
                className={styles.gitRowButton}
                onClick={() => onOpen(commit.sha)}
                title='Voir les modifications'
            >
                <code className={styles.sha}>{commit.sha.slice(0, 7)}</code>
                <span className={styles.gitItemName}>{firstLine(commit.message)}</span>
                {commit.parentCount > 1 && <span className={styles.preTag}>fusion</span>}
                <span className={styles.gitDate}>
                    {commit.authorName} · {new Date(commit.committedAt * 1000).toLocaleDateString('fr-FR')}
                </span>
            </button>
        </li>
    );
}
