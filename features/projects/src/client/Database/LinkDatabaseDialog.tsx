import { useEffect, useState } from 'react';
import { DATABASE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DatabaseClientProvider, DatabaseLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog, humanizeError, moduleClientProvider, SelectInput } from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkDatabaseDialogProps {
    open: boolean;
    projectId: number;
    /** Les bases déjà reliées : elles sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter une base au projet : en choisir une de l'espace, ou en créer une.
 * La création ouvre le dialogue de la feature (`DatabaseDialog`, par le
 * contrat client du module) plutôt qu'une copie réduite, qui divergerait au
 * premier réglage ajouté ; module absent, rien n'est proposé. Rien n'est
 * exclusif : une base utilisée ailleurs peut être choisie ici.
 */
export function LinkDatabaseDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkDatabaseDialogProps) {
    const provider = moduleClientProvider<DatabaseClientProvider>(DATABASE_CLIENT_PROVIDER);
    const [databases, setDatabases] = useState<readonly DatabaseLinkedCandidate[]>([]);
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
                setDatabases(await provider.listDatabases());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les bases de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = databases.filter((d) => !linkedIds.includes(d.id));

    const link = async (databaseId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.databaseLink', { projectId, databaseId });
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
                title='Ajouter une base au projet'
                width={560}
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
                        <p className={styles.hint}>Le module Bases de données n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>Base de l’espace</span>
                                <SelectInput
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={(e) => setPicked(e.target.value)}
                                >
                                    <option value=''>
                                        {free.length === 0 ? 'Aucune base à relier' : 'Choisir une base…'}
                                    </option>
                                    {free.map((d) => (
                                        <option key={d.id} value={d.id}>
                                            {d.name}
                                            {d.foreign && ' (partagée)'} — {d.engineLabel}
                                            {d.projectCount > 0 &&
                                                ` — ${d.projectCount} projet${d.projectCount > 1 ? 's' : ''}`}
                                        </option>
                                    ))}
                                </SelectInput>
                                <span className={styles.hint}>
                                    Une base peut servir plusieurs projets : en choisir une déjà utilisée ailleurs ne la
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
                                    Créer une base
                                </Button>
                                <span className={styles.hint}>
                                    Elle rejoindra la feature « Bases de données », où elle sera visible et réutilisable
                                    par d’autres projets — et sera reliée à ce projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il crée est relié
                immédiatement : sans cela, « Créer une base » depuis un projet
                laisserait l'utilisateur devant une liste où il faut la
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            {provider && (
                <provider.DatabaseDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(databaseId) => {
                        setCreateOpen(false);
                        void link(databaseId);
                    }}
                />
            )}
        </>
    );
}

export default LinkDatabaseDialog;
