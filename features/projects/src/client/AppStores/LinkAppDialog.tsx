import { useEffect, useState } from 'react';
import { APPSTORES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { AppStoresClientProvider, AppStoresLinkedCandidate } from '@deveye/types/sdk/client';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    moduleClientProvider,
    SearchSelect,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkAppDialogProps {
    open: boolean;
    projectId: number;
    /** Les apps déjà reliées : elles sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter une app au projet : en choisir une de l'espace, ou en suivre une
 * nouvelle par le dialogue de la feature (`AppDialog`, par le contrat client
 * des Stores). Module absent, rien n'est proposé.
 */
export function LinkAppDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkAppDialogProps) {
    const provider = moduleClientProvider<AppStoresClientProvider>(APPSTORES_CLIENT_PROVIDER);
    const [apps, setApps] = useState<readonly AppStoresLinkedCandidate[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    /** Le dialogue de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!provider) return;
        void (async () => {
            try {
                setApps(await provider.listApps());
            } catch (e) {
                setError(errorNote(e, 'Impossible de charger les apps de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = apps.filter((a) => !linkedIds.includes(a.id));

    const link = async (appId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.appstoresLink', { projectId, appId });
            onSaved();
        } catch (e) {
            setError(errorNote(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open && !createOpen}
                onClose={onClose}
                title='Ajouter une app au projet'
                width={560}
                onSubmit={() => picked !== '' && void link(Number(picked))}
                footer={
                    <>
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void link(Number(picked))} disabled={busy || picked === ''}>
                            {busy ? 'Enregistrement…' : 'Relier'}
                        </Button>
                    </>
                }
            >
                <div className={styles.form}>
                    {!provider ? (
                        <p className={styles.hint}>Le module Stores n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>App de l’espace</span>
                                <SearchSelect
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={setPicked}
                                    options={free.map((app) => ({
                                        value: String(app.id),
                                        label: `${app.name}${app.foreign ? ' (partagée)' : ''}`
                                    }))}
                                    placeholder={
                                        free.length === 0
                                            ? apps.length === 0
                                                ? 'Aucune app n’est encore suivie dans cet espace'
                                                : 'Toutes les apps de l’espace sont déjà reliées'
                                            : 'Choisir une app…'
                                    }
                                    aria-label='App de l’espace'
                                />
                                <span className={styles.hint}>
                                    Une app peut servir plusieurs projets : en choisir une déjà reliée ailleurs ne la
                                    retire à personne.
                                </span>
                            </label>

                            <div className={styles.actions}>
                                <Button
                                    variant='secondary'
                                    icon='add'
                                    onClick={() => setCreateOpen(true)}
                                    disabled={busy}
                                >
                                    Suivre une app
                                </Button>
                                <span className={styles.hint}>
                                    Elle rejoindra la feature « Stores », où vous lirez ses chiffres et ses avis, et
                                    sera reliée à ce projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    <ErrorNote note={error} />
                </div>
            </Dialog>

            {/* Ce qu'il suit est relié dans la foulée. */}
            {provider && (
                <provider.AppDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(appId) => {
                        setCreateOpen(false);
                        void link(appId);
                    }}
                />
            )}
        </>
    );
}

export default LinkAppDialog;
