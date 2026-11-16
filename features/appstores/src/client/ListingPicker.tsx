import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ErrorNote,
    errorNote,
    FeatureSettingsButton,
    SearchSelect,
    settingsStyles as shell,
    TextInput,
    useResourceVersion,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { isStoreAppId, type AppStore, type AppStoresSource, type AppStoresStoreApp } from '../contracts/domain';

import { api, STORE_LIST_TIMEOUT_MS } from './api';
import { countryOptions, ON_STORE, STORE_CONSOLES, STORE_VENDORS } from './format';
import styles from './style.module.css';

/** Une fiche de store telle qu'un formulaire la décrit avant de l'envoyer. */
export interface ListingDraft {
    sourceId: number | null;
    externalId: string;
}

/** Un seul compte pour ce store : il est choisi d'office, il n'y a rien à décider. */
export function firstDraft(store: AppStore, sources: readonly AppStoresSource[] | null): ListingDraft {
    const own = (sources ?? []).filter((source) => source.store === store);
    return { sourceId: own.length === 1 ? own[0].id : null, externalId: '' };
}

/**
 * Les comptes de l'espace, et l'adoption de celui que « Comptes » vient de
 * créer : photographiés à l'ouverture des réglages, le nouveau venu du même
 * store est choisi au retour. Le `false` émis au montage ne relit rien.
 */
export function useStoreSources(enabled: boolean, onAdopt: (store: AppStore, sourceId: number) => void) {
    const [sources, setSources] = useState<AppStoresSource[] | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const version = useResourceVersion('appstores.sources');
    const known = useRef<Set<number> | null>(null);
    const adopt = useRef(onAdopt);
    adopt.current = onAdopt;

    const load = useCallback(async (): Promise<AppStoresSource[]> => {
        try {
            const res = await api.send('appstores.listSources', {});
            setSources(res.sources);
            setError(null);
            return res.sources;
        } catch (e) {
            setError(errorNote(e, 'Les comptes de store de l’espace n’ont pas pu être lus.'));
            return [];
        }
    }, []);

    useEffect(() => {
        if (enabled) void load();
    }, [enabled, version, load]);

    const settingsOpenChange = (store: AppStore) => (opened: boolean) => {
        if (opened) {
            known.current = new Set((sources ?? []).map((source) => source.id));
            return;
        }
        const before = known.current;
        if (before === null) return;
        known.current = null;
        void load().then((list) => {
            const fresh = list.find((source) => source.store === store && !before.has(source.id));
            if (fresh) adopt.current(store, fresh.id);
        });
    };

    return { sources, error, settingsOpenChange };
}

interface SourceFieldProps {
    store: AppStore;
    sources: readonly AppStoresSource[];
    sourceId: number | null;
    onChange: (sourceId: number | null) => void;
    onSettingsOpenChange: (opened: boolean) => void;
    disabled?: boolean;
}

/** Le compte d'une fiche : il se choisit ici, il se crée dans l'onglet Sources, ouvert par « Comptes ». */
export function SourceField({ store, sources, sourceId, onChange, onSettingsOpenChange, disabled }: SourceFieldProps) {
    const own = sources.filter((source) => source.store === store);
    const consoleName = STORE_CONSOLES[store];
    return (
        <div className={shell.field}>
            <span className={shell.fieldLabel}>Compte {consoleName}</span>
            <div className={shell.fieldWithAction}>
                <SearchSelect
                    value={sourceId === null ? '' : String(sourceId)}
                    disabled={disabled}
                    aria-label={`Compte ${consoleName}`}
                    options={[
                        { value: '', label: 'Aucun : la fiche ne se synchronise pas' },
                        ...own.map((source) => ({
                            value: String(source.id),
                            label: source.label,
                            detail: source.failingSince !== null ? 'clé refusée' : undefined
                        }))
                    ]}
                    onChange={(value) => onChange(value ? Number(value) : null)}
                />
                {!disabled && (
                    <FeatureSettingsButton
                        scope={{ kind: 'feature', feature: 'appstores' }}
                        initialSection='sources'
                        variant='ghost'
                        label='Comptes'
                        onOpenChange={onSettingsOpenChange}
                    />
                )}
            </div>
            {own.length === 0 && !disabled && (
                <span className={shell.fieldHint}>
                    Aucun compte {consoleName} dans cet espace. « Comptes » ouvre les réglages pour en relier un : il
                    sera choisi ici à votre retour.
                </span>
            )}
        </div>
    );
}

/** L'identifiant d'une adresse de fiche collée telle quelle : le nombre d'Apple, le paquet de Google. */
function normalizeStoreAppId(store: AppStore, text: string): string {
    const trimmed = text.trim();
    if (store === 'apple') return /\/id(\d{1,15})(?:\D|$)/.exec(trimmed)?.[1] ?? trimmed;
    return /[?&]id=([A-Za-z0-9_.]+)/.exec(trimmed)?.[1] ?? trimmed;
}

const MANUAL_HINTS: Record<AppStore, string> = {
    apple: 'Le nombre qui suit « id » dans l’adresse de sa fiche (apps.apple.com/…/id1234567890). L’adresse entière convient aussi.',
    google: 'Son nom de paquet, comme com.exemple.app : il suit « id= » dans l’adresse de sa fiche Google Play. L’adresse entière convient aussi.'
};

