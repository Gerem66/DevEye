import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Dialog, humanizeError } from 'deveye-sdk-client';
import type { GitCommit, GitCommitCursor } from '../contracts/domain';

import { api } from './api';
import { CommitRow } from './Rows';
import styles from './style.module.css';

/**
 * Le « voir tout » d'un panneau, en dialogue comme le détail d'une pull request :
 * une sous-page ne dirait pas qu'on a quitté la vue du dépôt.
 */

interface ListDialogProps {
    open: boolean;
    title: string;
    onClose: () => void;
    /** Les lignes, déjà rendues par l'appelant avec les mêmes `Rows`. */
    children: ReactNode;
}

export function ListDialog({ open, title, onClose, children }: ListDialogProps) {
    return (
        <Dialog open={open} onClose={onClose} title={title} width={760}>
            <div className={styles.listDialogBody}>{children}</div>
        </Dialog>
    );
}

const PAGE = 50;

interface CommitListDialogProps {
    open: boolean;
    repoId: number;
    onClose: () => void;
    onOpenCommit: (sha: string) => void;
}

/**
 * Tous les commits, paginés : le seul des quatre panneaux dont la liste complète
 * ne tient pas dans la réponse déjà chargée, les commits se comptant en milliers.
 */
export function CommitListDialog({ open, repoId, onClose, onOpenCommit }: CommitListDialogProps) {
    const [commits, setCommits] = useState<GitCommit[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** La sentinelle de bas de liste : la voir, c'est charger la suite. */
    const sentinelRef = useRef<HTMLDivElement | null>(null);

    /**
     * Le curseur de la page suivante. Une référence et non un état : le mettre
     * dans les dépendances de l'effet relancerait l'observateur en boucle.
     */
    const cursor = useRef<GitCommitCursor | null>(null);
    /** Une seule requête à la fois, quoi que dise l'observateur. */
    const loading = useRef(false);

    const load = useCallback(
        async (before: GitCommitCursor | null) => {
            if (loading.current) return;
            loading.current = true;
            setBusy(true);
            try {
                const res = await api.send('git.commitList', {
                    repoId,
                    limit: PAGE,
                    ...(before ? { before } : {})
                });
                setCommits((prev) => (before ? [...prev, ...res.commits] : res.commits));
                setHasMore(res.hasMore);
                const last = res.commits[res.commits.length - 1];
                cursor.current = last ? { committedAt: last.committedAt, id: last.id } : null;
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les commits.'));
                // Une erreur ne doit pas laisser l'observateur réessayer en
                // rafale sur le même curseur : on ferme le robinet.
                setHasMore(false);
            } finally {
                loading.current = false;
                setBusy(false);
            }
        },
        [repoId]
    );

    useEffect(() => {
        if (!open) return;
        // Repartir de zéro à chaque ouverture : la liste a pu changer entre-temps,
        // et garder l'ancienne pagination reprendrait un curseur périmé.
        setCommits([]);
        setHasMore(false);
        cursor.current = null;
        void load(null);
    }, [open, load]);

    /**
     * Le défilement infini : `IntersectionObserver` sur une sentinelle plutôt
     * qu'un écouteur de `scroll`, sans mesure de position à chaque pixel. La
     * marge anticipe l'arrivée pour que la page suivante soit là avant qu'on y soit.
     */
    useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!open || !hasMore || !sentinel) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) void load(cursor.current);
            },
            { root: sentinel.closest(`.${styles.listDialogBody}`), rootMargin: '200px' }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
        // `commits.length` re-arme l'observateur après chaque page : la
        // sentinelle a bougé, et elle peut être encore visible s'il reste de la
        // place à l'écran.
    }, [open, hasMore, load, commits.length]);

    return (
        <ListDialog open={open} title='Tous les commits' onClose={onClose}>
            {error && <p className={styles.error}>{error}</p>}
            <ul className={styles.gitList}>
                {commits.map((c) => (
                    <CommitRow key={c.id} commit={c} onOpen={onOpenCommit} />
                ))}
            </ul>
            {commits.length === 0 && !busy && <p className={styles.empty}>Aucun commit.</p>}

            {/* Toujours montée tant qu'il reste des pages : c'est elle que
                l'observateur surveille. */}
            {hasMore && (
                <div ref={sentinelRef} className={styles.listDialogFooter}>
                    <span className={styles.hint}>Chargement…</span>
                </div>
            )}
        </ListDialog>
    );
}

export default ListDialog;
