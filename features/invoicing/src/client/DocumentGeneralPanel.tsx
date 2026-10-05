import { useCallback, useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    humanizeError,
    ReadOnlyNotice,
    settingsStyles as shell,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';

import type { InvoicingDoc } from '../contracts/domain';
import { api, refreshInvoicing } from './api';
import { openDocument } from './navigation';

/**
 * L'onglet Général d'un document : repartir de lui vers un brouillon neuf, puis
 * le ranger. Un document émis s'archive et ne se supprime pas, un brouillon se
 * supprime et ne s'archive pas.
 */
export default function DocumentGeneralPanel({ scope, canWrite, close, gone }: SettingsPanelProps) {
    const id = scope.kind === 'record' ? Number(scope.recordId) : null;
    const [doc, setDoc] = useState<InvoicingDoc | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    const load = useCallback(async () => {
        if (id === null) return;
        try {
            setDoc((await api.send('invoicing.doc', { id })).doc);
        } catch (e) {
            setError(humanizeError(e, 'Ce document n’a pas pu être lu.'));
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    if (doc === null) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const draft = doc.status === 'draft';

    const duplicate = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('invoicing.docDuplicate', { id: doc.id });
            refreshInvoicing();
            close();
            openDocument(res.doc.id);
        } catch (e) {
            setError(humanizeError(e, 'Le brouillon n’a pas pu être préparé.'));
        } finally {
            setBusy(false);
        }
    };

    const archive = async (archived: boolean) => {
        setBusy(true);
        setError(null);
        try {
            setDoc((await api.send('invoicing.docArchive', { id: doc.id, archived })).doc);
            refreshInvoicing();
        } catch (e) {
            setError(
                humanizeError(
                    e,
                    archived ? 'Ce document n’a pas pu être archivé.' : 'Ce document n’a pas pu être ressorti.'
                )
            );
        } finally {
            setBusy(false);
        }
    };

    const remove = () =>
        setConfirm({
            title: 'Supprimer ce brouillon ?',
            description:
                'Il disparaît pour de bon, avec ses lignes. Aucun numéro ne lui a été attribué : la suite de vos numéros reste sans trou.',
            confirmLabel: 'Supprimer',
            tone: 'danger',
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    try {
                        await api.send('invoicing.docRemove', { id: doc.id });
                        // `gone()` d'abord : ravivée avant de partir, la fiche
                        // irait chercher un document disparu.
                        gone();
                        refreshInvoicing();
                    } catch (e) {
                        setError(humanizeError(e, 'Ce brouillon n’a pas pu être supprimé.'));
                    } finally {
                        setBusy(false);
                        setConfirm(null);
                    }
                })();
            }
        });

    if (!canWrite) {
        return (
            <div className={shell.section}>
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de dupliquer, d’archiver ni de supprimer ce document : cela relève de
                    l’écriture sur Facturation.
                </ReadOnlyNotice>
            </div>
        );
    }

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.fieldLabel}>Repartir de ce document</span>
                <div>
                    <Button variant='secondary' icon='copy' disabled={busy} onClick={() => void duplicate()}>
                        Dupliquer en brouillon
                    </Button>
                </div>
                <span className={shell.fieldHint}>
                    Un brouillon neuf reprend son client, son objet et ses lignes, à corriger avant de l’émettre.
                    {draft
                        ? ' Celui-ci ne change pas.'
                        : ' Celui-ci reste tel qu’il a été émis : un document émis ne se reprend pas, et une facture se corrige par un avoir.'}
                </span>
            </div>

            {draft ? (
                <div className={shell.field}>
                    <span className={shell.fieldLabel}>Supprimer</span>
                    <div>
                        <Button variant='danger' icon='trash' disabled={busy} onClick={remove}>
                            Supprimer ce brouillon
                        </Button>
                    </div>
                    <span className={shell.fieldHint}>
                        Un brouillon n’a pas encore de numéro : il peut disparaître sans laisser de trou.
                    </span>
                </div>
            ) : (
                <div className={shell.field}>
                    <span className={shell.fieldLabel}>{doc.archived ? 'Archivé' : 'Archiver'}</span>
                    <div>
                        <Button
                            variant='secondary'
                            icon='archive'
                            disabled={busy}
                            onClick={() => void archive(!doc.archived)}
                        >
                            {doc.archived ? 'Ressortir des archives' : 'Archiver ce document'}
                        </Button>
                    </div>
                    <span className={shell.fieldHint}>
                        {doc.archived
                            ? 'Il n’apparaît plus sur l’accueil ni dans la liste des documents, et ses relances sont arrêtées. Le ressortir le remet à sa place.'
                            : 'Il quitte l’accueil et la liste des documents, et ses relances s’arrêtent. Il reste dans vos chiffres et dans l’onglet Archives des réglages de Facturation. Un document émis ne se supprime pas : vous devez le conserver.'}
                    </span>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
