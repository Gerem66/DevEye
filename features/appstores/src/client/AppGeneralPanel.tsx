import { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    ErrorNote,
    errorNote,
    invalidate,
    ReadOnlyNotice,
    Reveal,
    SaveButton,
    settingsStyles as shell,
    TextInput,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    APPSTORES_APP_NAME_MAX_LENGTH,
    isStoreAppId,
    type AppStore,
    type AppStoresApp,
    type AppStoresListing
} from '../contracts/domain';

import { api } from './api';
import { ON_STORE, STORE_ICONS, STORE_LABELS, STORE_ORDER, STORE_VENDORS } from './format';
import {
    CountryField,
    firstDraft,
    SourceField,
    StoreAppField,
    useStoreSources,
    type ListingDraft
} from './ListingPicker';
import styles from './style.module.css';

type PerStore<T> = Record<AppStore, T>;

const listingOf = (app: AppStoresApp, store: AppStore): AppStoresListing | null =>
    app.listings.find((listing) => listing.store === store) ?? null;

/** Tout ce que montre une app relue : ses écrans se relisent avec elle. */
const changedApp = () =>
    invalidate(
        'appstores.list',
        'appstores.count',
        'appstores.detail',
        'appstores.stats',
        'appstores.reviews',
        'appstores.revenue'
    );

/**
 * L'app elle-même : son nom, ses fiches de store, le pays de sa note, la
 * relecture de son année et sa suppression. L'identité d'une fiche ne se modifie pas : elle ferait d'une
 * ligne suivie une autre app, avec l'historique de la précédente.
 */
