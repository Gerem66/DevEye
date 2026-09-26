import { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SegmentedControl,
    SelectInput,
    settingsStyles as shell,
    TextInput,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    UPTIME_INTEGRITY_INTERVAL_MIN,
    UPTIME_THRESHOLD_MAX,
    UPTIME_TIMEOUT_MAX,
    UPTIME_TIMEOUT_MIN,
    type UptimeKind,
    type UptimeMethod,
    type UptimeService
} from '../contracts/domain';

import { api } from './api';
import { KIND_OPTIONS, parsePaths } from './kinds';
import { clamp, type ServiceTuning } from './format';
import styles from './style.module.css';

/** Les cadences offertes, en secondes : du quasi-direct au battement quotidien. */
const INTERVALS: { value: number; label: string }[] = [
    { value: 30, label: '30 secondes' },
    { value: 60, label: '1 minute' },
    { value: 300, label: '5 minutes' },
    { value: 900, label: '15 minutes' },
    { value: 3600, label: '1 heure' },
    { value: 21600, label: '6 heures' },
    { value: 86400, label: '1 jour' }
];

/**
 * Combien de temps les sondes brutes sont gardées. Le résumé journalier n'est
 * jamais élagué : une rétention courte ne coûte que le détail ping par ping.
 */
const RETENTIONS: { value: number | null; label: string }[] = [
    { value: null, label: 'Tout garder (par défaut)' },
    { value: 7, label: '7 jours' },
    { value: 30, label: '30 jours' },
    { value: 90, label: '90 jours' },
    { value: 365, label: '1 an' },
    { value: 730, label: '2 ans' },
    { value: 1825, label: '5 ans' }
];

/** Tout ce qu'`uptime.update` prend : l'identité du service et ses réglages fins. */
interface ServiceDraft extends ServiceTuning {
    kind: UptimeKind;
    name: string;
    url: string;
    /** Intégrité : un chemin par ligne, tel que saisi. */
    paths: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    keyword: string | null;
    enabled: boolean;
}

function draftOf(service: UptimeService): ServiceDraft {
    return {
        kind: service.kind,
        name: service.name,
        url: service.url,
        paths: service.paths.join('\n'),
        method: service.method,
        expectedStatus: service.expectedStatus,
        keyword: service.keyword,
        enabled: service.enabled,
        intervalSeconds: service.intervalSeconds,
        timeoutSeconds: service.timeoutSeconds,
        failureThreshold: service.failureThreshold,
        retentionDays: service.retentionDays
    };
}

/**
 * Le service lui-même : son identité (nom, URL, méthode, statut attendu,
 * mot-clé, surveillance), ses réglages fins (cadence, délai, seuil, rétention)
 * et sa suppression. L'onglet Général de ses réglages, là où le bouton commun
 * mène.
 *
 * Autonome : il charge le service par `uptime.list`, enregistre par
 * `uptime.update` (qui prend le service entier) et ravive la liste et le
 * compte. Sans droit d'écriture, les champs restent lisibles mais figés.
 *
 * Un service projeté depuis un autre espace se règle d'ici (le serveur le
 * réécrit sous la clé de son espace d'origine) mais ne s'y supprime pas :
 * détruire l'élément est un geste de chez lui.
 */
