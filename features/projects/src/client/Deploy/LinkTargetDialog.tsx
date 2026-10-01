import { useEffect, useState } from 'react';
import { DEPLOY_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DeployClientProvider, DeployLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog, humanizeError, moduleClientProvider, SearchSelect } from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkTargetDialogProps {
    open: boolean;
    projectId: number;
    /** Les cibles déjà reliées : elles sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter une cible de déploiement au projet : en choisir une de l'espace, ou
 * en déclarer une. La déclaration ouvre le dialogue de la feature
 * (`TargetDialog`, par le contrat client du module) plutôt qu'une copie
 * réduite, qui divergerait au premier réglage ajouté ; module absent, rien
 * n'est proposé. Rien n'est exclusif, et deux projets partageant une pile
 * compose sont le cas normal.
 */
export function LinkTargetDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkTargetDialogProps) {
    const provider = moduleClientProvider<DeployClientProvider>(DEPLOY_CLIENT_PROVIDER);
    const [targets, setTargets] = useState<readonly DeployLinkedCandidate[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue de déclaration de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!provider) return;
        void (async () => {
            try {
                setTargets(await provider.listTargets());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les cibles de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = targets.filter((t) => !linkedIds.includes(t.id));

    const link = async (targetId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.deployLink', { projectId, targetId });
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
                title='Ajouter une cible au projet'
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
                        <p className={styles.hint}>Le module Déploiements n’est pas installé.</p>
                    ) : (
                        <>
                            {free.length === 0 ? (
                                <p className={styles.hint}>
                                    {targets.length === 0
                                        ? 'Aucune cible n’est encore déclarée dans cet espace.'
                                        : 'Toutes les cibles de l’espace sont déjà reliées à ce projet.'}
                                </p>
                            ) : (
                                <label className={styles.field}>
                                    <span className={styles.label}>Cible de l’espace</span>
                                    <SearchSelect
                                        value={picked}
                                        onChange={setPicked}
                                        options={free.map((target) => ({
                                            value: String(target.id),
                                            label: `${target.name}${target.foreign ? ' (partagée)' : ''}`,
                                            detail: target.host
                                        }))}
                                        placeholder='Choisir…'
                                        aria-label='Cible de l’espace'
                                    />
                                    <span className={styles.hint}>
                                        Une cible peut servir plusieurs projets : en choisir une déjà utilisée ailleurs
                                        ne la retire à personne.
                                    </span>
                                </label>
                            )}

                            <Button variant='ghost' icon='add' onClick={() => setCreateOpen(true)}>
                                Déclarer une nouvelle cible
                            </Button>
                        </>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il déclare est relié
                immédiatement : sans cela, « déclarer une cible » depuis un projet
                laisserait l'utilisateur devant une liste où il faut la
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            {provider && (
                <provider.TargetDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(targetId) => {
                        setCreateOpen(false);
                        void link(targetId);
                    }}
                />
            )}
        </>
    );
}

export default LinkTargetDialog;
