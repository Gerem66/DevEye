import { useEffect, useState } from 'react';
import { Button, Dialog, humanizeError, invalidate, SegmentedControl, TextInput } from 'deveye-sdk-client';
import {
    AUDIENCE_EVENT_IP_QUOTA_DEFAULT,
    AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
    AUDIENCE_RETENTION_DEFAULT_DAYS,
    AUDIENCE_SITE_NAME_MAX_LENGTH,
    AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
    audiencePlatformSchema,
    type AudiencePlatform,
    type AudienceSite
} from '../contracts/domain';

import { api } from './api';
import { PLATFORM_HINTS, PLATFORM_LABELS } from './format';
import styles from './style.module.css';

interface SiteDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (site: AudienceSite) => void;
}

/** Les trois plateformes, dans l'ordre du contrat : un choix fixe, toutes visibles. */
const PLATFORM_OPTIONS = audiencePlatformSchema.options.map((value) => ({ value, label: PLATFORM_LABELS[value] }));

/**
 * Déclarer un site suivi : son identité. Rien d'autre : une fois déclaré, un
 * site se règle dans l'onglet Général de sa fiche, comme tout élément.
 *
 * Quatre champs, et un seul demande à être expliqué : la plateforme, parce
 * qu'elle décide si les origines autorisées sont appliquées. Une phrase d'aide
 * sous chaque champ finirait par n'être lue nulle part.
 *
 * Le contrat prenant le site entier, la mesure, la reconnaissance des visiteurs
 * et la conservation partent ici à leurs défauts.
 */
export function SiteDialog({ open, onClose, onSaved }: SiteDialogProps) {
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [platform, setPlatform] = useState<AudiencePlatform>('web');
    const [origins, setOrigins] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setName('');
        setDescription('');
        setPlatform('web');
        setOrigins('');
        setError(null);
    }, [open]);

    const submit = async () => {
        if (name.trim().length === 0) {
            setError('Donnez un nom à ce site.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('audience.siteAdd', {
                name: name.trim(),
                description: description.trim(),
                platform,
                // Une ligne par origine à la saisie ; le serveur normalise et dédoublonne,
                // donc on lui envoie tel quel plutôt que de reproduire sa règle ici.
                origins: origins
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0),
                visitorMode: 'anonymous',
                transitPaths: [],
                active: true,
                // Les défauts prudents : aucun formulaire ne naît d'une réception,
                // et les quotas bornent d'emblée. Tout se règle ensuite, onglet par
                // onglet, sur un site qui existe.
                formsAuto: false,
                submissionIpQuota: AUDIENCE_SUBMISSION_IP_QUOTA_DEFAULT,
                formHourlyQuota: AUDIENCE_FORM_HOURLY_QUOTA_DEFAULT,
                eventIpQuota: AUDIENCE_EVENT_IP_QUOTA_DEFAULT,
                retentionDays: AUDIENCE_RETENTION_DEFAULT_DAYS
            });
            invalidate('audience.count');
            invalidate('audience.list');
            onSaved(res.site);
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Suivre un nouveau site'
            width={560}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy}>
                        {busy ? 'Enregistrement…' : 'Créer'}
                    </Button>
                </>
            }
        >
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
                        Un hôte par ligne ; le port et le protocole sont ignorés.
                        {origins.trim().length === 0 && ' Vide, toute origine est acceptée.'}
                    </span>
                </label>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default SiteDialog;
