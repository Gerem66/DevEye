import { useEffect, useMemo, useState } from 'react';
import type { ProjectCommitDetail, ProjectDiffFile } from 'deveye-types';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError, withSecrecy } from '../api';
import styles from '../style.module.css';

interface CommitDialogProps {
    open: boolean;
    projectId: number;
    /** Le commit demandé ; `null` ferme le dialogue. */
    sha: string | null;
    onClose: () => void;
}

/** Libellé court de l'état d'un fichier. */
const STATUS_LABELS: Record<ProjectDiffFile['status'], string> = {
    added: 'ajouté',
    modified: 'modifié',
    removed: 'supprimé',
    renamed: 'renommé',
    copied: 'copié',
    changed: 'modifié',
    unchanged: 'inchangé'
};

/**
 * Le détail d'un commit : son message, ses compteurs, et son diff.
 *
 * Le diff est lu **chez le fournisseur à l'ouverture**, jamais dans le cache
 * local : voir `projectCommitDetailSchema` pour la raison. C'est donc le seul
 * écran du module dont l'attente dépend d'une API tierce, et il l'annonce.
 *
 * Les fichiers sont repliés par défaut : un commit de fusion touche parfois cent
 * fichiers, et dérouler cent diffs pour en lire un serait absurde. Le premier
 * s'ouvre seul quand il n'y en a qu'un — le cas le plus fréquent.
 */
