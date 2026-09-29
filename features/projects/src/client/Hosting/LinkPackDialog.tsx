import { useEffect, useState } from 'react';
import { HOSTING_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { HostingClientProvider, HostingLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog, humanizeError, moduleClientProvider, SelectInput } from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkPackDialogProps {
    open: boolean;
    projectId: number;
    /** Les dossiers déjà reliés : ils sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter un dossier au projet : en choisir un de l'espace, ou en créer un par
 * le dialogue de la feature (`PackDialog`, par le contrat client
 * d'Hébergement). Module absent, rien n'est proposé.
 */
export function LinkPackDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkPackDialogProps) {
    const provider = moduleClientProvider<HostingClientProvider>(HOSTING_CLIENT_PROVIDER);
    const [packs, setPacks] = useState<readonly HostingLinkedCandidate[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue de création de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!provider) return;
        void (async () => {
            try {
                setPacks(await provider.listPacks());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les dossiers de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = packs.filter((p) => !linkedIds.includes(p.id));

    const link = async (packId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.hostingLink', { projectId, packId });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open && !createOpen}
                onClose={onClose}
                title='Ajouter un dossier au projet'
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
                        <p className={styles.hint}>Le module Hébergement n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>Dossier de l’espace</span>
                                <SelectInput
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={(e) => setPicked(e.target.value)}
                                >
                                    <option value=''>
                                        {free.length === 0
                                            ? packs.length === 0
                                                ? 'Aucun dossier n’existe encore dans cet espace'
                                                : 'Tous les dossiers de l’espace sont déjà reliés'
                                            : 'Choisir un dossier…'}
                                    </option>
                                    {free.map((pack) => (
                                        <option key={pack.id} value={pack.id}>
                                            {pack.name}
                                            {pack.foreign && ' (partagé)'}
                                        </option>
                                    ))}
                                </SelectInput>
                                <span className={styles.hint}>
                                    Un dossier peut servir plusieurs projets : en choisir un déjà relié ailleurs ne le
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
                                    Créer un dossier
                                </Button>
                                <span className={styles.hint}>
                                    Il rejoindra la feature « Hébergement », où vous y déposerez vos fichiers, et sera
                                    relié à ce projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Ce qu'il crée est relié dans la foulée. */}
            {provider && (
                <provider.PackDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(packId) => {
                        setCreateOpen(false);
                        void link(packId);
                    }}
                />
            )}
        </>
    );
}

export default LinkPackDialog;
