import { useEffect, useState } from 'react';
import type { UptimeService } from '@deveye/types';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { ServiceDialog } from '@/Features/Uptime/ServiceDialog';
import { humanizeError } from '../api';
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
 * déclarer un.
 *
 * **La déclaration passe par le vrai dialogue de la feature** (`ServiceDialog`),
 * pas par une copie réduite — même parti pris que `LinkTargetDialog` pour une
 * cible de déploiement. Surveiller une URL suppose des réglages (méthode,
 * seuils, notifications) qu'il faut régler une bonne fois ; en réécrire un
 * résumé ici garantirait qu'il diverge au premier réglage ajouté à Uptime.
 */
export function LinkUptimeDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkUptimeDialogProps) {
    const [services, setServices] = useState<UptimeService[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue de déclaration de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        void (async () => {
            try {
                const res = await ws.send('uptime.list', {});
                setServices(res.services);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les services de l’espace.'));
            }
        })();
    }, [open]);

    const free = services.filter((s) => !linkedIds.includes(s.id));

    const link = async (serviceId: number) => {
        setBusy(true);
        setError(null);
        try {
            await ws.send('project.uptimeLink', { projectId, serviceId });
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
                    {free.length === 0 ? (
                        <p className={styles.hint}>
                            {services.length === 0
                                ? 'Aucun service n’est encore surveillé dans cet espace.'
                                : 'Tous les services de l’espace sont déjà rattachés à ce projet.'}
                        </p>
                    ) : (
                        <label className={styles.field}>
                            <span className={styles.label}>Service de l’espace</span>
                            <SelectInput value={picked} onChange={(e) => setPicked(e.target.value)}>
                                <option value=''>Choisir…</option>
                                {free.map((service) => (
                                    <option key={service.id} value={service.id}>
                                        {service.name || `Service #${service.id}`}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                    )}

                    <Button variant='ghost' icon='add' onClick={() => setCreateOpen(true)}>
                        Ajouter un nouveau service
                    </Button>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il déclare est relié
                immédiatement : sans cela, « ajouter un service » depuis un
                projet laisserait l'utilisateur devant une liste où il faut le
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            <ServiceDialog
                open={createOpen}
                service={null}
                onClose={() => setCreateOpen(false)}
                onSaved={(service) => {
                    setCreateOpen(false);
                    void link(service.id);
                }}
            />
        </>
    );
}

export default LinkUptimeDialog;
