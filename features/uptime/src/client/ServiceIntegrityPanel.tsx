import { useEffect, useState, type ReactNode } from 'react';
import {
    Checkbox,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SearchSelect,
    settingsStyles as shell,
    Switch,
    type SearchSelectOption
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import { UPTIME_INTEGRITY_DEFAULT_INTERVAL_SECONDS, type UptimeService } from '../contracts/domain';

import { api } from './api';
import DeployHookField from './DeployHookField';
import DeploySourcePicker from './DeploySourcePicker';
import { deployKeysOf, deploySettingsOf, parsePaths } from './format';
import styles from './style.module.css';

/** Le rythme de lecture des fichiers : relire tout un site ne descend pas sous cinq minutes. */
const INTEGRITY_INTERVALS: readonly SearchSelectOption[] = [
    { value: '300', label: '5 minutes' },
    { value: String(UPTIME_INTEGRITY_DEFAULT_INTERVAL_SECONDS), label: '15 minutes (par défaut)' },
    { value: '3600', label: '1 heure' },
    { value: '21600', label: '6 heures' },
    { value: '86400', label: '1 jour' }
];

/** Tout ce qu'`uptime.updateIntegrity` prend, tel que l'écran le tient. */
interface IntegrityDraft {
    on: boolean;
    intervalSeconds: number;
    /** Un chemin par ligne, tel que saisi. */
    paths: string;
    deployAccept: boolean;
    /** Les sources choisies, en valeurs du sélecteur (`deploy:5`, `hook`). */
    deployKeys: string[];
}

function draftOf(service: UptimeService): IntegrityDraft {
    return {
        on: service.integrityIntervalSeconds !== null,
        intervalSeconds: service.integrityIntervalSeconds ?? UPTIME_INTEGRITY_DEFAULT_INTERVAL_SECONDS,
        paths: service.paths.join('\n'),
        deployAccept: service.deployAccept,
        deployKeys: deployKeysOf(service.deploySources, service.deployHook)
    };
}

function sameDraft(a: IntegrityDraft, b: IntegrityDraft): boolean {
    return (
        a.on === b.on &&
        a.intervalSeconds === b.intervalSeconds &&
        a.paths === b.paths &&
        a.deployAccept === b.deployAccept &&
        a.deployKeys.join() === b.deployKeys.join()
    );
}

/**
 * Des réglages qui n'agissent qu'interrupteur allumé : toujours là pour qu'on
 * voie ce qui existe, grisés et hors d'atteinte tant qu'il est éteint.
 */
function Dependent({ off, children }: { off: boolean; children: ReactNode }) {
    return (
        <div className={`${styles.dependent} ${off ? styles.dependentOff : ''}`} inert={off}>
            {children}
        </div>
    );
}

/**
 * L'onglet Intégrité d'un service : relire les fichiers que sert le site,
 * leur rythme et les chemins ajoutés, et l'acceptation d'une nouvelle version
 * quand un déploiement l'explique, avec ses sources et son adresse d'appel.
 * L'option éteinte garde tout ce qui en dépend, grisé, pour quand elle revient.
 *
 * Autonome comme l'onglet Général : il charge le service par `uptime.list`,
 * enregistre par `uptime.updateIntegrity` et ravive la liste.
 */
export default function ServiceIntegrityPanel({ scope, canWrite }: SettingsPanelProps) {
    const itemId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [service, setService] = useState<UptimeService | null>(null);
    const [draft, setDraft] = useState<IntegrityDraft | null>(null);
    const [errorSources, setErrorSources] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
        const missingSource = draft.on && draft.deployAccept && draft.deployKeys.length === 0;
        setErrorSources(missingSource ? 'Choisissez au moins une source' : '');
        // Rejeté : le bouton n'annonce « Enregistré » que sur un succès.
        if (missingSource) throw new Error('invalid');
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('uptime.updateIntegrity', {
                id: service.id,
                integrity: {
                    intervalSeconds: draft.on ? draft.intervalSeconds : null,
                    paths: parsePaths(draft.paths),
                    deployAccept: draft.deployAccept,
                    ...deploySettingsOf(draft.deployKeys)
                }
            });
            setService(res.service);
            setDraft(draftOf(res.service));
            invalidate('uptime.list');
        } catch (e) {
            setError(humanizeError(e, 'Enregistrement impossible.'));
            throw e;
        } finally {
            setBusy(false);
        }
    };

    if (!service || !draft) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    const set = <K extends keyof IntegrityDraft>(key: K, value: IntegrityDraft[K]) =>
        setDraft((d) => (d ? { ...d, [key]: value } : d));

    const editable = canWrite && !busy;
    const hookChosen = draft.deployKeys.includes('hook');

    return (
        <div className={shell.section}>
            <Switch
                checked={draft.on}
                disabled={!editable}
                onChange={(v) => set('on', v)}
                label='Vérifier l’intégrité des fichiers'
                hint='Relit les scripts, les styles et la politique de contenu que sert la page, et compare leurs empreintes à une référence apprise à la première lecture. Un écart tient le service en échec jusqu’à ce que le site serve de nouveau la référence, ou que vous acceptiez la version actuelle.'
            />

            <Dependent off={!draft.on}>
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Relire les fichiers toutes les</span>
                    <SearchSelect
                        value={String(draft.intervalSeconds)}
                        disabled={!editable}
                        onChange={(v) => set('intervalSeconds', Number(v))}
                        options={INTEGRITY_INTERVALS}
                        aria-label='Relire les fichiers toutes les'
                    />
                    <span className={shell.fieldHint}>
                        La lecture se fait avec une sonde du service : jamais plus souvent que sa fréquence de relève
                        (onglet Général).
                    </span>
                </div>

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
                        L’adresse surveillée doit être une page du site : ses scripts et styles y sont trouvés seuls, et
                        une instance DevEye annonce tous ses fichiers. Allumer l’option, changer l’adresse ou cette
                        liste fait réapprendre la référence à la prochaine sonde.
                    </span>
                </div>

                <Checkbox checked={draft.deployAccept} disabled={!editable} onChange={(v) => set('deployAccept', v)}>
                    <>
                        <span className={shell.fieldLabel}>
                            Accepter automatiquement les changements lors d’un déploiement
                        </span>
                        <span className={shell.fieldHint}>
                            Quand les fichiers changent, le service demande à ses sources si une mise en ligne vient
                            d’avoir lieu. Si oui, la nouvelle version devient la référence, sans alerte ; si elle est
                            encore en cours, il l’attend jusqu’à trente minutes. Une modification faite entre la fin
                            d’un déploiement et la lecture suivante serait acceptée avec lui.
                        </span>
                    </>
                </Checkbox>

                <Dependent off={draft.on && !draft.deployAccept}>
                    <div className={shell.field}>
                        <span className={shell.sectionLabel}>Ce qui met ce site en ligne</span>
                        <DeploySourcePicker
                            serviceId={service.id}
                            value={draft.deployKeys}
                            disabled={!editable}
                            onChange={(keys) => set('deployKeys', keys)}
                        />
                        {errorSources && <span className={shell.notice}>{errorSources}</span>}
                        <span className={shell.fieldHint}>
                            Un projet compte pour ses déploiements et ses dépôts. Un dépôt Git compte pour ses workflows
                            GitHub Actions réussis sur sa branche par défaut et ses déploiements GitHub (Pages, Vercel,
                            Netlify) : son jeton doit pouvoir les lire. L’adresse d’appel sert à toute autre CI.
                        </span>
                    </div>

                    {hookChosen &&
                        canWrite &&
                        (service.deployHook ? (
                            <DeployHookField serviceId={service.id} disabled={!editable} />
                        ) : (
                            <p className={shell.sectionHint}>L’adresse d’appel apparaît ici une fois enregistré.</p>
                        ))}
                </Dependent>
            </Dependent>

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || sameDraft(draft, draftOf(service))} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un service : cela relève de l’écriture sur Uptime.
                </ReadOnlyNotice>
            )}

            {error && <p className={shell.notice}>{error}</p>}
        </div>
    );
}
