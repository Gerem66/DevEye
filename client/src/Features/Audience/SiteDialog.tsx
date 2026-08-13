import { useEffect, useState } from 'react';
import {
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_RETENTION_MAX_DAYS,
    AUDIENCE_RETENTION_MIN_DAYS,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    audiencePlatformSchema,
    audienceVisitorModeSchema,
    type AudiencePlatform,
    type AudienceSite,
    type AudienceVisitorMode
} from 'deveye-types';

import { Button, Dialog, SelectInput, Switch, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate } from '@/stores/invalidation';
import { humanizeError } from '../Projects/api';
import { PLATFORM_HINTS, PLATFORM_LABELS, VISITOR_HINTS, VISITOR_LABELS } from './format';
import styles from './style.module.css';

interface SiteDialogProps {
    open: boolean;
    /** `null` = création. */
    site: AudienceSite | null;
    onClose: () => void;
    onSaved: (site: AudienceSite) => void;
    onRemoved?: () => void;
}

/**
 * Déclarer ou régler un site suivi.
 *
 * Cinq réglages, et un seul demande à être expliqué : la **plateforme**, parce
 * qu'elle décide si les origines autorisées sont appliquées. Les autres se
 * lisent seuls, d'où l'absence de texte d'aide ailleurs — une phrase sous chaque
 * champ finit par ne plus être lue nulle part.
 *
 * La suppression vit ici, et non sur la carte : on supprime un site une fois
 * dans sa vie, et le geste emporte tout son historique. Ce n'est pas ce qui
 * mérite d'être le plus accessible de l'écran — même arbitrage que « Archiver »
 * dans « Modifier le projet ».
 */
export function SiteDialog({ open, site, onClose, onSaved, onRemoved }: SiteDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [platform, setPlatform] = useState<AudiencePlatform>('web');
    const [visitorMode, setVisitorMode] = useState<AudienceVisitorMode>('anonymous');
    const [origins, setOrigins] = useState('');
    const [active, setActive] = useState(true);
    const [retentionDays, setRetentionDays] = useState(AUDIENCE_RETENTION_DEFAULT_DAYS);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setName(site?.name ?? '');
        setDescription(site?.description ?? '');
        setPlatform(site?.platform ?? 'web');
        setVisitorMode(site?.visitorMode ?? 'anonymous');
        setOrigins(site?.origins.join('\n') ?? '');
        setActive(site?.active ?? true);
        setRetentionDays(site?.retentionDays ?? AUDIENCE_RETENTION_DEFAULT_DAYS);
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
                visitorMode,
                // Une ligne par origine à la saisie ; le serveur normalise et
                // dédoublonne, donc on lui envoie tel quel plutôt que de
                // reproduire ici une règle qui vit déjà là-bas.
                origins: origins
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                active,
                retentionDays
            };
            const res = site
                ? await ws.send('audience.siteUpdate', { siteId: site.id, ...body })
                : await ws.send('audience.siteAdd', body);
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
            await ws.send('audience.siteRemove', { siteId: site.id });
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

                    <label className={styles.field}>
                        <span className={styles.label}>Plateforme</span>
                        <SelectInput value={platform} onChange={(e) => setPlatform(e.target.value as AudiencePlatform)}>
                            {audiencePlatformSchema.options.map((value) => (
                                <option key={value} value={value}>
                                    {PLATFORM_LABELS[value]}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.hint}>{PLATFORM_HINTS[platform]}</span>
                    </label>

                    <label className={styles.field}>
                        <span className={styles.label}>Reconnaissance des visiteurs</span>
                        <SelectInput
                            value={visitorMode}
                            onChange={(e) => setVisitorMode(e.target.value as AudienceVisitorMode)}
                        >
                            {audienceVisitorModeSchema.options.map((value) => (
                                <option key={value} value={value}>
                                    {VISITOR_LABELS[value]}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={visitorMode === 'persistent' ? styles.hintWarn : styles.hint}>
                            {VISITOR_HINTS[visitorMode]}
                        </span>
                    </label>

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

                    <div className={styles.row}>
                        <label className={styles.field}>
                            <span className={styles.label}>Conservation (jours)</span>
                            <TextInput
                                type='number'
                                value={String(retentionDays)}
                                onChange={(e) =>
                                    setRetentionDays(Number(e.target.value) || AUDIENCE_RETENTION_DEFAULT_DAYS)
                                }
                                min={AUDIENCE_RETENTION_MIN_DAYS}
                                max={AUDIENCE_RETENTION_MAX_DAYS}
                            />
                            <span className={styles.hint}>
                                Le détail expire ; les totaux par jour sont gardés pour toujours.
                            </span>
                        </label>

                        {/* Même rythme que la colonne voisine — intitulé,
                            contrôle, explication — pour que les trois lignes
                            s'alignent d'une colonne à l'autre. Laisser `Switch`
                            porter son propre libellé décalait tout d'un cran. */}
                        <div className={styles.field}>
                            <span className={styles.label}>Mesure</span>
                            <div className={styles.switchBox}>
                                <Switch checked={active} onChange={setActive} label='Active' />
                            </div>
                            <span className={styles.hint}>
                                Éteinte, plus rien n’entre. L’historique déjà là ne bouge pas.
                            </span>
                        </div>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            )}
        </Dialog>
    );
}

export default SiteDialog;
