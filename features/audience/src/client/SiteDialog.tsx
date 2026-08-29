import { useEffect, useState } from 'react';
import { Button, Dialog, humanizeError, invalidate, SegmentedControl, TextInput } from 'deveye-sdk-client';
import {
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    audiencePlatformSchema,
    type AudiencePlatform,
    type AudienceSite
} from '../contracts/domain';

import { api } from './api';
import { PLATFORM_HINTS, PLATFORM_LABELS } from './format';
import styles from './style.module.css';

interface SiteDialogProps {
    open: boolean;
    /** `null` = création. */
    site: AudienceSite | null;
    onClose: () => void;
    onSaved: (site: AudienceSite) => void;
    onRemoved?: () => void;
}

/** Les trois plateformes, dans l'ordre du contrat : un choix fixe, toutes visibles. */
const PLATFORM_OPTIONS = audiencePlatformSchema.options.map((value) => ({ value, label: PLATFORM_LABELS[value] }));

/**
 * Déclarer ou renommer un site suivi : son identité.
 *
 * Quatre champs, et un seul demande à être expliqué : la plateforme, parce
 * qu'elle décide si les origines autorisées sont appliquées. Une phrase d'aide
 * sous chaque champ finirait par n'être lue nulle part.
 *
 * La mesure, la reconnaissance des visiteurs et la conservation se règlent dans
 * le panneau Général ; le contrat prenant le site entier, on envoie ici leurs
 * défauts à la création et les valeurs du site chargé à la modification.
 *
 * La suppression vit ici et non sur la carte : on supprime un site une fois
 * dans sa vie, et le geste emporte tout son historique.
 */
export function SiteDialog({ open, site, onClose, onSaved, onRemoved }: SiteDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [platform, setPlatform] = useState<AudiencePlatform>('web');
    const [origins, setOrigins] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(site?.name ?? '');
        setDescription(site?.description ?? '');
        setPlatform(site?.platform ?? 'web');
        setOrigins(site?.origins.join('\n') ?? '');
        setError(null);
        setConfirmRemove(false);
    }, [open, site]);

    const submit = async () => {
        if (name.trim().length === 0) {
            setError('Donnez un nom à ce site.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const body = {
                name: name.trim(),
                description: description.trim(),
                platform,
                // Une ligne par origine à la saisie ; le serveur normalise et dédoublonne,
                // donc on lui envoie tel quel plutôt que de reproduire sa règle ici.
                origins: origins
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                // Le contrat prend le site entier ; ce qui n'est pas de l'identité vient
                // du site chargé (ou de ses défauts à la création) et repart tel quel.
                visitorMode: site?.visitorMode ?? 'anonymous',
                active: site?.active ?? true,
                retentionDays: site?.retentionDays ?? AUDIENCE_RETENTION_DEFAULT_DAYS
            };
            const res = site
                ? await api.send('audience.siteUpdate', { siteId: site.id, ...body })
                : await api.send('audience.siteAdd', body);
            invalidate('audience.count');
            invalidate('audience.list');
            onSaved(res.site);
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!site) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('audience.siteRemove', { siteId: site.id });
            invalidate('audience.count');
            invalidate('audience.list');
            onRemoved?.();
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={site ? 'Modifier le site' : 'Suivre un nouveau site'}
            width={560}
            onSubmit={confirmRemove ? () => void remove() : () => void submit()}
            footer={
                confirmRemove ? (
                    <>
                        <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            {busy ? 'Suppression…' : 'Supprimer définitivement'}
                        </Button>
                    </>
                ) : (
                    <>
                        {site && onRemoved && (
                            <Button variant='ghost' onClick={() => setConfirmRemove(true)} disabled={busy}>
                                Supprimer
                            </Button>
                        )}
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void submit()} disabled={busy}>
                            {busy ? 'Enregistrement…' : site ? 'Enregistrer' : 'Créer'}
                        </Button>
                    </>
                )
            }
        >
            {confirmRemove ? (
                <p className={styles.confirm}>
                    Supprimer « {site?.name} » efface aussi <strong>tout son historique de mesures</strong>. Les projets
                    qui le suivent perdent seulement leur lien. Cette action est définitive.
                </p>
            ) : (
                <div className={styles.form}>
                    <label className={styles.field}>
                        <span className={styles.label}>Nom</span>
                        <TextInput
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            maxLength={AUDIENCE_SITE_NAME_MAX_LENGTH}
                            placeholder='Vitrine, Application, Blog…'
                        />
                    </label>

                    <label className={styles.field}>
                        <span className={styles.label}>Description</span>
                        <TextInput
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                            placeholder='Facultatif'
                        />
                    </label>

                    {/* Trois choix fixes, tous visibles : un déroulant cacherait derrière
                        un clic la seule décision qui change ce que le serveur accepte. */}
                    <div className={styles.field}>
                        <span className={styles.label}>Plateforme</span>
                        <SegmentedControl
                            value={platform}
                            options={PLATFORM_OPTIONS}
                            onChange={setPlatform}
                            aria-label='Plateforme'
                        />
                        <span className={styles.hint}>{PLATFORM_HINTS[platform]}</span>
                    </div>

                    <label className={styles.field}>
                        <span className={styles.label}>Origines autorisées</span>
                        <textarea
                            className={styles.textarea}
                            value={origins}
                            rows={3}
                            onChange={(e) => setOrigins(e.target.value)}
                            placeholder={'exemple.fr\nwww.exemple.fr'}
                        />
                        <span className={styles.hint}>
                            Un hôte par ligne. {origins.trim().length === 0 && 'Vide, toute origine est acceptée — '}
                            le port et le protocole sont ignorés.
                        </span>
                    </label>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}

export default SiteDialog;
