import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    ErrorNote,
    errorNote,
    invalidate,
    ReadOnlyNotice,
    settingsStyles as shell,
    useResource,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { AppStoresSource } from '../contracts/domain';

import { api, STORE_PROBE_TIMEOUT_MS } from './api';
import {
    CAPABILITY_OBJECTS,
    formatDate,
    joinFr,
    ON_STORE,
    plural,
    STORE_CAPABILITIES,
    STORE_CONSOLES,
    STORE_ICONS,
    STORE_VENDORS
} from './format';
import { CapabilityResult, SourceDialog } from './SourceDialog';

/** Le formulaire : un compte existant, ou un nouveau. Gardé à la fermeture, le temps de l'animation. */
interface Editing {
    open: boolean;
    source: AppStoresSource | null;
}

/** Ce qu'il faut faire chez le store pour que la clé retirée ne serve plus du tout. */
const REVOKE: Record<AppStoresSource['store'], string> = {
    apple: 'La clé reste valable chez Apple : révoquez-la dans App Store Connect si elle ne sert plus.',
    google: 'La clé du compte de service reste valable : supprimez-la dans Google Cloud si elle ne sert plus.'
};

/**
 * Les comptes App Store Connect et Google Play de l'espace, dans la rangée
 * canonique des réglages. Ils ne se listent qu'avec l'écriture : ils ouvrent
 * l'accès aux comptes de l'utilisateur chez Apple et Google.
 */
