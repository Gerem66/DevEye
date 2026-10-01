import { useEffect, useMemo, useState } from 'react';
import {
    Button,
    Checkbox,
    Dialog,
    humanizeError,
    SearchSelect,
    SegmentedControl,
    TextInput,
    useResource,
    type SearchSelectOption
} from 'deveye-sdk-client';
import type { FeatureDomain } from '@deveye/types';
import {
    UPTIME_NAME_MAX_LENGTH,
    UPTIME_PAGE_DESCRIPTION_MAX_LENGTH,
    UPTIME_PAGE_SERVICES_MAX,
    UPTIME_PAGE_TITLE_MAX_LENGTH,
    type UptimePage,
    type UptimePageTheme
} from '../contracts/domain';

import { api } from './api';
import styles from './style.module.css';

interface StatusPageDialogProps {
    open: boolean;
    /** `null` : création. */
    page: UptimePage | null;
    /** Les domaines de la feature dans cet espace, tels que le panneau les a lus. */
    domains: readonly FeatureDomain[];
    /** Les domaines que d'autres pages servent déjà, avec leur titre : un domaine ne sert qu'une page. */
    takenDomains: ReadonlyMap<number, string>;
    onClose: () => void;
    onSaved: () => void;
}

interface Draft {
    title: string;
    description: string;
    /** Les services retenus, et le nom public saisi pour chacun (vide : son nom). */
    labels: Map<number, string>;
    domainId: number | null;
    theme: UptimePageTheme;
    showErrors: boolean;
    showLatency: boolean;
    enabled: boolean;
}

const THEMES: { value: UptimePageTheme; label: string }[] = [
    { value: 'auto', label: 'Automatique' },
    { value: 'light', label: 'Clair' },
    { value: 'dark', label: 'Sombre' }
];

function draftOf(page: UptimePage | null): Draft {
    return {
        title: page?.title ?? '',
        description: page?.description ?? '',
        labels: new Map((page?.services ?? []).map((service) => [service.id, service.label ?? ''])),
        domainId: page?.domainId ?? null,
        theme: page?.theme ?? 'auto',
        showErrors: page?.showErrors ?? false,
        showLatency: page?.showLatency ?? false,
        enabled: page?.enabled ?? true
    };
}

/**
 * Créer ou régler une page de statut. Les services s'y montrent dans l'ordre de
 * la liste de la feature ; seuls ceux de cet espace sont proposés, un service
 * projeté d'ailleurs n'étant pas le sien à exposer.
 */
