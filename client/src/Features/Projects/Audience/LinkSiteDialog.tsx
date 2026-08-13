import { useEffect, useState } from 'react';
import type { AudienceSite } from 'deveye-types';

import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { SiteDialog } from '@/Features/Audience/SiteDialog';
import { humanizeError } from '../api';
import styles from '../style.module.css';

interface LinkSiteDialogProps {
    open: boolean;
    projectId: number;
    /** Les sites déjà reliés : ils sortent de la liste des choix possibles. */
    linkedIds: number[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Ajouter un site suivi au projet : en choisir un de l'espace, ou en créer un.
 *
 * **La création passe par le vrai dialogue de la feature** (`SiteDialog`), pas
 * par une copie réduite — même parti pris que `LinkDatabaseDialog` et que
 * `RepoPicker` de l'onglet Git. Un site a une plateforme, des origines
 * autorisées et une rétention ; en réécrire un formulaire ici garantirait qu'il
 * diverge au premier réglage ajouté.
 *
 * Rien n'est exclusif : un site déjà suivi par un autre projet peut être choisi
 * ici sans lui être retiré.
 */
export function LinkSiteDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkSiteDialogProps) {
    const [sites, setSites] = useState<AudienceSite[]>([]);
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
                const res = await ws.send('audience.list', {});
                setSites(res.sites);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les sites de l’espace.'));
            }
        })();
    }, [open]);

    const free = sites.filter((s) => !linkedIds.includes(s.id));

    const link = async (siteId: number) => {
        setBusy(true);
        setError(null);
        try {
            await ws.send('project.audienceLink', { projectId, siteId });
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
                title='Ajouter un site au projet'
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
                            {sites.length === 0
                                ? 'Aucun site n’est encore déclaré dans cet espace.'
                                : 'Tous les sites de l’espace sont déjà reliés à ce projet.'}
                        </p>
                    ) : (
                        <label className={styles.field}>
                            <span className={styles.label}>Site de l’espace</span>
                            <SelectInput value={picked} onChange={(e) => setPicked(e.target.value)}>
                                <option value=''>Choisir…</option>
                                {free.map((site) => (
                                    <option key={site.id} value={site.id}>
                                        {site.name}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                    )}

                    <Button variant='ghost' icon='add' onClick={() => setCreateOpen(true)}>
                        Déclarer un nouveau site
                    </Button>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            <SiteDialog
                open={createOpen}
                site={null}
                onClose={() => setCreateOpen(false)}
                onSaved={(site) => {
                    setCreateOpen(false);
                    // Créé depuis un projet, on le relie dans la foulée : sans
                    // cela on retomberait sur le sélecteur avec un site de plus
                    // à choisir à la main, ce qui n'est le geste de personne.
                    void link(site.id);
                }}
            />
        </>
    );
}

export default LinkSiteDialog;
