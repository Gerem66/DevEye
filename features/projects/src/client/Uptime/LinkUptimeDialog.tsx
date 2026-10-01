import { useEffect, useState } from 'react';
import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import { Button, Dialog, humanizeError, moduleClientProvider, SearchSelect } from 'deveye-sdk-client';
import { api } from '../api';
import styles from '../style.module.css';

interface LinkUptimeDialogProps {
    open: boolean;
    projectId: number;
    /** Les services déjà rattachés : ils sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Rattacher un service surveillé au projet : en choisir un de l'espace, ou en
 * déclarer un. La déclaration ouvre le dialogue de la feature (`ServiceDialog`,
 * par le contrat client d'Uptime) plutôt qu'un résumé de ses réglages, qui
 * divergerait au premier ajouté ; module absent, rien n'est proposé.
 */
export function LinkUptimeDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkUptimeDialogProps) {
    const uptime = moduleClientProvider<UptimeClientProvider>(UPTIME_CLIENT_PROVIDER);
    const [services, setServices] = useState<readonly UptimeLinkedService[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue de déclaration de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!uptime) return;
        void (async () => {
            try {
                setServices(await uptime.listServices());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les services de l’espace.'));
            }
        })();
    }, [open, uptime]);

    const free = services.filter((s) => !linkedIds.includes(s.id));

    const link = async (serviceId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.uptimeLink', { projectId, serviceId });
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
                title='Ajouter un uptime au projet'
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
                    {!uptime ? (
                        <p className={styles.hint}>Le module Uptime n’est pas installé.</p>
                    ) : free.length === 0 ? (
                        <p className={styles.hint}>
                            {services.length === 0
                                ? 'Aucun service n’est encore surveillé dans cet espace.'
                                : 'Tous les services de l’espace sont déjà rattachés à ce projet.'}
                        </p>
                    ) : (
                        <label className={styles.field}>
                            <span className={styles.label}>Service de l’espace</span>
                            <SearchSelect
                                value={picked}
                                onChange={setPicked}
                                options={free.map((service) => ({
                                    value: String(service.id),
                                    label: `${service.name || `Service #${service.id}`}${service.foreign ? ' (partagé)' : ''}`
                                }))}
                                placeholder='Choisir…'
                                aria-label='Service de l’espace'
                            />
                        </label>
                    )}

                    {uptime && (
                        <Button variant='ghost' icon='add' onClick={() => setCreateOpen(true)}>
                            Ajouter un nouveau service
                        </Button>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il déclare est relié
                immédiatement : sans cela, « ajouter un service » depuis un
                projet laisserait l'utilisateur devant une liste où il faut le
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            {uptime && (
                <uptime.ServiceDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(service) => {
                        setCreateOpen(false);
                        void link(service.id);
                    }}
                />
            )}
        </>
    );
}

export default LinkUptimeDialog;