export default function ServiceGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [service, setService] = useState<UptimeService | null>(null);
    const [draft, setDraft] = useState<ServiceDraft | null>(null);
    const [errorName, setErrorName] = useState('');
    const [errorUrl, setErrorUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        if (itemId === null) return;
        void api
            .send('uptime.list', {})
            .then((res) => {
                const found = res.services.find((s) => s.id === itemId) ?? null;
                setService(found);
                setDraft(found ? draftOf(found) : null);
                if (!found) setError('Ce service n’existe plus.');
            })
            .catch((e) => setError(humanizeError(e, 'Les réglages n’ont pas pu être lus.')));
    }, [itemId]);

    const save = async () => {
        if (!service || !draft) return;
        const name = draft.name.trim();
        const url = draft.url.trim();
        // Le contrat du serveur (`z.string().url()`), vérifié ici pour que le
        // message tombe sur le champ et non en erreur générique.
        const validUrl = /^https?:\/\/\S+$/i.test(url);
        setErrorName(name ? '' : 'Ce champ est obligatoire');
        setErrorUrl(validUrl ? '' : 'URL invalide (http:// ou https://)');
        // Rejeté : le bouton n'annonce « Enregistré » que sur un succès.
        if (!name || !validUrl) throw new Error('invalid');
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('uptime.update', {
                id: service.id,
                service: {
                    ...draft,
                    name,
                    url,
                    paths: draft.kind === 'integrity' ? parsePaths(draft.paths) : [],
                    keyword: draft.keyword?.trim() || null
                }
            });
            setService(res.service);
            setDraft(draftOf(res.service));
            // Le compte aussi : un service mis en pause n'y figure plus.
            invalidate('uptime.list', 'uptime.count');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!service) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('uptime.remove', { id: service.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait un service qui n'existe plus.
            gone();
            invalidate('uptime.list', 'uptime.count');
        } catch (e) {
            setError(humanizeError(e, 'Suppression impossible.'));
        } finally {
            setBusy(false);
        }
    };

    if (!service || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = <K extends keyof ServiceDraft>(key: K, value: ServiceDraft[K]) =>
        setDraft((d) => (d ? { ...d, [key]: value } : d));

    const editable = canWrite && !busy;
    const integrity = draft.kind === 'integrity';
    // Un contrôle d'intégrité relit tout un site : les cadences rapides n'y sont pas.
    const intervals = integrity ? INTERVALS.filter((i) => i.value >= UPTIME_INTEGRITY_INTERVAL_MIN) : INTERVALS;
    const base = draftOf(service);
    const unchanged = (Object.keys(draft) as (keyof ServiceDraft)[]).every((k) => draft[k] === base[k]);

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Nom</span>
                <TextInput
                    placeholder='Nom (ex. API de production)'
                    value={draft.name}
                    error={errorName}
                    disabled={!editable}
                    onChange={(e) => set('name', e.target.value)}
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Type de contrôle</span>
                {/* Fixé à la création : une référence apprise ne vaut que pour l'intégrité. */}
                <SegmentedControl
                    aria-label='Type de contrôle'
                    value={draft.kind}
                    onChange={() => {}}
                    disabled
                    options={KIND_OPTIONS}
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>URL surveillée</span>
                <TextInput
                    placeholder='https://exemple.com/health'
                    value={draft.url}
                    error={errorUrl}
                    disabled={!editable}
                    onChange={(e) => set('url', e.target.value)}
                />
            </div>

            {integrity && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Fichiers supplémentaires (un chemin par ligne)</span>
                    <textarea
                        className={styles.textarea}
                        rows={3}
                        placeholder={'/t.js'}
                        value={draft.paths}
                        disabled={!editable}
                        onChange={(e) => set('paths', e.target.value)}
                    />
                    <span className={shell.fieldHint}>
                        Les scripts et styles de la page sont trouvés seuls ; une instance DevEye annonce tous ses
                        fichiers. Changer l’adresse ou cette liste fait ré-apprendre la référence à la prochaine relève.
                    </span>
                </div>
            )}

            {!integrity && (
                <>
                    <div className={styles.formRow}>
                        <div className={styles.field}>
                            <span className={shell.sectionLabel}>Méthode</span>
                            <SegmentedControl
                                aria-label='Méthode HTTP'
                                value={draft.method}
                                disabled={!editable}
                                onChange={(v: UptimeMethod) => set('method', v)}
                                options={[
                                    { value: 'GET', label: 'GET' },
                                    { value: 'HEAD', label: 'HEAD' },
                                    { value: 'POST', label: 'POST' }
                                ]}
                            />
                        </div>
                        <div className={styles.field}>
                            <span className={shell.sectionLabel}>Statut attendu</span>
                            <TextInput
                                type='number'
                                min={100}
                                max={599}
                                placeholder='2xx / 3xx'
                                value={draft.expectedStatus ?? ''}
                                disabled={!editable}
                                onChange={(e) =>
                                    set('expectedStatus', e.target.value ? clamp(e.target.value, 100, 599) : null)
                                }
                            />
                            <span className={shell.fieldHint}>Vide, toute réponse 2xx ou 3xx convient.</span>
                        </div>
                    </div>

                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>Mot-clé attendu dans la réponse (optionnel)</span>
                        <TextInput
                            placeholder='ex. "ok"'
                            value={draft.keyword ?? ''}
                            disabled={!editable}
                            onChange={(e) => set('keyword', e.target.value || null)}
                        />
                    </div>
                </>
            )}

            <Checkbox checked={draft.enabled} disabled={!editable} onChange={(v) => set('enabled', v)}>
                <>
                    <span className={shell.fieldLabel}>Surveillance active</span>
                    <span className={shell.fieldHint}>
                        Décochée, le service reste dans la liste avec son historique, mais n’est plus sondé.
                    </span>
                </>
            </Checkbox>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Fréquence de relève</span>
                <SelectInput
                    value={draft.intervalSeconds}
                    disabled={!editable}
                    onChange={(e) => set('intervalSeconds', Number(e.target.value))}
                >
                    {intervals.map((i) => (
                        <option key={i.value} value={i.value}>
                            {i.label}
                        </option>
                    ))}
                </SelectInput>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Délai maximum d’une sonde (secondes)</span>
                <TextInput
                    type='number'
                    min={UPTIME_TIMEOUT_MIN}
                    max={UPTIME_TIMEOUT_MAX}
                    value={draft.timeoutSeconds}
                    disabled={!editable}
                    onChange={(e) =>
                        set('timeoutSeconds', clamp(e.target.value, UPTIME_TIMEOUT_MIN, UPTIME_TIMEOUT_MAX))
                    }
                />
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Échecs consécutifs avant alerte</span>
                <TextInput
                    type='number'
                    min={1}
                    max={UPTIME_THRESHOLD_MAX}
                    value={draft.failureThreshold}
                    disabled={!editable}
                    onChange={(e) => set('failureThreshold', clamp(e.target.value, 1, UPTIME_THRESHOLD_MAX))}
                />
                <span className={shell.fieldHint}>
                    Un échec isolé ne fait pas une panne : le service ne bascule hors ligne qu’après ce nombre d’échecs
                    d’affilée.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Conservation de l’historique détaillé</span>
                <SelectInput
                    value={draft.retentionDays === null ? '' : String(draft.retentionDays)}
                    disabled={!editable}
                    onChange={(e) => set('retentionDays', e.target.value ? Number(e.target.value) : null)}
                >
                    {RETENTIONS.map((r) => (
                        <option key={r.label} value={r.value === null ? '' : String(r.value)}>
                            {r.label}
                        </option>
                    ))}
                </SelectInput>
                <span className={shell.fieldHint}>
                    Le résumé journalier (disponibilité, latence) est conservé indéfiniment quoi qu’il arrive.
                </span>
            </div>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un service : cela relève de l’écriture sur Uptime.
                </ReadOnlyNotice>
            )}

            {service.foreign && (
                <p className={shell.sectionHint}>
                    Ce service appartient à un autre espace qui le partage ici : il se règle d’ici, mais se supprime
                    chez lui.
                </p>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            {canWrite && !service.foreign && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer ce service</span>
                    <span className={shell.fieldHint}>
                        Son historique entier part avec lui, mesures et incidents compris : il n’y a pas d’archive.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${service.name} » ?`,
                                    description:
                                        'Son historique entier part avec lui, mesures et incidents compris : il n’y a pas d’archive.',
                                    confirmLabel: 'Supprimer le service',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le service
                        </Button>
                    </div>
                </div>
            )}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
