import { useCallback, useState } from 'react';
import { Button, humanizeError, settingsStyles as shell, useResource } from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import DocumentRow from './DocumentRow';
import { api, refreshInvoicing } from './api';
import { openDocument } from './navigation';
import styles from './style.module.css';

/**
 * Les documents archivés : sortis de l'accueil et de la liste, toujours comptés
 * dans les chiffres. On les ouvre d'ici, et on les ressort d'un geste.
 */

const PAGE = 50;

export default function ArchivesPanel({ canWrite, close }: SettingsPanelProps) {
    const [limit, setLimit] = useState(PAGE);
    const [busy, setBusy] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(
        async () =>
            api.send('invoicing.docList', {
                archived: true,
                kind: null,
                status: null,
                derived: null,
                clientId: null,
                year: null,
                search: '',
                limit,
                offset: 0
            }),
        [limit]
    );
    const { data, error: loadError } = useResource('invoicing.docList', load, 'Les archives n’ont pas pu être lues.', [
        limit
    ]);

    const restore = async (id: number) => {
        setBusy(id);
        setError(null);
        try {
            await api.send('invoicing.docArchive', { id, archived: false });
            refreshInvoicing();
        } catch (e) {
            setError(humanizeError(e, 'Ce document n’a pas pu être ressorti.'));
        } finally {
            setBusy(null);
        }
    };

    if (data === null) {
        return <p className={loadError ? shell.notice : shell.empty}>{loadError ?? 'Chargement…'}</p>;
    }

    if (data.docs.length === 0) {
        return (
            <div className={shell.section}>
                <p className={shell.sectionHint}>
                    Aucun document archivé. Un document émis s’archive depuis ses réglages : il quitte alors l’accueil
                    et la liste, et vient ici.
                </p>
            </div>
        );
    }

    return (
        <div className={shell.section}>
            <p className={shell.sectionHint}>
                Ils ne paraissent plus sur l’accueil ni dans la liste des documents, et leurs relances sont arrêtées.
                Ils restent dans vos chiffres.
            </p>

            <ul className={styles.rows}>
                {data.docs.map((doc) => (
                    <li key={doc.id} className={styles.archiveRow}>
                        <DocumentRow
                            doc={doc}
                            currency={doc.currency}
                            onOpen={() => {
                                close();
                                openDocument(doc.id);
                            }}
                        />
                        {canWrite && (
                            <Button
                                variant='ghost'
                                icon='archive'
                                disabled={busy !== null}
                                onClick={() => void restore(doc.id)}
                            >
                                Ressortir
                            </Button>
                        )}
                    </li>
                ))}
            </ul>

            {data.docs.length < data.totals.count && (
                <div className={styles.moreRow}>
                    <Button variant='secondary' onClick={() => setLimit((current) => current + PAGE)}>
                        Voir les {Math.min(PAGE, data.totals.count - data.docs.length)} suivants
                    </Button>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
