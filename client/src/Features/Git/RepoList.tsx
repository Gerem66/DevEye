import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitRepo, GitRepoSyncState } from 'deveye-types';
import type { useLiveOutlines } from '@/live/useLiveOutline';
import styles from './style.module.css';

/** Déplacement du pointeur, en px, au-delà duquel une pression devient un glissé. */
const DRAG_THRESHOLD = 6;

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

/** La moitié de l'écart entre deux lignes, où se centre la barre d'insertion. */
function halfGap(list: HTMLElement): number {
    return (parseFloat(getComputedStyle(list).rowGap) || 0) / 2;
}

/** L'ordre que devient `repos` quand `draggedId` atterrit dans l'interstice `gap`. */
function reordered(repos: GitRepo[], draggedId: number, gap: number): number[] | null {
    const from = repos.findIndex((r) => r.id === draggedId);
    if (from === -1) return null;
    const rest = repos.filter((r) => r.id !== draggedId);
    // Retirer d'abord la ligne déplacée décale d'un cran tous les interstices
    // qui la suivaient.
    rest.splice(from < gap ? gap - 1 : gap, 0, repos[from]);
    const ids = rest.map((r) => r.id);
    return ids.every((id, i) => id === repos[i].id) ? null : ids;
}

/**
 * La liste des dépôts, réordonnable au glisser-déposer.
 *
 * Reprend mot pour mot le geste de la liste Uptime ({@link ../Uptime/ServiceList}),
 * et pour les mêmes raisons — qu'il vaut la peine de rappeler ici :
 *
 * **Pointer Events, pas l'API `draggable` du HTML5.** Celle-ci confie le geste à
 * la session de glissé du navigateur, et sur cette plateforme une session
 * interrompue peut laisser la page entière convaincue qu'un glissé est toujours
 * en cours — plus rien ne répond au clic jusqu'à ce qu'un événement extérieur
 * la casse. C'est une défaillance de plateforme, qu'aucun soin apporté à
 * `dragend` ne rattrape : la seule parade est de ne jamais lui confier le geste.
 * Ici tout l'état vit dans les `ref` de ce composant.
 *
 * La barre d'insertion se tient dans l'interstice visé ; **aucune ligne n'est
 * déplacée ni restylée** pendant le geste, de sorte que ce qu'on voit est
 * exactement là où ça tombe.
 *
 * Le glissé part de la **poignée** seule. C'est ce qui garde la carte cliquable,
 * et c'est ce qui rend le geste possible au doigt : seule la poignée renonce au
 * défilement tactile (`touch-action: none`), donc une pression ailleurs fait
 * toujours défiler la page.
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
    const listRef = useRef<HTMLUListElement>(null);
    const barRef = useRef<HTMLLIElement>(null);
    /** L'interstice que marque la barre, ou `null` tant qu'elle est cachée. */
    const gapRef = useRef<number | null>(null);
    /** La pression suivie, tant que le seuil n'est pas franchi. */
    const pressRef = useRef<{ id: number; pointerId: number; x: number; y: number } | null>(null);
    /** Le dépôt réellement glissé (seuil franchi). La logique lit celui-ci. */
    const draggedRef = useRef<number | null>(null);
    /** Le même identifiant, en état, seulement pour estomper la carte : posé
     *  deux fois par glissé, jamais à chaque mouvement du pointeur. */
    const [draggedId, setDraggedId] = useState<number | null>(null);

    const rowEls = useCallback(
        () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-repo-card]') ?? []),
        []
    );

    const hideBar = useCallback(() => {
        gapRef.current = null;
        if (barRef.current) barRef.current.style.opacity = '0';
    }, []);

    /** Dresse la barre dans l'interstice `index` (0 = au-dessus de la première). */
    const showBar = useCallback(
        (index: number) => {
            const list = listRef.current;
            const bar = barRef.current;
            if (!list || !bar || gapRef.current === index) return;
            const rows = rowEls();
            if (rows.length === 0) return;

            // Le vrai milieu de l'interstice, pris sur les lignes qui le
            // bordent — la barre est donc centrée par construction, et non par
            // un décalage correctif.
            const boxes = rows.map((el) => el.getBoundingClientRect());
            let centre: number;
            if (index <= 0) centre = boxes[0].top - halfGap(list);
            else if (index >= boxes.length) centre = boxes[boxes.length - 1].bottom + halfGap(list);
            else centre = (boxes[index - 1].bottom + boxes[index].top) / 2;

            gapRef.current = index;
            const listBox = list.getBoundingClientRect();
            // Moins la moitié de sa propre épaisseur, lue dans le DOM pour que
            // celle-ci ne soit définie que dans la feuille de style.
            bar.style.transform = `translateY(${centre - listBox.top - bar.offsetHeight / 2}px)`;
            bar.style.opacity = '1';
        },
        [rowEls]
    );

    /** L'interstice le plus proche : chaque bord de ligne est un candidat. */
    const gapAt = useCallback(
        (clientY: number): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (const [i, el] of rowEls().entries()) {
                const box = el.getBoundingClientRect();
                for (const [y, gap] of [
                    [box.top, i],
                    [box.bottom, i + 1]
                ]) {
                    const distance = Math.abs(clientY - y);
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = gap;
                    }
                }
            }
            return best;
        },
        [rowEls]
    );

    // Des `ref` pour que les écouteurs globaux ci-dessous appellent toujours les
    // dernières fonctions sans avoir à se réabonner à chaque rendu : ils ne sont
    // (dés)installés qu'une fois par glissé.
    const showBarRef = useRef(showBar);
    showBarRef.current = showBar;
    const gapAtRef = useRef(gapAt);
    gapAtRef.current = gapAt;
    const reposRef = useRef(repos);
    reposRef.current = repos;
    const onReorderRef = useRef(onReorder);
    onReorderRef.current = onReorder;

    const endDrag = useCallback(() => {
        window.removeEventListener('pointermove', handleWindowPointerMove);
        window.removeEventListener('pointerup', handleWindowPointerUp);
        window.removeEventListener('pointercancel', handleWindowPointerCancel);
        window.removeEventListener('blur', handleWindowBlur);
        window.removeEventListener('keydown', handleWindowKeyDown);
        hideBar();
        document.body.style.removeProperty('cursor');
        document.body.style.removeProperty('user-select');
        pressRef.current = null;
        if (draggedRef.current !== null) {
            draggedRef.current = null;
            setDraggedId(null);
            onDragStateChange(false);
        }
    }, [hideBar, onDragStateChange]);

    function handleWindowPointerMove(e: PointerEvent) {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;

        if (draggedRef.current === null) {
            // Sous le seuil : ce peut encore n'être qu'un clic.
            if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD) return;
            draggedRef.current = press.id;
            setDraggedId(press.id);
            onDragStateChange(true);
            document.body.style.cursor = 'grabbing';
            document.body.style.userSelect = 'none';
        }
        showBarRef.current(gapAtRef.current(e.clientY));
    }

    function handleWindowPointerUp(e: PointerEvent) {
        const press = pressRef.current;
        if (!press || e.pointerId !== press.pointerId) return;
        const dragged = draggedRef.current;
        const gap = gapRef.current;
        endDrag();
        if (dragged !== null && gap !== null) {
            const ids = reordered(reposRef.current, dragged, gap);
            if (ids) onReorderRef.current(ids);
        }
    }

    function handleWindowPointerCancel(e: PointerEvent) {
        if (pressRef.current?.pointerId !== e.pointerId) return;
        endDrag();
    }

    function handleWindowBlur() {
        // Un glissé quitté en plein geste (alt-tab, dialogue natif) ne doit pas
        // rester en suspens.
        endDrag();
    }

    function handleWindowKeyDown(e: KeyboardEvent) {
        if (e.key === 'Escape') endDrag();
    }

    // Ceinture et bretelles : tout relâcher si le composant disparaît en plein
    // geste (la popup de la feature qui se ferme, par exemple).
    useEffect(() => endDrag, [endDrag]);

    function handlePointerDown(e: React.PointerEvent, repoId: number) {
        // Bouton principal / premier contact seulement. Rien d'autre à filtrer :
        // c'est câblé sur la poignée seule.
        if (e.button !== 0) return;
        pressRef.current = { id: repoId, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
        window.addEventListener('pointermove', handleWindowPointerMove);
        window.addEventListener('pointerup', handleWindowPointerUp);
        window.addEventListener('pointercancel', handleWindowPointerCancel);
        window.addEventListener('blur', handleWindowBlur);
        window.addEventListener('keydown', handleWindowKeyDown);
    }

    return (
        <ul ref={listRef} className={styles.repoGrid}>
            {repos.map((repo) => (
                <RepoCard
                    key={repo.id}
                    repo={repo}
                    sync={syncing.get(repo.id) ?? null}
                    outline={outlineFor(`repo:${repo.id}`)}
                    dragging={draggedId === repo.id}
                    onOpen={() => onOpen(repo.id)}
                    onDragPointerDown={canWrite ? (e) => handlePointerDown(e, repo.id) : undefined}
                />
            ))}
            {/* Un `<li>` et non un `<span>` : dans une `<ul>`, seul un `<li>` est
                un enfant valide. Sorti du flux par `position: absolute`, il
                n'occupe aucune cellule de la grille. */}
            <li ref={barRef} className={styles.dropBar} aria-hidden='true' />
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
