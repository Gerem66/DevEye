import { useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, DialogCancelButton, SegmentedControl, TextInput } from 'deveye-sdk-client';
import type { UptimeMethod, UptimeService } from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';
import { clamp, type ServiceTuning } from './format';

/**
 * Ce que le dialogue demande : l'identité du service. Ses réglages fins
 * (cadence, délai, seuil, rétention) partent avec les défauts et se changent
 * ensuite dans l'onglet Général de sa fiche.
 */
interface ServiceIdentity {
    name: string;
    url: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    keyword: string | null;
    enabled: boolean;
}

interface ServiceDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (service: UptimeService) => void;
}

const DEFAULTS: ServiceIdentity = {
    name: '',
    url: '',
    method: 'GET',
    expectedStatus: null,
    keyword: null,
    enabled: true
};

/** Les réglages fins d'un service neuf, avant qu'on ne les touche dans ses réglages. */
const TUNING_DEFAULTS: ServiceTuning = {
    intervalSeconds: 60,
    timeoutSeconds: 10,
    failureThreshold: 2,
    retentionDays: null
};

/**
 * Ajouter un service surveillé. Rien d'autre : une fois ajouté, un service se
 * règle dans l'onglet Général de sa fiche, comme tout élément.
 *
 * Contrôlé (`open`/`onSaved`) plutôt qu'impératif : l'onglet Déploiement d'un
 * projet l'ouvre aussi, par le contrat client du module.
 */
export function ServiceDialog({ open, onClose, onSaved }: ServiceDialogProps) {
    const [draft, setDraft] = useState<ServiceIdentity>(DEFAULTS);
    const [errorName, setErrorName] = useState('');
    const [errorUrl, setErrorUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!open) return;
        setDraft(DEFAULTS);
        setErrorName('');
        setErrorUrl('');
        setError(null);
    }, [open]);

    function set<K extends keyof ServiceIdentity>(key: K, value: ServiceIdentity[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    const dirty = (Object.keys(draft) as (keyof ServiceIdentity)[]).some((k) => draft[k] !== DEFAULTS[k]);

    const submit = async () => {
        if (busy) return;
        const name = draft.name.trim();
        const url = draft.url.trim();
        // Le contrat du serveur (`z.string().url()`), vérifié ici pour que le
        // message tombe sur le champ et non en erreur générique.
        const validUrl = /^https?:\/\/\S+$/i.test(url);
        if (!name || !validUrl) {
            setErrorName(name ? '' : 'Ce champ est obligatoire');
            setErrorUrl(validUrl ? '' : 'URL invalide (http:// ou https://)');
            return;
        }
        const payload = { ...draft, ...TUNING_DEFAULTS, name, url, keyword: draft.keyword?.trim() || null };
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('uptime.add', { service: payload });
            onSaved(res.service);
        } catch {
            setError('Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Ajouter un service'
            width={560}
            onSubmit={() => void submit()}
            dirty={dirty}
            onSave={() => void submit()}
        >
            <div className={styles.form}>
                <TextInput
                    placeholder='Nom (ex. API de production)'
                    value={draft.name}
                    error={errorName}
                    onChange={(e) => set('name', e.target.value)}
                />
                <TextInput
                    placeholder='https://exemple.com/health'
                    value={draft.url}
                    error={errorUrl}
                    onChange={(e) => set('url', e.target.value)}
                />

                <div className={styles.formRow}>
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Méthode</span>
                        <SegmentedControl
                            aria-label='Méthode HTTP'
                            value={draft.method}
                            onChange={(v: UptimeMethod) => set('method', v)}
                            options={[
                                { value: 'GET', label: 'GET' },
                                { value: 'HEAD', label: 'HEAD' },
                                { value: 'POST', label: 'POST' }
                            ]}
                        />
                    </div>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Statut attendu</span>
                        <TextInput
                            type='number'
                            min={100}
                            max={599}
                            placeholder='2xx / 3xx'
                            value={draft.expectedStatus ?? ''}
                            onChange={(e) =>
                                set('expectedStatus', e.target.value ? clamp(e.target.value, 100, 599) : null)
                            }
                        />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Mot-clé attendu dans la réponse (optionnel)</span>
                    <TextInput
                        placeholder='ex. "ok"'
                        value={draft.keyword ?? ''}
                        onChange={(e) => set('keyword', e.target.value || null)}
                    />
                </label>

                {/* Cadence, délai, seuil, rétention et canaux d'alerte : dans les
                    réglages du service, pas ici. */}
                <Checkbox checked={draft.enabled} onChange={(v) => set('enabled', v)}>
                    Surveillance active
                </Checkbox>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <DialogCancelButton>Fermer</DialogCancelButton>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default ServiceDialog;
