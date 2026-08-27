import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, DialogCancelButton, SelectInput, TextInput } from 'deveye-sdk-client';
import type { UptimeMethod, UptimeService } from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

/**
 * Ce que le dialogue règle : l'identité du service, et rien d'autre.
 *
 * La cadence de relève, le délai, le seuil de défaillance et la rétention
 * vivaient ici aussi ; ils sont partis dans le panneau Général des réglages
 * du service (`ServiceGeneralPanel`, coquille commune), là où se règle le
 * reste (canaux, partage, permissions). Le dialogue les conserve tels quels
 * quand il enregistre : le contrat d'`uptime.update` prend le service entier.
 */
interface ServiceDraft {
    name: string;
    url: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    keyword: string | null;
    enabled: boolean;
}

/** Les quatre réglages que le dialogue ne montre plus, mais réécrit tels quels. */
interface ServiceTuning {
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
}

interface ServiceDialogProps {
    open: boolean;
    /** Le service modifié, ou `null` pour un ajout. */
    service: UptimeService | null;
    onClose: () => void;
    onSaved: (service: UptimeService) => void;
    /** Absent = pas de suppression proposée (on ajoute depuis un projet). */
    onRemoved?: () => void;
}

/** Keep a typed number inside its contract bounds (empty / NaN → `min`). */
function clamp(raw: string, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(raw) || min));
}

const DEFAULTS: ServiceDraft = {
    name: '',
    url: '',
    method: 'GET',
    expectedStatus: null,
    keyword: null,
    enabled: true
};

/** Les réglages d'un service neuf, avant qu'on ne les touche dans ses réglages. */
export const TUNING_DEFAULTS: ServiceTuning = {
    intervalSeconds: 60,
    timeoutSeconds: 10,
    failureThreshold: 2,
    retentionDays: null
};

/**
 * Ajouter / régler un service surveillé.
 *
 * **Contrôlé, pas impérative.** Cette feature a longtemps vécu derrière
 * `OpenPopup`/`ClosePopup`, un registre global à clé unique, qu'un deuxième
 * montage écrase (`FeatureKeepAlive` en garde plusieurs à la fois vivants).
 * Cela suffisait tant que le formulaire n'ouvrait que depuis la feature Uptime
 * elle-même ; l'onglet Déploiement d'un projet doit désormais pouvoir déclarer
 * un service à la volée, exactement comme `TargetDialog` pour une cible de
 * déploiement, d'où ce même patron `open`/`service`/`onSaved` (offert à
 * Projets par le contrat client du module).
 */
export function ServiceDialog({ open, service, onClose, onSaved, onRemoved }: ServiceDialogProps) {
    const [draft, setDraft] = useState<ServiceDraft>(DEFAULTS);
    const [errorName, setErrorName] = useState('');
    const [errorUrl, setErrorUrl] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // Snapshot of the values the dialog opened with, to detect unsaved edits.
    const initial = useRef<ServiceDraft>(DEFAULTS);

    useEffect(() => {
        if (!open) return;
        const next: ServiceDraft = service
            ? {
                  name: service.name,
                  url: service.url,
                  method: service.method,
                  expectedStatus: service.expectedStatus,
                  keyword: service.keyword,
                  enabled: service.enabled
              }
            : DEFAULTS;
        setDraft(next);
        initial.current = next;
        setErrorName('');
        setErrorUrl('');
        setError(null);
    }, [open, service]);

    function set<K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    const dirty = (Object.keys(draft) as (keyof ServiceDraft)[]).some((k) => draft[k] !== initial.current[k]);

    const submit = async () => {
        if (busy) return;
        const name = draft.name.trim();
        const url = draft.url.trim();
        // Mirrors the server contract (`z.string().url()`): reject here so the
        // user gets the message on the field rather than a generic WS error.
        const validUrl = /^https?:\/\/\S+$/i.test(url);
        if (!name || !validUrl) {
            setErrorName(name ? '' : 'Ce champ est obligatoire');
            setErrorUrl(validUrl ? '' : 'URL invalide (http:// ou https://)');
            return;
        }
        // Les réglages du service, conservés tels quels : ils se changent dans
        // ses réglages, pas ici. Un service neuf part avec les défauts.
        const tuning: ServiceTuning = service
            ? {
                  intervalSeconds: service.intervalSeconds,
                  timeoutSeconds: service.timeoutSeconds,
                  failureThreshold: service.failureThreshold,
                  retentionDays: service.retentionDays
              }
            : TUNING_DEFAULTS;
        const payload = { ...draft, ...tuning, name, url, keyword: draft.keyword?.trim() || null };
        setBusy(true);
        setError(null);
        try {
            const res = service
                ? await api.send('uptime.update', { id: service.id, service: payload })
                : await api.send('uptime.add', { service: payload });
            onSaved(res.service);
        } catch {
            setError('Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!service || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('uptime.remove', { id: service.id });
            onRemoved?.();
        } catch {
            setError('Suppression impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={service ? 'Modifier le service' : 'Ajouter un service'}
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
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Méthode</span>
                        <SelectInput
                            value={draft.method}
                            onChange={(e) => set('method', e.target.value as UptimeMethod)}
                        >
                            <option value='GET'>GET</option>
                            <option value='HEAD'>HEAD</option>
                            <option value='POST'>POST</option>
                        </SelectInput>
                    </label>
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

                {/* Cadence, délai, seuil et rétention : dans les réglages du
                    service (bouton commun de sa fiche, onglet Général), pas
                    ici. « M'alerter quand ce service tombe » y vivait aussi,
                    en doublon muet de la section Notifications : les canaux et
                    le silence se règlent à un seul endroit, Réglages →
                    Notifications. */}
                <Checkbox checked={draft.enabled} onChange={(v) => set('enabled', v)}>
                    Surveillance active
                </Checkbox>

                {error && <p className={styles.error}>{error}</p>}
            </div>

            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Fermer</DialogCancelButton>
                    {service && onRemoved && (
                        <Button variant='danger' onClick={() => void remove()} disabled={busy}>
                            Supprimer
                        </Button>
                    )}
                </div>
                <Button onClick={() => void submit()} disabled={busy}>
                    {busy ? 'Enregistrement…' : service ? 'Enregistrer' : 'Ajouter'}
                </Button>
            </div>
        </Dialog>
    );
}

export default ServiceDialog;
