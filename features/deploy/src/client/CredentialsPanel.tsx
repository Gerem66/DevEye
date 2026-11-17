import { useState } from 'react';
import {
    Button,
    ConfirmDialog,
    DeviceRelayField,
    Dialog,
    ErrorNote,
    errorNote,
    invalidate,
    SegmentedControl,
    settingsStyles as shell,
    TextInput,
    useDevices,
    useResource,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import {
    DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH,
    DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH,
    type DeployCredential,
    type DeployCredentialProbe,
    type DeployCredentialProvider
} from '../contracts/domain';

import { api } from './api';
import { formatSince, PROVIDER_LABELS } from './format';

const PROVIDER_OPTIONS: readonly { value: DeployCredentialProvider; label: string; title: string }[] = [
    { value: 'dokploy', label: 'Dokploy', title: 'Une instance Dokploy : son adresse et une clé d’API' },
    { value: 'github', label: 'GitHub', title: 'Un jeton GitHub, pour lancer des workflows GitHub Actions' }
];

/** Par où le serveur joint une instance Dokploy. */
type Route = 'direct' | 'device';

const ROUTE_OPTIONS: readonly { value: Route; label: string; title: string }[] = [
    { value: 'direct', label: 'Direct', title: 'Le serveur joint l’instance lui-même, sur Internet' },
    {
        value: 'device',
        label: 'Par un appareil',
        title: 'L’agent d’un de vos appareils joint l’instance depuis la machine, même si elle n’écoute que sur elle'
    }
];

const loadDevices = () => api.send('deploy.credentialDevices', {}).then((res) => res.devices);

/** Le formulaire ouvert : un accès existant, ou un nouveau. */
type Editing = { credential: DeployCredential | null } | null;

/** Le compte rendu d'un essai réussi ; un refus passe par le bandeau d'erreur. */
const probeText = (probe: DeployCredentialProbe): string => `${probe.message} Réponse en ${probe.elapsedMs} ms.`;

/**
 * Les accès de l'espace, Dokploy et GitHub : le panneau de l'onglet « Sources »
 * des réglages de la feature. Mêmes formes que la liste des canaux de la
 * section Notifications (rangées, dialogue empilé, confirmation), d'où
 * `settingsStyles`.
 *
 * Un secret n'est jamais relu : le champ reste vide à la ré-ouverture, et vide
 * veut dire « garder celui en place ». L'adresse d'une instance Dokploy est
 * obligatoire ; jointe par un appareil, c'est celle que voit la machine. Le
 * fournisseur d'un accès ne change plus après sa création.
 * Autonome : il suit `deploy.list`, qu'un accès retiré rend orpheline.
 */
export default function CredentialsPanel({ canWrite }: SettingsPanelProps) {
    const { data: credentials, error: loadError } = useResource(
        'deploy.list',
        () => api.send('deploy.credentialList', {}).then((res) => res.credentials),
        'Impossible de charger les accès.'
    );

    /** Le nom des appareils de l'espace, pour dire par lequel passe un accès. */
    const { devices } = useDevices();

    const [editing, setEditing] = useState<Editing>(null);
    const [provider, setProvider] = useState<DeployCredentialProvider>('dokploy');
    const [label, setLabel] = useState('');
    const [baseUrl, setBaseUrl] = useState('');
    const [route, setRoute] = useState<Route>('direct');
    const [deviceId, setDeviceId] = useState('');
    const [secret, setSecret] = useState('');
    const [busy, setBusy] = useState(false);
    /** Le refus du formulaire, montré dans son dialogue ; `error`, celui d'un retrait, sous la liste. */
    const [formError, setFormError] = useState<ErrorNoteInput | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /** L'essai en cours : celui d'une rangée, ou celui du formulaire. */
    const [testing, setTesting] = useState<number | 'form' | null>(null);
    /** La réussite d'un essai de rangée, sous la liste. */
    const [status, setStatus] = useState<string | null>(null);
    /** Celle de l'essai du formulaire, qui ne vaut que pour les champs essayés. */
    const [formStatus, setFormStatus] = useState<{ draft: string; text: string } | null>(null);

    /** Un accès qui change touche la liste (cible orpheline) et la fiche ouverte (« accès retiré »). */
    const changed = () => invalidate('deploy.list', 'deploy.detail');

    const openForm = (credential: DeployCredential | null) => {
        setEditing({ credential });
        setProvider(credential?.provider ?? 'dokploy');
        setLabel(credential?.label ?? '');
        setBaseUrl(credential?.baseUrl ?? '');
        setRoute(credential?.deviceId ? 'device' : 'direct');
        setDeviceId(credential?.deviceId ?? '');
        setSecret('');
        setFormError(null);
        setFormStatus(null);
        setError(null);
    };

    /** L'adresse et l'appareil saisis, ou `null` après avoir dit ce qui manque. */
    const draftRoute = (): { baseUrl: string | null; deviceId: string | null } | null => {
        if (provider !== 'dokploy') return { baseUrl: null, deviceId: null };
        // Un service auto-hébergé sans adresse n'est pas adressable.
        if (!baseUrl.trim()) {
            setFormError({ message: 'Cette instance a besoin de l’adresse de son API.', code: 'validation' });
            return null;
        }
        if (route === 'device' && !deviceId) {
            setFormError({ message: 'Choisissez l’appareil par lequel joindre cette instance.', code: 'validation' });
            return null;
        }
        return { baseUrl: baseUrl.trim(), deviceId: route === 'device' ? deviceId : null };
    };

    /** Un accès neuf sans secret : le dire plutôt que l'envoyer. */
    const missingSecret = (): boolean => {
        if (editing?.credential || secret.trim()) return false;
        setFormError({
            message:
                provider === 'github'
                    ? 'Un accès sans jeton ne sert à rien.'
                    : 'Un accès sans clé d’API ne sert à rien.',
            code: 'validation'
        });
        return true;
    };

    /** Les champs qu'un essai éprouve : sa réussite s'efface dès que l'un d'eux change. */
    const draftKey = JSON.stringify([provider, baseUrl.trim(), route, deviceId, secret.trim()]);

    const submit = async () => {
        if (busy || !label.trim()) return;
        const target = draftRoute();
        if (!target || missingSecret()) return;
        const existing = editing?.credential ?? null;

        setBusy(true);
        setFormError(null);
        try {
            if (existing) {
                await api.send('deploy.credentialUpdate', {
                    credentialId: existing.id,
                    label: label.trim(),
                    ...target,
                    // Champ vide = inchangé : le serveur ne nous l'a jamais rendu.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await api.send('deploy.credentialAdd', {
                    provider,
                    label: label.trim(),
                    ...target,
                    secret: secret.trim()
                });
            }
            setEditing(null);
            changed();
        } catch (e) {
            setFormError(errorNote(e, 'L’accès n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    /** Essaie les champs du formulaire ; un secret laissé vide reprend celui de l'accès ouvert. */
    const testForm = async () => {
        if (testing !== null) return;
        const target = draftRoute();
        if (!target || missingSecret()) return;
        const existing = editing?.credential ?? null;
        const tried = draftKey;
        setTesting('form');
        setFormError(null);
        setFormStatus(null);
        try {
            const { probe } = await api.send('deploy.credentialTest', {
                ...(existing ? { credentialId: existing.id } : {}),
                provider,
                ...target,
                ...(secret.trim() ? { secret: secret.trim() } : {})
            });
            if (probe.ok) setFormStatus({ draft: tried, text: probeText(probe) });
            else setFormError({ message: probe.message, code: 'conflict' });
        } catch (e) {
            setFormError(errorNote(e, 'L’essai n’a pas pu être lancé.'));
        } finally {
            setTesting(null);
        }
    };

    /** Essaie un accès tel qu'enregistré : sa clé, son adresse, son appareil. */
    const testSaved = async (credential: DeployCredential) => {
        if (testing !== null) return;
        setTesting(credential.id);
        setStatus(null);
        setError(null);
        try {
            const { probe } = await api.send('deploy.credentialTest', {
                credentialId: credential.id,
                provider: credential.provider,
                baseUrl: credential.baseUrl,
                deviceId: credential.deviceId
            });
            if (probe.ok) setStatus(`« ${credential.label} » : ${probeText(probe)}`);
            else setError({ message: `« ${credential.label} » : ${probe.message}`, code: 'conflict' });
        } catch (e) {
            setError(errorNote(e, 'L’essai n’a pas pu être lancé.'));
        } finally {
            setTesting(null);
        }
    };

    /** La confirmation nomme ce que le retrait va couper, avant de cliquer. */
    const askRemove = (credential: DeployCredential) => {
        setConfirm({
            title: `Retirer « ${credential.label} » ?`,
            description:
                credential.useCount === 0
                    ? 'Aucune cible ne le désigne : son retrait ne change rien à ce qui tourne.'
                    : credential.useCount === 1
                      ? '1 cible le désigne encore et cessera d’être déployable, jusqu’à en désigner un autre.'
                      : `${credential.useCount} cibles le désignent encore et cesseront d’être déployables, jusqu’à en désigner un autre.`,
            confirmLabel: 'Retirer l’accès',
            onConfirm: () =>
                void (async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        await api.send('deploy.credentialRemove', { credentialId: credential.id });
                        changed();
                    } catch (e) {
                        setError(errorNote(e, 'Le retrait a échoué.'));
                    } finally {
                        setBusy(false);
                    }
                })()
        });
    };

    return (
        <div className={shell.section}>
            {credentials === null && !loadError && <p className={shell.empty}>Chargement…</p>}
            {credentials?.length === 0 && (
                <p className={shell.empty}>
                    {canWrite
                        ? 'Aucun accès. Déclarez une instance Dokploy (adresse + clé d’API) ou un jeton GitHub pour pouvoir déclarer une cible.'
                        : 'Aucun accès. Un membre disposant du droit d’écriture peut en déclarer un.'}
                </p>
            )}

            <div className={shell.channelList}>
                {(credentials ?? []).map((c) => (
                    <div key={c.id} className={shell.channelRow}>
                        <span className={`icon icon-key ${shell.channelIcon}`} aria-hidden='true' />
                        <span className={shell.channelText}>
                            <span className={shell.channelLabel}>{c.label}</span>
                            <span className={shell.channelMeta}>
                                {c.provider === 'github'
                                    ? 'GitHub Actions'
                                    : [
                                          PROVIDER_LABELS[c.provider],
                                          c.baseUrl ?? 'instance inconnue',
                                          c.deviceId &&
                                              `par « ${devices.find((d) => d.id === c.deviceId)?.name ?? 'un appareil'} »`
                                      ]
                                          .filter(Boolean)
                                          .join(' · ')}
                            </span>
                            {c.unreachable && (
                                <span className={shell.errorText}>
                                    Injoignable {formatSince(c.unreachable.since)}
                                    {c.unreachable.error ? ` : ${c.unreachable.error}` : ''}
                                </span>
                            )}
                        </span>
                        <span
                            className={`${shell.channelUsage} ${c.useCount === 0 ? shell.channelUsageIdle : ''}`}
                            title={
                                c.useCount === 0
                                    ? 'Désigné par aucune cible'
                                    : `Désigné par ${c.useCount} cible${c.useCount > 1 ? 's' : ''}`
                            }
                        >
                            {c.useCount === 0 ? 'inutilisé' : `${c.useCount}×`}
                        </span>
                        {canWrite && (
                            <span className={shell.channelActions}>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Tester cet accès : une lecture minimale avec sa clé'
                                    aria-label={`Tester ${c.label}`}
                                    disabled={busy || testing !== null}
                                    onClick={() => void testSaved(c)}
                                >
                                    <span className={`icon ${testing === c.id ? 'icon-spinner' : 'icon-play'}`} />
                                </button>
                                <button
                                    type='button'
                                    className={shell.rowAction}
                                    title='Modifier cet accès'
                                    aria-label={`Modifier ${c.label}`}
                                    disabled={busy}
                                    onClick={() => openForm(c)}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                                <button
                                    type='button'
                                    className={`${shell.rowAction} ${shell.rowActionDanger}`}
                                    title='Retirer cet accès'
                                    aria-label={`Retirer ${c.label}`}
                                    disabled={busy}
                                    onClick={() => askRemove(c)}
                                >
                                    <span className='icon icon-trash' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}
            </div>

            {status && <p className={shell.notice}>{status}</p>}
            <ErrorNote note={error ?? loadError} />

            {canWrite && (
                <div className={shell.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={() => openForm(null)}>
                        Ajouter un accès
                    </Button>
                </div>
            )}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing?.credential ? 'Modifier l’accès' : 'Nouvel accès'}
                description='Il servira à toutes les cibles de déploiement de cet espace.'
                width={520}
                onSubmit={submit}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            onClick={() => void testForm()}
                            disabled={busy || testing !== null}
                            title='Une lecture minimale chez le fournisseur, avec la clé saisie ou celle en place'
                        >
                            {testing === 'form' ? 'Essai…' : 'Tester'}
                        </Button>
                        <Button variant='secondary' onClick={() => setEditing(null)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={submit} disabled={busy || !label.trim()}>
                            {busy ? 'Enregistrement…' : 'Enregistrer'}
                        </Button>
                    </>
                }
            >
                <div className={shell.section}>
                    {!editing?.credential && (
                        <div className={shell.field}>
                            <span className={shell.sectionLabel}>Fournisseur</span>
                            <SegmentedControl
                                value={provider}
                                options={PROVIDER_OPTIONS}
                                onChange={setProvider}
                                aria-label='Fournisseur de l’accès'
                            />
                        </div>
                    )}

                    <label className={shell.field}>
                        <span className={shell.sectionLabel}>Nom de l’accès</span>
                        <TextInput
                            data-autofocus
                            value={label}
                            maxLength={DEPLOY_CREDENTIAL_LABEL_MAX_LENGTH}
                            placeholder={provider === 'github' ? 'GitHub, mon organisation' : 'Dokploy, production'}
                            onChange={(e) => setLabel(e.target.value)}
                        />
                    </label>

                    {provider === 'dokploy' && (
                        <>
                            <div className={shell.field}>
                                <span className={shell.sectionLabel}>Chemin</span>
                                <SegmentedControl
                                    value={route}
                                    options={ROUTE_OPTIONS}
                                    onChange={setRoute}
                                    aria-label='Chemin vers l’instance'
                                />
                                <span className={shell.fieldHint}>
                                    {ROUTE_OPTIONS.find((o) => o.value === route)?.title}.
                                </span>
                            </div>

                            {route === 'device' && (
                                <label className={shell.field}>
                                    <span className={shell.sectionLabel}>Appareil</span>
                                    <DeviceRelayField value={deviceId} onChange={setDeviceId} load={loadDevices} />
                                    <span className={shell.fieldHint}>
                                        L’agent de l’appareil joint l’instance de son côté : elle n’a pas besoin d’être
                                        sur Internet. Hors ligne, l’instance est injoignable jusqu’à son retour.
                                    </span>
                                </label>
                            )}

                            <label className={shell.field}>
                                <span className={shell.sectionLabel}>Adresse de l’instance</span>
                                <TextInput
                                    value={baseUrl}
                                    placeholder={
                                        route === 'device' ? 'http://127.0.0.1:3000' : 'https://dokploy.exemple.fr'
                                    }
                                    onChange={(e) => setBaseUrl(e.target.value)}
                                />
                                {route === 'device' && (
                                    <span className={shell.fieldHint}>
                                        L’adresse telle que l’appareil la voit : <strong>http://127.0.0.1:3000</strong>{' '}
                                        pour un Dokploy qui n’écoute que sur la machine.
                                    </span>
                                )}
                            </label>
                        </>
                    )}

                    <label className={shell.field}>
                        <span className={shell.sectionLabel}>
                            {provider === 'github'
                                ? editing?.credential
                                    ? 'Nouveau jeton (facultatif)'
                                    : 'Jeton GitHub'
                                : editing?.credential
                                  ? 'Nouvelle clé d’API (facultatif)'
                                  : 'Clé d’API'}
                        </span>
                        {/* Un secret se relit une fois à la saisie, jamais après. */}
                        <TextInput
                            type='password'
                            enableShowHideButton
                            value={secret}
                            maxLength={DEPLOY_CREDENTIAL_SECRET_MAX_LENGTH}
                            placeholder={provider === 'github' ? 'github_pat_…' : 'clé d’API'}
                            onChange={(e) => setSecret(e.target.value)}
                        />
                        {editing?.credential ? (
                            <span className={shell.fieldHint}>
                                Laissez vide pour conserver le secret en place : il n’est jamais renvoyé.
                            </span>
                        ) : (
                            provider === 'github' && (
                                <span className={shell.fieldHint}>
                                    Un jeton à grain fin, limité aux dépôts à déployer : Actions en lecture et écriture,
                                    Contents en lecture. Il ne sert qu’aux déploiements, pas au suivi des dépôts de la
                                    fonctionnalité Git.
                                </span>
                            )
                        )}
                    </label>

                    {formStatus?.draft === draftKey && <p className={shell.notice}>{formStatus.text}</p>}
                    <ErrorNote note={formError} />
                </div>
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
