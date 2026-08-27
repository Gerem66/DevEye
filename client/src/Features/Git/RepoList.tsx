import { StatusBadge } from '@/Components';
import type { GitRepo, GitRepoSyncState } from '@deveye/types';
import { useDragReorder } from '@/dragReorder';
import type { useLiveOutlines } from '@/live/useLiveOutline';
import styles from './style.module.css';

interface RepoListProps {
    /** Les dépôts, déjà dans l'ordre de l'utilisateur. */
    repos: GitRepo[];
    /** Les synchronisations en cours, par identifiant de dépôt. */
    syncing: Map<number, GitRepoSyncState>;
    outlineFor: ReturnType<typeof useLiveOutlines>;
    /** Ranger est une écriture : sans le droit, la poignée n'existe pas. */
    canWrite: boolean;
    onOpen: (repoId: number) => void;
    /** L'ordre complet après un dépôt. */
    onReorder: (ids: number[]) => void;
    /** Un glissé commence ou finit — l'appelant suspend ses relectures. */
    onDragStateChange: (dragging: boolean) => void;
}

/**
 * La liste des dépôts, réordonnable au glisser-déposer.
 *
 * Le geste vit dans {@link ../../dragReorder} — il est le même ici, dans Uptime,
 * dans Monitoring et dans les bases de données. Ne restent ici que l'apparence
 * de la carte, celle de la poignée et celle de la barre d'insertion.
 */
export function RepoList({
    repos,
    syncing,
    outlineFor,
    canWrite,
    onOpen,
    onReorder,
    onDragStateChange
}: RepoListProps) {
    const drag = useDragReorder<HTMLUListElement, HTMLLIElement>({
        ids: repos.map((r) => r.id),
        rowSelector: '[data-repo-card]',
        onReorder: (ids) => onReorder(ids as number[]),
        onDragStateChange
    });

    return (
        <ul ref={drag.listRef} className={styles.repoGrid}>
            {repos.map((repo) => (
                <RepoCard
                    key={repo.id}
                    repo={repo}
                    sync={syncing.get(repo.id) ?? null}
                    outline={outlineFor(String(repo.id))}
                    dragging={drag.draggingId === repo.id}
                    onOpen={() => onOpen(repo.id)}
                    onDragPointerDown={canWrite ? (e) => drag.onGripPointerDown(e, repo.id) : undefined}
                />
            ))}
            {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un `<li>` est
                un enfant valide. Sorti du flux par `position: absolute`, il
                n'occupe aucune cellule de la grille. */}
            <li ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
        </ul>
    );
}

interface RepoCardProps {
    repo: GitRepo;
    /** L'avancement de sa synchronisation, ou `null` si elle ne tourne pas. */
    sync: GitRepoSyncState | null;
    outline: ReturnType<ReturnType<typeof useLiveOutlines>>;
    /** Carte en cours de déplacement — estompée, jamais restylée autrement. */
    dragging: boolean;
    onOpen: () => void;
    /** Absent en lecture seule : pas de poignée, pas de réorganisation. */
    onDragPointerDown?: (e: React.PointerEvent) => void;
}

function RepoCard({ repo, sync, outline, dragging, onOpen, onDragPointerDown }: RepoCardProps) {
    // Ce qui empêche ce dépôt de se tenir à jour, s'il y a lieu. Une seule ligne
    // à l'écran : deux causes concurrentes ne s'affichent pas mieux à deux.
    const stalled =
        repo.credentialId === null
            ? 'jeton retiré'
            : !repo.enabled
              ? 'synchronisation suspendue'
              : repo.lastSyncError
                ? 'dernière synchronisation en échec'
                : null;

    return (
        <li className={`${styles.repoCard} ${dragging ? styles.repoCardDragging : ''}`} data-repo-card='' {...outline}>
            {/* Une bande fine en tête de carte, comme sur un compte mail en
                cours de synchronisation : elle dit qu'il se passe quelque chose
                sans déplacer quoi que ce soit dans la carte. */}
            {sync && (
                <div className={styles.syncStrip} aria-hidden='true'>
                    <div
                        className={styles.syncStripFill}
                        style={{ width: `${Math.round((sync.step / sync.stepCount) * 100)}%` }}
                    />
                </div>
            )}

            {/* La poignée est sœur du corps cliquable, et non son enfant : un
                clic parti d'ici ne peut donc pas remonter jusqu'à « ouvrir le
                dépôt », même sans le neutraliser. */}
            {onDragPointerDown && (
                <button
                    type='button'
                    className={styles.repoGrip}
                    aria-label='Réordonner le dépôt'
                    onPointerDown={onDragPointerDown}
                >
                    <span className='icon icon-drag' />
                </button>
            )}

            {/* `div role="button"` et non `<button>` : la carte contient des
                paragraphes, c'est-à-dire du contenu de flux, interdit dans un
                bouton dont le modèle de contenu est phrasé. Même motif que la
                carte de projet. */}
            <div
                className={styles.repoCardBody}
                role='button'
                tabIndex={0}
                onClick={onOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen();
                    }
                }}
            >
                <div className={styles.repoCardMain}>
                    <p className={styles.repoName}>
                        <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                        {repo.foreign && (
                            <span title='Ce dépôt appartient à un autre espace qui le partage ici'>
                                {' '}
                                <StatusBadge tone='accent'>partagé</StatusBadge>
                            </span>
                        )}
                    </p>
                    <p className={styles.repoMeta}>
                        {repo.defaultBranch ?? 'branche inconnue'}
                        {repo.lastSyncAt !== null &&
                            ` · synchronisé ${new Date(repo.lastSyncAt * 1000).toLocaleDateString('fr-FR')}`}
                    </p>
                    <div className={styles.repoCardFoot}>
                        {/* L'étape en cours remplace les indicateurs habituels : ils
                            décrivent un état qui est justement en train de changer. */}
                        {sync && (
                            <span className={styles.syncPhaseTag}>
                                <span className={`icon icon-spinner ${styles.spinning}`} />
                                {sync.phase} · {Math.min(sync.step + 1, sync.stepCount)}/{sync.stepCount}
                            </span>
                        )}
                        <span className={styles.repoUses}>
                            {repo.projectCount === 0
                                ? 'aucun projet'
                                : `${repo.projectCount} projet${repo.projectCount > 1 ? 's' : ''}`}
                        </span>
                        {!sync && stalled && <span className={styles.overdue}>{stalled}</span>}
                    </div>
                </div>

                {/* Sœur du bloc de texte, calée en haut : la flèche annonce que
                    la carte s'ouvre, elle n'appartient pas à la ligne d'état du
                    bas où elle se lisait comme un indicateur de plus. */}
                <span className={styles.openArrow} aria-hidden='true'>
                    <span className='icon icon-arrow' />
                </span>
            </div>
        </li>
    );
}

export default RepoList;