export default function AppGeneralPanel({ scope, canWrite, gone }: SettingsPanelProps) {
    const appId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [app, setApp] = useState<AppStoresApp | null>(null);
    const [loadError, setLoadError] = useState<ErrorNoteInput | null>(null);
    const [name, setName] = useState('');
    const [country, setCountry] = useState('FR');
    /** Le compte choisi pour chaque fiche en place. */
    const [sourceIds, setSourceIds] = useState<PerStore<number | null>>({ apple: null, google: null });
    /** La fiche à relier d'un store où l'app n'est pas encore. */
    const [adding, setAdding] = useState<PerStore<ListingDraft | null>>({ apple: null, google: null });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /** La relecture de l'année est partie : le service la finit seul. */
    const [rereading, setRereading] = useState(false);

    const {
        sources,
        error: sourcesError,
        settingsOpenChange
    } = useStoreSources(canWrite, (store, sourceId) => {
        if (app && listingOf(app, store)) setSourceIds((prev) => ({ ...prev, [store]: sourceId }));
        else setAdding((prev) => ({ ...prev, [store]: { sourceId, externalId: '' } }));
    });

    const take = (next: AppStoresApp) => {
        setApp(next);
        setName(next.name);
        setCountry(next.ratingCountry);
        setSourceIds({
            apple: listingOf(next, 'apple')?.sourceId ?? null,
            google: listingOf(next, 'google')?.sourceId ?? null
        });
        setAdding({ apple: null, google: null });
    };

    useEffect(() => {
        if (appId === null) return;
        let alive = true;
        api.send('appstores.get', { appId })
            .then((res) => {
                if (alive) take(res.app);
            })
            .catch((e: unknown) => {
                if (alive) setLoadError(errorNote(e, 'L’app n’a pas pu être lue.'));
            });
        return () => {
            alive = false;
        };
    }, [appId]);

    if (!app) return loadError ? <ErrorNote note={loadError} /> : <p className={shell.empty}>Chargement…</p>;

    // Ses comptes vivent chez elle : le serveur refuse de régler une app projetée ici.
    if (app.foreign) {
        return (
            <p className={shell.sectionHint}>
                Cette app vient d’un autre espace : son nom, ses fiches de store et sa suppression se règlent depuis
                là-bas.
            </p>
        );
    }

    const editable = canWrite && !busy;

    const listingInput = (store: AppStore) => {
        const listing = listingOf(app, store);
        if (listing) return { sourceId: sourceIds[store], externalId: listing.externalId };
        const draft = adding[store];
        return draft ? { sourceId: draft.sourceId, externalId: draft.externalId } : null;
    };

    const unchanged =
        name.trim() === app.name &&
        country === app.ratingCountry &&
        STORE_ORDER.every((store) => {
            const listing = listingOf(app, store);
            return listing ? sourceIds[store] === listing.sourceId : adding[store] === null;
        });
    const invalid =
        name.trim() === '' ||
        STORE_ORDER.some((store) => {
            const draft = adding[store];
            return draft !== null && !isStoreAppId(store, draft.externalId);
        });

    const save = async () => {
        setError(null);
        try {
            const res = await api.send('appstores.update', {
                appId: app.id,
                name: name.trim(),
                ratingCountry: country,
                apple: listingInput('apple'),
                google: listingInput('google')
            });
            take(res.app);
            changedApp();
        } catch (e) {
            setError(errorNote(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    /** Retirer part tout de suite, derrière sa confirmation : ce qui reste en cours de saisie n'est pas enregistré. */
    const askRemoveListing = (store: AppStore) => {
        const other = STORE_ORDER.find((candidate) => candidate !== store && listingOf(app, candidate) !== null);
        setConfirm({
            title: `Retirer la fiche ${STORE_LABELS[store]} de « ${app.name} » ?`,
            description:
                `Son historique est supprimé : les téléchargements, les notes, les avis et les revenus relevés ${ON_STORE[store]}. ` +
                (other ? `L’app reste suivie ${ON_STORE[other]}.` : 'L’app reste dans la liste, sans store.') +
                ` Rien ne change chez ${STORE_VENDORS[store]}.`,
            confirmLabel: 'Retirer la fiche',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    setError(null);
                    const kept = (candidate: AppStore) => {
                        const listing = listingOf(app, candidate);
                        return candidate === store || !listing
                            ? null
                            : { sourceId: listing.sourceId, externalId: listing.externalId };
                    };
                    try {
                        const res = await api.send('appstores.update', {
                            appId: app.id,
                            name: app.name,
                            ratingCountry: app.ratingCountry,
                            apple: kept('apple'),
                            google: kept('google')
                        });
                        setApp(res.app);
                        setSourceIds((prev) => ({ ...prev, [store]: null }));
                        setAdding((prev) => ({ ...prev, [store]: null }));
                        changedApp();
                    } catch (e) {
                        setError(errorNote(e, 'La fiche n’a pas pu être retirée.'));
                    } finally {
                        setBusy(false);
                    }
                })()
        });
    };

    const reread = async () => {
        setError(null);
        try {
            await api.send('appstores.backfill', { appId: app.id });
            setRereading(true);
        } catch (e) {
            setError(errorNote(e, 'La relecture n’a pas pu être lancée.'));
        }
    };

    const remove = async () => {
        setBusy(true);
        setError(null);
        try {
            await api.send('appstores.remove', { appId: app.id });
            // La fiche s'en va AVANT que la liste se relise : relue après coup, elle chercherait une app disparue.
            gone();
            invalidate('appstores.list', 'appstores.count', 'appstores.detail', 'projects.board');
        } catch (e) {
            setError(errorNote(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const projects =
        app.projectCount === 1
            ? 'le projet qui la relie perd son lien'
            : app.projectCount > 1
              ? `les ${app.projectCount} projets qui la relient perdent leur lien`
              : 'les projets qui la relieraient perdraient leur lien';
    const showCountry = listingOf(app, 'apple') !== null || adding.apple !== null;

    return (
        <div className={shell.section}>
            <label className={shell.field}>
                <span className={shell.sectionLabel}>Nom</span>
                <TextInput
                    value={name}
                    disabled={!editable}
                    maxLength={APPSTORES_APP_NAME_MAX_LENGTH}
                    onChange={(e) => setName(e.target.value)}
                />
            </label>

            {STORE_ORDER.map((store) => {
                const listing = listingOf(app, store);
                const draft = adding[store];
                return (
                    <section key={store} className={styles.storeBlock}>
                        <p className={styles.storeBlockLabel}>
                            <span className={`icon icon-${STORE_ICONS[store]}`} aria-hidden='true' />
                            {STORE_LABELS[store]}
                        </p>

                        {listing ? (
                            <div className={styles.storeBlockBody}>
                                <div className={shell.field}>
                                    <span className={styles.identityName}>
                                        {listing.storeName ?? listing.externalId}
                                    </span>
                                    <span className={styles.identityMeta}>
                                        {[listing.externalId, listing.bundleId]
                                            .filter(
                                                (part, index, all): part is string =>
                                                    part !== null && all.indexOf(part) === index
                                            )
                                            .join(' · ')}
                                    </span>
                                    <span className={shell.fieldHint}>
                                        L’identité au store ne change pas : pour suivre une autre app, retirez cette
                                        fiche, puis reliez l’autre.
                                    </span>
                                </div>
                                {canWrite ? (
                                    <SourceField
                                        store={store}
                                        sources={sources ?? []}
                                        sourceId={sourceIds[store]}
                                        disabled={!editable}
                                        onChange={(sourceId) =>
                                            setSourceIds((prev) => ({ ...prev, [store]: sourceId }))
                                        }
                                        onSettingsOpenChange={settingsOpenChange(store)}
                                    />
                                ) : (
                                    <span className={shell.fieldHint}>
                                        {listing.sourceId === null
                                            ? 'Aucun compte de store n’est choisi : cette fiche ne se synchronise pas.'
                                            : 'Synchronisée par un compte de store de l’espace.'}
                                    </span>
                                )}
                                {store === 'apple' && (
                                    <CountryField value={country} disabled={!editable} onChange={setCountry} />
                                )}
                                {canWrite && (
                                    <div className={shell.sectionActions}>
                                        <Button
                                            variant='secondary'
                                            icon='trash'
                                            disabled={busy}
                                            onClick={() => askRemoveListing(store)}
                                        >
                                            Retirer cette fiche
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ) : canWrite ? (
                            <>
                                <Checkbox
                                    checked={draft !== null}
                                    disabled={busy}
                                    onChange={(checked) =>
                                        setAdding((prev) => ({
                                            ...prev,
                                            [store]: checked ? firstDraft(store, sources) : null
                                        }))
                                    }
                                >
                                    Relier sa fiche {STORE_LABELS[store]}
                                </Checkbox>
                                <Reveal open={draft !== null}>
                                    {draft !== null && (
                                        <div className={styles.storeBlockBody}>
                                            <SourceField
                                                store={store}
                                                sources={sources ?? []}
                                                sourceId={draft.sourceId}
                                                disabled={!editable}
                                                onChange={(sourceId) =>
                                                    setAdding((prev) => ({
                                                        ...prev,
                                                        [store]: { sourceId, externalId: '' }
                                                    }))
                                                }
                                                onSettingsOpenChange={settingsOpenChange(store)}
                                            />
                                            <StoreAppField
                                                store={store}
                                                sourceId={draft.sourceId}
                                                externalId={draft.externalId}
                                                disabled={!editable}
                                                onChange={(externalId) =>
                                                    setAdding((prev) => ({
                                                        ...prev,
                                                        [store]: { ...draft, externalId }
                                                    }))
                                                }
                                            />
                                            {store === 'apple' && (
                                                <CountryField
                                                    value={country}
                                                    disabled={!editable}
                                                    onChange={setCountry}
                                                />
                                            )}
                                        </div>
                                    )}
                                </Reveal>
                            </>
                        ) : (
                            <span className={shell.fieldHint}>Pas encore {ON_STORE[store]}.</span>
                        )}
                    </section>
                );
            })}

            {!showCountry && canWrite && (
                <span className={shell.fieldHint}>
                    Le pays de la note se choisit avec la fiche App Store : Apple ne publie pas de note mondiale.
                </span>
            )}

            {canWrite ? (
                <SaveButton onSave={save} disabled={busy || unchanged || invalid} />
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier une app : cela relève de l’écriture sur Stores.
                </ReadOnlyNotice>
            )}

            {canWrite && app.listings.some((listing) => listing.sourceId !== null) && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Relire l’année écoulée</span>
                    <span className={shell.fieldHint}>
                        Apple et Google sont relus jusqu’au même mois de l’an dernier : téléchargements, pays, notes et
                        revenus. Rien n’est effacé, et les chiffres se complètent en quelques minutes.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='secondary'
                            icon='refresh'
                            disabled={busy || rereading || app.planPaused}
                            onClick={() => void reread()}
                        >
                            {rereading ? 'Relecture lancée' : 'Relire l’historique'}
                        </Button>
                    </div>
                </div>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer cette app</span>
                    <span className={shell.fieldHint}>
                        Ses chiffres, ses avis et ses revenus relevés sont perdus, et {projects}. L’app sur l’App Store
                        et sur Google Play, elle, n’est pas touchée.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${app.name} » ?`,
                                    description: `Ses chiffres, ses avis et ses revenus relevés sont perdus, et ${projects}. Rien ne change chez Apple ni chez Google.`,
                                    confirmLabel: 'Supprimer l’app',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer l’app
                        </Button>
                    </div>
                </div>
            )}

            <ErrorNote note={error ?? sourcesError} />
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
