import { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    Dialog,
    ErrorNote,
    errorNote,
    invalidate,
    Reveal,
    settingsStyles as shell,
    TextInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import {
    APPSTORES_APP_NAME_MAX_LENGTH,
    COUNTRY_CODE,
    isStoreAppId,
    type AppStore,
    type AppStoresApp
} from '../contracts/domain';

import { api } from './api';
import { ON_STORE, STORE_ICONS, STORE_ORDER } from './format';
import {
    CountryField,
    firstDraft,
    SourceField,
    StoreAppField,
    useStoreSources,
    type ListingDraft
} from './ListingPicker';
import styles from './style.module.css';

interface AppDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (app: AppStoresApp) => void;
}

type Drafts = Record<AppStore, ListingDraft | null>;

const NO_DRAFTS: Drafts = { apple: null, google: null };

/**
 * Suivre une app. Rien d'autre : une fois créée, elle se règle dans les
 * onglets Général et Stores de sa fiche. Monté aussi par Projets, qui relie ce qui vient d'être
 * créé. Une app sans store est admise : elle attend sa sortie.
 */
export function AppDialog({ open, onClose, onSaved }: AppDialogProps) {
    const [name, setName] = useState('');
    const [country, setCountry] = useState('FR');
    const [drafts, setDrafts] = useState<Drafts>(NO_DRAFTS);
    /** Le nom a-t-il été saisi ? Sinon, il suit l'app choisie au store. */
    const [named, setNamed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const {
        sources,
        error: sourcesError,
        settingsOpenChange
    } = useStoreSources(open, (store, sourceId) =>
        setDrafts((prev) => ({ ...prev, [store]: { sourceId, externalId: '' } }))
    );

    useEffect(() => {
        if (!open) return;
        setName('');
        setCountry('FR');
        setDrafts(NO_DRAFTS);
        setNamed(false);
        setError(null);
    }, [open]);

    const setDraft = (store: AppStore, draft: ListingDraft | null) =>
        setDrafts((prev) => ({ ...prev, [store]: draft }));

    const incomplete = STORE_ORDER.filter((store) => {
        const draft = drafts[store];
        return draft !== null && !isStoreAppId(store, draft.externalId);
    });
    const canSubmit = name.trim() !== '' && incomplete.length === 0 && COUNTRY_CODE.test(country);

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const listing = (store: AppStore) => {
                const draft = drafts[store];
                return draft === null ? null : { sourceId: draft.sourceId, externalId: draft.externalId };
            };
            const res = await api.send('appstores.add', {
                name: name.trim(),
                ratingCountry: country,
                apple: listing('apple'),
                google: listing('google')
            });
            invalidate('appstores.list', 'appstores.count');
            onSaved(res.app);
        } catch (e) {
            setError(errorNote(e, 'L’app n’a pas pu être ajoutée.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Ajouter une app'
            description='Ses téléchargements, ses notes et ses avis arriveront seuls, lus avec les comptes de store que vous choisissez.'
            width={580}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !canSubmit}>
                        {busy ? 'Ajout…' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={shell.section}>
                <label className={shell.field}>
                    <span className={shell.sectionLabel}>Nom de l’app</span>
                    <TextInput
                        data-autofocus
                        value={name}
                        maxLength={APPSTORES_APP_NAME_MAX_LENGTH}
                        placeholder='Mon app'
                        onChange={(e) => {
                            setName(e.target.value);
                            setNamed(e.target.value.trim() !== '');
                        }}
                    />
                </label>

                {STORE_ORDER.map((store) => {
                    const draft = drafts[store];
                    return (
                        <section key={store} className={styles.storeBlock}>
                            <Checkbox
                                checked={draft !== null}
                                disabled={busy}
                                onChange={(checked) => setDraft(store, checked ? firstDraft(store, sources) : null)}
                            >
                                <span className={styles.storeBlockLabel}>
                                    <span className={`icon icon-${STORE_ICONS[store]}`} aria-hidden='true' />
                                    Elle est {ON_STORE[store]}
                                </span>
                            </Checkbox>
                            <Reveal open={draft !== null}>
                                {draft !== null && (
                                    <div className={styles.storeBlockBody}>
                                        <SourceField
                                            store={store}
                                            sources={sources ?? []}
                                            sourceId={draft.sourceId}
                                            disabled={busy}
                                            onChange={(sourceId) => setDraft(store, { sourceId, externalId: '' })}
                                            onSettingsOpenChange={settingsOpenChange(store)}
                                        />
                                        <StoreAppField
                                            store={store}
                                            sourceId={draft.sourceId}
                                            externalId={draft.externalId}
                                            disabled={busy}
                                            onChange={(externalId, picked) => {
                                                setDraft(store, { ...draft, externalId });
                                                if (picked && !named) setName(picked.name);
                                            }}
                                        />
                                        {store === 'apple' && (
                                            <CountryField value={country} disabled={busy} onChange={setCountry} />
                                        )}
                                    </div>
                                )}
                            </Reveal>
                        </section>
                    );
                })}

                {drafts.apple === null && drafts.google === null && (
                    <p className={shell.fieldHint}>
                        Pas encore sortie ? Ajoutez-la sans store : vous relierez ses fiches depuis ses réglages, le
                        jour venu.
                    </p>
                )}

                <ErrorNote note={sourcesError} />
                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

export default AppDialog;
