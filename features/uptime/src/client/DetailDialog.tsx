import { useRef, useState } from 'react';
import { Dialog } from 'deveye-sdk-client';

import { parseDriftLine } from '../contracts/format';
import FileContentDialog from './FileContentDialog';
import styles from './style.module.css';

/** Ce qu'un incident ou une lecture des fichiers a à montrer, au-delà de sa ligne. */
export interface Detail {
    title: string;
    description: string;
    /** L'écart fichier par fichier, ou ce qui explique le constat. */
    lines: string[];
}

interface DetailDialogProps {
    serviceId: number;
    detail: Detail | null;
    onClose: () => void;
}

/** Un chemin d'écart, sa partie après « ? » en retrait : c'est le nom du fichier que l'œil cherche. */
function DriftPath({ path }: { path: string }) {
    const query = path.indexOf('?');
    if (query === -1) return <span className={styles.driftPath}>{path}</span>;
    return (
        <span className={styles.driftPath}>
            {path.slice(0, query)}
            <span className={styles.driftQuery}>{path.slice(query)}</span>
        </span>
    );
}

/**
 * Le détail d'une ligne de la fiche, dans un dialogue plutôt que déroulé sous
 * elle. Un fichier que le site sert encore se regarde depuis ici, lu par le
 * serveur : jamais par un lien, un site compromis choisirait ce qui s'exécute.
 */
export function DetailDialog({ serviceId, detail, onClose }: DetailDialogProps) {
    // Le dernier détail reste le temps de l'animation de sortie, sans quoi le
    // titre se viderait avant que le dialogue ne disparaisse.
    const shown = useRef<Detail | null>(detail);
    if (detail) shown.current = detail;
    const view = detail ?? shown.current;
    const [file, setFile] = useState<string | null>(null);

    return (
        <Dialog
            open={detail !== null}
            onClose={onClose}
            title={view?.title}
            description={view?.description}
            width={760}
        >
            {view && view.lines.length > 0 && (
                <ul className={styles.driftLines}>
                    {view.lines.map((line, i) => {
                        const parts = parseDriftLine(line);
                        if (!parts) {
                            return (
                                <li key={i}>
                                    <span className={styles.driftFree}>{line}</span>
                                </li>
                            );
                        }
                        return (
                            <li key={i}>
                                <span className={styles.driftLabel}>{parts.label}</span>
                                <DriftPath path={parts.path} />
                                {parts.served && (
                                    <button
                                        type='button'
                                        className={styles.detailLink}
                                        onClick={() => setFile(parts.path)}
                                    >
                                        Voir le contenu
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <FileContentDialog serviceId={serviceId} path={file} onClose={() => setFile(null)} />
        </Dialog>
    );
}

export default DetailDialog;