export default function StatusPageDialog({
    open,
    page,
    domains,
    takenDomains,
    onClose,
    onSaved
}: StatusPageDialogProps) {
    const { data: services } = useResource(
        'uptime.list',
        () => api.send('uptime.list', {}).then((res) => res.services.filter((service) => !service.foreign)),
        'Impossible de charger les services.'
    );
    const [draft, setDraft] = useState<Draft>(() => draftOf(page));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setDraft(draftOf(page));
        setError(null);
    }, [open, page]);

    function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
        setDraft((prev) => ({ ...prev, [key]: value }));
    }

    const toggle = (id: number, on: boolean) =>
        setDraft((prev) => {
            const labels = new Map(prev.labels);
            if (on) labels.set(id, '');
            else labels.delete(id);
            return { ...prev, labels };
        });

    const rename = (id: number, label: string) =>
        setDraft((prev) => ({ ...prev, labels: new Map(prev.labels).set(id, label) }));

    // Le domaine de la page reste proposé s'il retombe en attente : le taire
    // ferait croire qu'il n'est plus choisi.
    const offered = useMemo(
        () => domains.filter((domain) => domain.verifiedAt !== null || domain.id === page?.domainId),
        [domains, page]
    );
    const domainOptions: readonly SearchSelectOption[] = [
        { value: '', label: 'L’adresse de DevEye' },
        ...offered.map((domain) => {
            const taken = domain.id === page?.domainId ? undefined : takenDomains.get(domain.id);
            const notes = [
                ...(domain.verifiedAt === null ? ['en attente de vérification'] : []),
                ...(taken !== undefined ? [`sert déjà « ${taken} »`] : [])
            ];
            return {
                value: String(domain.id),
                label: domain.host,
                detail: notes.length > 0 ? notes.join(', ') : undefined,
                disabled: taken !== undefined
            };
        })
    ];

    const full = draft.labels.size >= UPTIME_PAGE_SERVICES_MAX;
    const ready = draft.title.trim().length > 0 && draft.labels.size > 0;

    const submit = async () => {
        if (busy || !ready) return;
        setBusy(true);
        setError(null);
        const body = {
            title: draft.title.trim(),
            description: draft.description.trim(),
            // L'ordre de la liste des services, pas celui des clics.
            services: (services ?? [])
                .filter((service) => draft.labels.has(service.id))
                .map((service) => ({ id: service.id, label: draft.labels.get(service.id)?.trim() || null })),
            domainId: draft.domainId,
            theme: draft.theme,
            showErrors: draft.showErrors,
            showLatency: draft.showLatency,
            enabled: draft.enabled
        };
        try {
            if (page) await api.send('uptime.pageUpdate', { id: page.id, page: body });
            else await api.send('uptime.pageAdd', { page: body });
            onSaved();
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’enregistrer cette page.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            onSubmit={() => void submit()}
            title={page ? 'Régler la page de statut' : 'Nouvelle page de statut'}
            description='Une page publique, lisible sans compte, qui montre l’état de quelques services et leurs pannes récentes.'
            width={620}
            footer={
                <>
                    <Button variant='ghost' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !ready}>
                        {busy ? 'Enregistrement…' : page ? 'Enregistrer' : 'Créer la page'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Titre</span>
                    <TextInput
                        data-autofocus=''
                        value={draft.title}
                        maxLength={UPTIME_PAGE_TITLE_MAX_LENGTH}
                        placeholder='État de nos services'
                        onChange={(e) => set('title', e.target.value)}
                    />
                </label>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Présentation (facultative)</span>
                    <TextInput
                        value={draft.description}
                        maxLength={UPTIME_PAGE_DESCRIPTION_MAX_LENGTH}
                        placeholder='Nos services surveillés en continu, et leurs pannes des derniers mois.'
                        onChange={(e) => set('description', e.target.value)}
                    />
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Services montrés</span>
                    {services === null && <span className={styles.fieldHint}>Chargement…</span>}
                    {services?.length === 0 && (
                        <span className={styles.fieldHint}>Ajoutez d’abord un service à surveiller.</span>
                    )}
                    <div className={styles.pageServices}>
                        {(services ?? []).map((service) => {
                            const chosen = draft.labels.has(service.id);
                            return (
                                <div key={service.id} className={styles.pageService}>
                                    <Checkbox
                                        checked={chosen}
                                        disabled={!chosen && full}
                                        onChange={(on) => toggle(service.id, on)}
                                    >
                                        {service.name}
                                    </Checkbox>
                                    {chosen && (
                                        <TextInput
                                            aria-label={`Nom public de ${service.name}`}
                                            value={draft.labels.get(service.id) ?? ''}
                                            maxLength={UPTIME_NAME_MAX_LENGTH}
                                            placeholder='Nom montré au public (facultatif)'
                                            onChange={(e) => rename(service.id, e.target.value)}
                                        />
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <span className={styles.fieldHint}>
                        Dans l’ordre de votre liste de services, {UPTIME_PAGE_SERVICES_MAX} au plus. L’adresse
                        surveillée n’est jamais montrée ; un nom public évite de montrer aussi le nom interne.
                    </span>
                </div>

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Adresse</span>
                    <SearchSelect
                        value={draft.domainId === null ? '' : String(draft.domainId)}
                        onChange={(v) => set('domainId', v === '' ? null : Number(v))}
                        options={domainOptions}
                        aria-label='Adresse'
                    />
                    <span className={styles.fieldHint}>
                        Un domaine vérifié sert la page à sa racine, comme statut.monentreprise.fr. On les déclare dans
                        l’onglet Domaines ; l’adresse de DevEye fonctionne toujours.
                    </span>
                </label>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Thème</span>
                    <SegmentedControl
                        aria-label='Thème de la page'
                        value={draft.theme}
                        onChange={(value: UptimePageTheme) => set('theme', value)}
                        options={THEMES}
                    />
                    <span className={styles.fieldHint}>Automatique suit le réglage clair ou sombre du visiteur.</span>
                </div>

                <div className={styles.field}>
                    <Checkbox checked={draft.showErrors} onChange={(on) => set('showErrors', on)}>
                        Dire la nature des pannes
                    </Checkbox>
                    <span className={styles.fieldHint}>
                        Réponse HTTP, délai dépassé, connexion impossible. Jamais le message brut de la sonde.
                    </span>
                </div>

                <Checkbox checked={draft.showLatency} onChange={(on) => set('showLatency', on)}>
                    Montrer le temps de réponse des dernières 24 heures
                </Checkbox>

                <div className={styles.field}>
                    <Checkbox checked={draft.enabled} onChange={(on) => set('enabled', on)}>
                        Page publiée
                    </Checkbox>
                    <span className={styles.fieldHint}>Non publiée, son lien répond « page introuvable ».</span>
                </div>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}