export function CommitDialog({ open, projectId, sha, onClose }: CommitDialogProps) {
    const [detail, setDetail] = useState<ProjectCommitDetail | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    /**
     * Les fichiers déjà ouverts au moins une fois.
     *
     * Un diff ne se monte qu'au premier dépliage — un commit de fusion en
     * touche parfois trois cents, et les rendre tous d'emblée coûterait cher
     * pour n'en lire qu'un. Mais il reste monté ensuite : sans ça, le repli
     * démonterait le contenu avant que l'animation n'ait le temps de jouer, et
     * la fermeture redeviendrait le à-coup qu'on cherche à supprimer.
     */
    const [mounted, setMounted] = useState<Set<string>>(new Set());

    useEffect(() => {
        if (!open || sha === null) {
            setDetail(null);
            setError(null);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        setDetail(null);
        void (async () => {
            try {
                const res = await withSecrecy(() => ws.send('project.commitDetail', { projectId, sha }));
                if (cancelled) return;
                setDetail(res.detail);
                // Un seul fichier : l'ouvrir, il n'y a rien à choisir.
                const first =
                    res.detail.files.length === 1 ? new Set([res.detail.files[0].filename]) : new Set<string>();
                setExpanded(first);
                setMounted(first);
            } catch (e) {
                if (!cancelled) setError(humanizeError(e, 'Le détail du commit n’a pas pu être lu.'));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        // Un commit chassé par un autre ne doit pas écraser le nouveau à son
        // retour : la réponse la plus lente gagnerait sinon la course.
        return () => {
            cancelled = true;
        };
    }, [open, projectId, sha]);

    const toggle = (filename: string) => {
        setMounted((prev) => (prev.has(filename) ? prev : new Set(prev).add(filename)));
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(filename)) next.delete(filename);
            else next.add(filename);
            return next;
        });
    };

    const title = detail ? firstLine(detail.message) : 'Commit';
    const body = detail ? detail.message.split('\n').slice(1).join('\n').trim() : '';

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={title}
            width={900}
            holdSecrecy
            footer={
                <>
                    {detail?.url && (
                        <a className={styles.externalLink} href={detail.url} target='_blank' rel='noreferrer'>
                            <span className='icon icon-branch' /> Voir sur GitHub
                        </a>
                    )}
                    <Button variant='secondary' onClick={onClose}>
                        Fermer
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {loading && <p className={styles.empty}>Lecture du diff chez GitHub…</p>}
                {error && <p className={styles.error}>{error}</p>}

                {detail && (
                    <>
                        <div className={styles.commitHead}>
                            <code className={styles.sha}>{detail.sha.slice(0, 10)}</code>
                            <span className={styles.hint}>
                                {detail.authorName || 'Auteur inconnu'}
                                {detail.committedAt > 0 &&
                                    ` · ${new Date(detail.committedAt * 1000).toLocaleString('fr-FR')}`}
                            </span>
                            <span className={styles.diffStat}>
                                <span className={styles.diffAdd}>+{detail.additions}</span>
                                <span className={styles.diffDel}>−{detail.deletions}</span>
                            </span>
                        </div>

                        {body && <pre className={styles.commitBody}>{body}</pre>}

                        {detail.truncated && (
                            <p className={styles.hint}>GitHub n’a rendu que les 300 premiers fichiers de ce commit.</p>
                        )}

                        {detail.files.length === 0 && (
                            <p className={styles.empty}>Ce commit ne touche aucun fichier.</p>
                        )}

                        <ul className={styles.diffList}>
                            {detail.files.map((file) => (
                                <li key={file.filename} className={styles.diffFile}>
                                    <button
                                        type='button'
                                        className={styles.diffFileHead}
                                        onClick={() => toggle(file.filename)}
                                        aria-expanded={expanded.has(file.filename)}
                                    >
                                        <span
                                            className={`icon icon-chevron ${styles.diffChevron} ${
                                                expanded.has(file.filename) ? styles.diffChevronOpen : ''
                                            }`}
                                        />
                                        <span className={styles.diffPath} data-status={file.status}>
                                            {file.previousFilename && (
                                                <span className={styles.diffOldPath}>{file.previousFilename} → </span>
                                            )}
                                            {file.filename}
                                        </span>
                                        <span className={styles.diffTag}>{STATUS_LABELS[file.status]}</span>
                                        <span className={styles.diffStat}>
                                            <span className={styles.diffAdd}>+{file.additions}</span>
                                            <span className={styles.diffDel}>−{file.deletions}</span>
                                        </span>
                                    </button>
                                    {/* Dépliage animé : la grille passe de `0fr` à
                                        `1fr`, ce qui interpole la hauteur réelle
                                        sans qu'on ait à la mesurer. */}
                                    <div
                                        className={`${styles.diffReveal} ${
                                            expanded.has(file.filename) ? styles.diffRevealOpen : ''
                                        }`}
                                    >
                                        <div className={styles.diffRevealInner}>
                                            {mounted.has(file.filename) && <Patch patch={file.patch} />}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </div>
        </Dialog>
    );
}

/**
 * Un diff unifié, colorisé ligne à ligne.
 *
 * Analyse volontairement minimale — le premier caractère suffit à classer une
 * ligne, et un vrai analyseur de patch n'apporterait rien de plus à l'écran.
 * `patch` absent n'est pas une panne : GitHub l'omet pour les binaires et les
 * fichiers trop gros, et le dire vaut mieux qu'afficher un vide inexpliqué.
 */
function Patch({ patch }: { patch: string | null }) {
    const lines = useMemo(() => (patch === null ? [] : patch.split('\n')), [patch]);

    if (patch === null) {
        return <p className={styles.diffNone}>Diff indisponible — fichier binaire ou trop volumineux.</p>;
    }

    return (
        <pre className={styles.diffBody}>
            {lines.map((line, i) => (
                <span key={i} className={lineClass(line)}>
                    {line || ' '}
                    {'\n'}
                </span>
            ))}
        </pre>
    );
}

function lineClass(line: string): string {
    // `+++` / `---` sont les en-têtes de fichier, pas des lignes ajoutées ou
    // retirées : les tester d'abord, sinon ils repartiraient en vert et rouge.
    if (line.startsWith('@@')) return styles.diffHunk;
    if (line.startsWith('+++') || line.startsWith('---')) return styles.diffMeta;
    if (line.startsWith('+')) return styles.diffLineAdd;
    if (line.startsWith('-')) return styles.diffLineDel;
    return styles.diffLine;
}

function firstLine(message: string): string {
    return message.split('\n')[0].trim() || '(sans message)';
}

export default CommitDialog;
