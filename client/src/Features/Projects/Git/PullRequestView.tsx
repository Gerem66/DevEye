import type { ProjectPullRequest, ProjectPullState } from 'deveye-types';
import { Button } from '@/Components';
import styles from '../style.module.css';

export const PULL_STATE_LABELS: Record<ProjectPullState, string> = {
    open: 'Ouverte',
    draft: 'Brouillon',
    merged: 'Fusionnée',
    closed: 'Fermée'
};

interface PullRequestViewProps {
    pull: ProjectPullRequest;
    onBack: () => void;
}

/**
 * Une pull request en plein onglet.
 *
 * Elle **remplace** le contenu de l'onglet Git plutôt que de s'ouvrir en
 * dialogue : une description de PR est un document, souvent long, avec des
 * listes et des cases à cocher. Un dialogue l'aurait enfermée dans une boîte
 * étroite, et un second niveau de superposition par-dessus la popup de feature
 * aurait rendu la touche Échap ambiguë.
 *
 * La description reste du **texte brut préformaté** : le rendu Markdown du
 * dépôt (`Features/Notes/RichText`) est une surface éditable, pas un afficheur,
 * et en écrire un pour l'occasion reviendrait à embarquer un analyseur Markdown
 * complet — listes, tableaux, blocs de code, cases à cocher — pour un écran de
 * consultation. Les retours à la ligne et l'indentation sont préservés, ce qui
 * suffit à lire une description de PR.
 */
export function PullRequestView({ pull, onBack }: PullRequestViewProps) {
    const fmt = (t: number | null) => (t === null ? null : new Date(t * 1000).toLocaleString('fr-FR'));

    return (
        <div className={styles.pullView}>
            <header className={styles.pullViewHead}>
                <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                    Git
                </Button>
                <span className={styles.pullState} data-state={pull.state}>
                    {PULL_STATE_LABELS[pull.state]}
                </span>
                <span className={styles.pullNumber}>#{pull.number}</span>
            </header>

            <h3 className={styles.pullTitle}>{pull.title || 'Sans titre'}</h3>

            <p className={styles.pullMeta}>
                <span>{pull.authorName || 'Auteur inconnu'}</span>
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

            {pull.url && (
                <a className={styles.externalLink} href={pull.url} target='_blank' rel='noreferrer'>
                    <span className='icon icon-branch' /> Voir sur GitHub
                </a>
            )}

            {pull.body.trim() ? (
                <pre className={styles.pullBody}>{pull.body}</pre>
            ) : (
                <p className={styles.empty}>Cette pull request n’a pas de description.</p>
            )}
        </div>
    );
}

export default PullRequestView;