export default function SourcesPanel({ canWrite }: SettingsPanelProps) {
    const { data: sources, error: loadError } = useResource(
        'appstores.sources',
        () => (canWrite ? api.send('appstores.listSources', {}).then((res) => res.sources) : Promise.resolve(null)),
        'Impossible de charger les comptes de store.',
        [canWrite]
    );

    const [editing, setEditing] = useState<Editing>({ open: false, source: null });
    const [busy, setBusy] = useState(false);
    /** L'essai en cours, et le compte tel qu'il en est revenu. */
    const [testing, setTesting] = useState<number | null>(null);
    const [tested, setTested] = useState<AppStoresSource | null>(null);
    const [testedOpen, setTestedOpen] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    /** Un compte touche la liste des apps et la fiche ouverte, qui disent ce qui ne se synchronise plus. */
    const changed = () => invalidate('appstores.sources', 'appstores.list', 'appstores.detail');

    const test = async (source: AppStoresSource) => {
        if (testing !== null) return;
        setTesting(source.id);
        setError(null);
        try {
            const res = await api.send(
                'appstores.testSource',
                { sourceId: source.id },
                { timeoutMs: STORE_PROBE_TIMEOUT_MS }
            );
            setTested(res.source);
            setTestedOpen(true);
            changed();
        } catch (e) {
            setError(errorNote(e, `L’essai de « ${source.label} » n’a pas pu aboutir.`));
        } finally {
            setTesting(null);
        }
    };

    const askRemove = (source: AppStoresSource) => {
        setConfirm({
            title: `Retirer « ${source.label} » ?`,
            description:
                (source.useCount === 0
                    ? 'Aucune app ne s’en sert : son retrait ne change rien à ce qui tourne.'
                    : `${plural(source.useCount, 'app s’en sert', 'apps s’en servent')} ${ON_STORE[source.store]} : ` +
                      'leur synchronisation s’arrête jusqu’à ce qu’elles en choisissent un autre. Leurs chiffres et ' +
                      'leurs avis déjà relevés restent.') + ` ${REVOKE[source.store]}`,
            confirmLabel: 'Retirer le compte',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await api.send('appstores.removeSource', { sourceId: source.id });
                        changed();
                    } catch (e) {
                        setError(errorNote(e, 'Le retrait a échoué.'));
                    } finally {
                        setBusy(false);
                    }
                })()
        });
    };

    if (!canWrite) {
        return (
            <ReadOnlyNotice>
                Les comptes de store se voient et se gèrent avec l’écriture sur Stores : ils ouvrent l’accès à vos
                comptes Apple et Google.
            </ReadOnlyNotice>
        );
    }

    return (
        <div className={shell.section}>
            {sources === null && !loadError && <p className={shell.empty}>Chargement…</p>}
            {sources?.length === 0 && (
                <p className={shell.empty}>
                    Aucun compte de store. Reliez un compte App Store Connect ou Google Play : les apps de cet espace le
                    choisiront, et leurs chiffres arriveront seuls.
                </p>
            )}

            {sources && sources.length > 0 && (
                <div className={shell.channelList}>
                    {sources.map((source) => {
                        const missing = STORE_CAPABILITIES[source.store].filter(
                            (capability) => !source.capabilities.includes(capability)
                        );
                        const identity =
                            source.store === 'apple'
                                ? source.keyId
                                    ? `Key ID ${source.keyId}`
                                    : null
                                : source.clientEmail;
                        return (
                            <div key={source.id} className={shell.channelRow}>
                                <span
                                    className={`icon icon-${STORE_ICONS[source.store]} ${shell.channelIcon}`}
                                    aria-hidden='true'
                                />
                                <span className={shell.channelText}>
                                    <span className={shell.channelLabel}>
                                        {source.label}
                                        {source.failingSince !== null && (
                                            <span className={shell.channelBroken}>refusée</span>
                                        )}
                                    </span>
                                    <span className={shell.channelMeta}>
                                        {[
                                            STORE_CONSOLES[source.store],
                                            identity,
                                            source.checkedAt === null
                                                ? 'jamais essayée'
                                                : `vérifiée le ${formatDate(source.checkedAt)}`
                                        ]
                                            .filter((part): part is string => part !== null)
                                            .join(' · ')}
                                    </span>
                                    {source.failingSince !== null && (
                                        <span className={shell.errorText}>
                                            Clé refusée depuis le {formatDate(source.failingSince)}
                                            {source.failingError ? ` : ${source.failingError}` : ''}
                                        </span>
                                    )}
                                    {source.failingSince === null &&
                                        source.checkedAt !== null &&
                                        missing.length > 0 && (
                                            <span className={shell.warning}>
                                                Ne lit pas{' '}
                                                {joinFr(missing.map((capability) => CAPABILITY_OBJECTS[capability]))}.
                                            </span>
                                        )}
                                </span>
                                <span
                                    className={`${shell.channelUsage} ${source.useCount === 0 ? shell.channelUsageIdle : ''}`}
                                    title={
                                        source.useCount === 0
                                            ? 'Choisi par aucune app'
                                            : `Choisi par ${plural(source.useCount, 'app', 'apps')}`
                                    }
                                >
                                    {source.useCount === 0 ? 'inutilisé' : plural(source.useCount, 'app', 'apps')}
                                </span>
                                <span className={shell.channelActions}>
                                    <button
                                        type='button'
                                        className={shell.rowAction}
                                        title='Tester : ce que la clé sait lire aujourd’hui'
                                        aria-label={`Tester ${source.label}`}
                                        disabled={busy || testing !== null}
                                        onClick={() => void test(source)}
                                    >
                                        <span
                                            className={`icon ${testing === source.id ? 'icon-spinner' : 'icon-play'}`}
                                        />
                                    </button>
                                    <button
                                        type='button'
                                        className={shell.rowAction}
                                        title='Modifier ce compte'
                                        aria-label={`Modifier ${source.label}`}
                                        disabled={busy}
                                        onClick={() => setEditing({ open: true, source })}
                                    >
                                        <span className='icon icon-edit' />
                                    </button>
                                    <button
                                        type='button'
                                        className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                        title='Retirer ce compte'
                                        aria-label={`Retirer ${source.label}`}
                                        disabled={busy}
                                        onClick={() => askRemove(source)}
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                </span>
                            </div>
                        );
                    })}
                </div>
            )}

            <ErrorNote note={error ?? loadError} />

            <div className={shell.sectionActions}>
                <Button
                    variant='secondary'
                    icon='plus'
                    disabled={busy}
                    onClick={() => setEditing({ open: true, source: null })}
                >
                    Relier un compte
                </Button>
            </div>

            <SourceDialog
                open={editing.open}
                source={editing.source}
                onClose={() => setEditing((prev) => ({ ...prev, open: false }))}
            />

            <Dialog
                open={testedOpen}
                onClose={() => setTestedOpen(false)}
                title={tested ? `Essai de « ${tested.label} »` : 'Essai'}
                description={
                    tested?.failingSince !== null && tested?.failingError
                        ? tested.failingError
                        : `Voici ce que la clé sait lire chez ${tested ? STORE_VENDORS[tested.store] : 'le store'}.`
                }
                width={580}
                onSubmit={() => setTestedOpen(false)}
                footer={<Button onClick={() => setTestedOpen(false)}>Fermer</Button>}
            >
                {tested && <CapabilityResult source={tested} />}
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
