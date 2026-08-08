import { useEffect, useState } from 'react';
import type { Database } from 'deveye-types';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { DatabaseDialog } from '@/Features/Database/DatabaseDialog';
import { ENGINE_LABELS } from '@/Features/Database/format';
import { humanizeError } from '../api';
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
 *
 * **La création passe par le vrai dialogue de la feature** (`DatabaseDialog`),
 * pas par une copie réduite. Une base a une adresse, un compte, un tunnel et une
 * surveillance ; en réécrire un formulaire ici garantirait qu'il diverge au
 * premier réglage ajouté. Ce dialogue-ci ne fait que l'ouvrir, puis relier ce
 * qu'il a créé — c'est aussi ce que fait l'onglet Git avec `RepoPicker`.
 *
 * Rien n'est exclusif : une base déjà utilisée par un autre projet peut être
 * choisie ici sans lui être retirée.
 */
export function LinkDatabaseDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkDatabaseDialogProps) {
    const [databases, setDatabases] = useState<Database[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue de création de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        void (async () => {
            try {
                const res = await ws.send('database.list', {});
                setDatabases(res.databases);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les bases de l’espace.'));
            }
        })();
    }, [open]);

    const free = databases.filter((d) => !linkedIds.includes(d.id));

    const link = async (databaseId: number) => {
        setBusy(true);
        setError(null);
        try {
            await ws.send('project.databaseLink', { projectId, databaseId });
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
                    <label className={styles.field}>
                        <span className={styles.label}>Base de l’espace</span>
                        <SelectInput
                            value={picked}
                            disabled={free.length === 0}
                            onChange={(e) => setPicked(e.target.value)}
                        >
                            <option value=''>{free.length === 0 ? 'Aucune base à relier' : 'Choisir une base…'}</option>
                            {free.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name} — {ENGINE_LABELS[d.engine]}
                                    {d.projectCount > 0 &&
                                        ` — ${d.projectCount} projet${d.projectCount > 1 ? 's' : ''}`}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.hint}>
                            Une base peut servir plusieurs projets : en choisir une déjà utilisée ailleurs ne la retire
                            à personne.
                        </span>
                    </label>

                    <div className={styles.actions}>
                        <Button variant='secondary' icon='add' onClick={() => setCreateOpen(true)} disabled={busy}>
                            Créer une base
                        </Button>
                        <span className={styles.hint}>
                            Elle rejoindra la feature « Bases de données », où elle sera visible et réutilisable par
                            d’autres projets — et sera reliée à ce projet dans la foulée.
                        </span>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il crée est relié
                immédiatement : sans cela, « Créer une base » depuis un projet
                laisserait l'utilisateur devant une liste où il faut la
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            <DatabaseDialog
                open={createOpen}
                database={null}
                onClose={() => setCreateOpen(false)}
                onSaved={(databaseId) => {
                    setCreateOpen(false);
                    void link(databaseId);
                }}
            />
        </>
    );
}

export default LinkDatabaseDialog;
