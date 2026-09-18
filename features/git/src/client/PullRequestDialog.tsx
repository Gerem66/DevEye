import { Button, Dialog, safeHref } from 'deveye-sdk-client';
import type { GitPullRequest, GitPullState } from '../contracts/domain';

import styles from './style.module.css';

export const PULL_STATE_LABELS: Record<GitPullState, string> = {
    open: 'Ouverte',
    draft: 'Brouillon',
    merged: 'Fusionnée',
    closed: 'Fermée'
};

interface PullRequestDialogProps {
    open: boolean;
    /** La pull request affichée ; `null` ferme le dialogue. */
    pull: GitPullRequest | null;
    onClose: () => void;
}

/**
 * Une pull request, en dialogue plutôt qu'en sous-page : un dialogue se referme
 * là où on l'a ouvert, une sous-page ne se signale que par une flèche de retour
 * et laisse croire qu'on est encore dans l'onglet.
 *
 * La description reste du texte brut préformaté : l'afficher en Markdown
 * demanderait un analyseur complet pour un écran de consultation.
 */
export function PullRequestDialog({ open, pull, onClose }: PullRequestDialogProps) {
    const fmt = (t: number | null) => (t === null ? null : new Date(t * 1000).toLocaleString('fr-FR'));

    return (
        <Dialog
            open={open && pull !== null}
            onClose={onClose}
            title={pull ? pull.title || 'Sans titre' : 'Pull request'}
            description={pull ? `#${pull.number} · ${pull.authorName || 'Auteur inconnu'}` : undefined}
            width={820}
            footer={
                <>
                    {pull?.url && (
                        <a className={styles.externalLink} href={safeHref(pull.url)} target='_blank' rel='noreferrer'>
                            <span className='icon icon-github' /> Voir sur GitHub
                        </a>
                    )}
                    <Button variant='secondary' onClick={onClose}>
                        Fermer
                    </Button>
                </>
            }
        >
            {pull && (
                <div className={styles.form}>
                    <p className={styles.pullMeta}>
                        <span className={styles.pullState} data-state={pull.state}>
                            {PULL_STATE_LABELS[pull.state]}
                        </span>
                        <span className={styles.pullBranches}>
                            <code className={styles.sha}>{pull.headBranch || '?'}</code>
                            <span className='icon icon-move-to-right' />
                            <code className={styles.sha}>{pull.baseBranch || '?'}</code>
                        </span>
                    </p>

                    <ul className={styles.pullDates}>
                        <li>
                            <span className={styles.hint}>Ouverte</span> {fmt(pull.createdAt)}
                        </li>
                        {pull.mergedAt !== null && (
                            <li>
                                <span className={styles.hint}>Fusionnée</span> {fmt(pull.mergedAt)}
                            </li>
                        )}
                        {pull.mergedAt === null && pull.closedAt !== null && (
                            <li>
                                <span className={styles.hint}>Fermée</span> {fmt(pull.closedAt)}
                            </li>
                        )}
                        <li>
                            <span className={styles.hint}>Dernière activité</span> {fmt(pull.updatedAt)}
                        </li>
                    </ul>

                    {pull.body.trim() ? (
                        <pre className={styles.pullBody}>{pull.body}</pre>
                    ) : (
                        <p className={styles.empty}>Cette pull request n’a pas de description.</p>
                    )}
                </div>
            )}
        </Dialog>
    );
}

export default PullRequestDialog;
