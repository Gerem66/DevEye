import { useEffect, useState } from 'react';
import { AUDIENCE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { AudienceClientProvider, AudienceLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog, humanizeError, moduleClientProvider, SelectInput } from 'deveye-sdk-client';
import { api } from '../api';
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
 * **La création passe par le vrai dialogue de la feature** (`SiteDialog`, lu
 * par le contrat client du module Audience), pas par une copie réduite. Même
 * parti pris que `LinkDatabaseDialog` et que `RepoPicker` de l'onglet Git : un
 * site a une plateforme et des origines autorisées, et en réécrire un
 * formulaire ici garantirait qu'il diverge au premier réglage ajouté. Ce
 * dialogue-ci ne fait que l'ouvrir, puis relier ce qu'il a créé. Module absent,
 * le dialogue le dit et ne propose rien.
 *
 * Rien n'est exclusif : un site déjà suivi par un autre projet peut être choisi
 * ici sans lui être retiré.
 */
export function LinkSiteDialog({ open, projectId, linkedIds, onClose, onSaved }: LinkSiteDialogProps) {
    const provider = moduleClientProvider<AudienceClientProvider>(AUDIENCE_CLIENT_PROVIDER);
    const [sites, setSites] = useState<readonly AudienceLinkedCandidate[]>([]);
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
                setSites(await provider.listSites());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les sites de l’espace.'));
            }
        })();
    }, [open, provider]);

    const free = sites.filter((s) => !linkedIds.includes(s.id));

    const link = async (siteId: number) => {
        setBusy(true);
        setError(null);
        try {
            await api.send('projects.audienceLink', { projectId, siteId });
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
                    {!provider ? (
                        <p className={styles.hint}>Le module Audience n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>Site de l’espace</span>
                                <SelectInput
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={(e) => setPicked(e.target.value)}
                                >
                                    <option value=''>
                                        {free.length === 0
                                            ? sites.length === 0
                                                ? 'Aucun site n’est encore déclaré dans cet espace'
                                                : 'Tous les sites de l’espace sont déjà reliés'
                                            : 'Choisir un site…'}
                                    </option>
                                    {free.map((site) => (
                                        <option key={site.id} value={site.id}>
                                            {site.name}
                                        </option>
                                    ))}
                                </SelectInput>
                                <span className={styles.hint}>
                                    Un site peut servir plusieurs projets : en choisir un déjà suivi ailleurs ne le
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
                                    Créer un site
                                </Button>
                                <span className={styles.hint}>
                                    Il rejoindra la feature « Audience », où il sera visible et réutilisable par
                                    d’autres projets, et sera relié à ce projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il crée est relié
                immédiatement : sans cela, « Créer un site » depuis un projet
                laisserait l'utilisateur devant un sélecteur avec un site de
                plus à choisir à la main, ce qui n'est le geste de personne. */}
            {provider && (
                <provider.SiteDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(siteId) => {
                        setCreateOpen(false);
                        void link(siteId);
                    }}
                />
            )}
        </>
    );
}

export default LinkSiteDialog;