const MANUAL_INVALID: Record<AppStore, string> = {
    apple: 'Ce n’est pas un identifiant de l’App Store : un nombre, comme 1234567890.',
    google: 'Ce n’est pas un nom de paquet Android, comme com.exemple.app.'
};

interface StoreAppFieldProps {
    store: AppStore;
    sourceId: number | null;
    externalId: string;
    /** `picked` : l'app choisie dans la liste du store, de quoi nommer une app neuve. */
    onChange: (externalId: string, picked?: AppStoresStoreApp) => void;
    disabled?: boolean;
}

/**
 * L'app au store : choisie parmi celles que la clé voit, ou saisie à la main.
 * La saisie reste ouverte parce que la liste dépend d'un tiers qui peut
 * refuser (une invitation pas encore active, une clé à portée réduite).
 */
export function StoreAppField({ store, sourceId, externalId, onChange, disabled }: StoreAppFieldProps) {
    const [apps, setApps] = useState<AppStoresStoreApp[] | null>(null);
    const [looking, setLooking] = useState(false);
    const [lookupError, setLookupError] = useState<ErrorNoteInput | null>(null);
    const [manual, setManual] = useState(false);
    const [manualText, setManualText] = useState(externalId);

    useEffect(() => {
        setApps(null);
        setLookupError(null);
        setManual(false);
        if (sourceId === null) return;
        let alive = true;
        setLooking(true);
        api.send('appstores.listStoreApps', { sourceId }, { timeoutMs: STORE_LIST_TIMEOUT_MS })
            .then((res) => {
                if (alive) setApps(res.apps);
            })
            .catch((e: unknown) => {
                if (alive) setLookupError(errorNote(e, 'Les apps de ce compte n’ont pas pu être listées.'));
            })
            .finally(() => {
                if (alive) setLooking(false);
            });
        return () => {
            alive = false;
        };
    }, [sourceId]);

    const useManual = manual || sourceId === null || lookupError !== null || apps?.length === 0;

    // Le texte reprend la valeur choisie dans la liste quand on passe à la saisie.
    useEffect(() => {
        if (useManual) setManualText(externalId);
    }, [useManual]);

    const invalid = useManual && externalId !== '' && !isStoreAppId(store, externalId);

    return (
        <div className={shell.field}>
            <span className={shell.fieldLabel}>App {ON_STORE[store]}</span>
            {useManual ? (
                <>
                    <TextInput
                        value={manualText}
                        disabled={disabled}
                        placeholder={store === 'apple' ? '1234567890' : 'com.exemple.app'}
                        onChange={(e) => {
                            setManualText(e.target.value);
                            onChange(normalizeStoreAppId(store, e.target.value));
                        }}
                    />
                    <span className={invalid ? shell.warning : shell.fieldHint}>
                        {invalid ? MANUAL_INVALID[store] : MANUAL_HINTS[store]}
                    </span>
                </>
            ) : (
                <SearchSelect
                    value={externalId}
                    disabled={disabled || looking || apps === null}
                    aria-label={`App ${ON_STORE[store]}`}
                    placeholder={
                        looking
                            ? `Lecture chez ${STORE_VENDORS[store]}…`
                            : `Choisir parmi ${apps?.length ?? 0} app${(apps?.length ?? 0) > 1 ? 's' : ''}…`
                    }
                    options={(apps ?? []).map((app) => ({
                        value: app.externalId,
                        label: app.name,
                        detail: app.known ? 'déjà suivie ici' : (app.bundleId ?? app.externalId),
                        keywords: [app.externalId, app.bundleId ?? ''],
                        disabled: app.known
                    }))}
                    onChange={(value) =>
                        onChange(
                            value,
                            apps?.find((app) => app.externalId === value)
                        )
                    }
                />
            )}

            <ErrorNote note={lookupError} inline />

            {apps !== null && apps.length === 0 && !lookupError && (
                <span className={shell.fieldHint}>
                    Ce compte ne voit encore aucune app. Saisissez son identifiant, ou vérifiez les accès de la clé.
                </span>
            )}

            {sourceId !== null && lookupError === null && apps !== null && apps.length > 0 && !disabled && (
                <button type='button' className={styles.linkButton} onClick={() => setManual((value) => !value)}>
                    {manual ? 'Choisir dans la liste' : 'Saisir l’identifiant à la main'}
                </button>
            )}
        </div>
    );
}

interface CountryFieldProps {
    value: string;
    onChange: (country: string) => void;
    disabled?: boolean;
}

/** Le pays dont la note App Store est lue : Apple n'en publie pas de mondiale. */
export function CountryField({ value, onChange, disabled }: CountryFieldProps) {
    return (
        <div className={shell.field}>
            <span className={shell.fieldLabel}>Pays de la note</span>
            <SearchSelect
                value={value}
                disabled={disabled}
                aria-label='Pays de la note App Store'
                options={countryOptions(value)}
                onChange={onChange}
            />
            <span className={shell.fieldHint}>
                Apple ne publie pas de note mondiale : c’est celle de l’App Store de ce pays qui s’affichera.
            </span>
        </div>
    );
}
