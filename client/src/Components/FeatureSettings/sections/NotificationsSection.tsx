import { useCallback, useEffect, useRef, useState } from 'react';
import {
    NOTIFICATION_LABEL_MAX,
    NOTIFICATION_TARGET_MAX,
    type NotificationChannel,
    type NotificationChannelInput,
    type NotificationChannelKind,
    type NotificationFeature
} from '@deveye/types';
import { MAIL_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { MailClientProvider } from '@deveye/types/sdk/client';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import SelectInput from '@/Components/SelectInput';
import Term from '@/Components/Term';
import TextInput from '@/Components/TextInput';
import { moduleClientProvider } from '@/sdk/registry';
import { useCurrentUser } from '@/stores/currentUser';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { accessibleWorkspaceName, goToItemSettings } from '../goToHome';

import { isSystemScope, routeItemId, targetInfo, type ShellScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Où partent les alertes : les canaux de la fonctionnalité (ses sources) et ce
 * qui y est relié. Cocher relève de `<feature>: write` ; ajouter, corriger ou
 * supprimer un canal relève du champ `channels` du grant, sans lequel le
 * serveur ne rend pas la destination. À l'échelle de la fonctionnalité : la
 * liste et sa gestion, sans cases (sauf émetteur sans éléments, qui n'a pas
 * d'échelle plus fine). À l'échelle d'un élément : les cases, et « Gérer les
 * canaux » qui ouvre les réglages de la fonctionnalité par-dessus.
 */

const KIND_LABEL: Record<NotificationChannelKind, string> = {
    email: 'E-mail',
    webhook: 'Webhook',
    discord: 'Discord'
};

/**
 * Icônes prises dans `Styles/icons.css` seulement : une classe absente se rend
 * en carré vide, que rien n'attrape (`icon-*` est une chaîne, pas une clé).
 */
const KIND_ICON: Record<NotificationChannelKind, string> = {
    email: 'mail',
    webhook: 'chevrons-right',
    discord: 'users'
};

/**
 * Le brouillon d'un canal neuf. L'e-mail d'abord : c'est le canal que la
 * plupart des gens attendent. Sans module Mail pour l'expédier, Discord.
 */
function emptyDraft(mailAvailable: boolean): NotificationChannelInput {
    return { kind: mailAvailable ? 'email' : 'discord', label: '', target: '', mailAccountId: null };
}

/** Un expéditeur prêt, tel que le module Mail le rend : ouvert et actif, déjà filtré. */
type MailSender = Awaited<ReturnType<MailClientProvider['listSenders']>>[number];

interface Props {
    scope: ShellScope;
    /** Ouvre les réglages de la fonctionnalité sur cet onglet ; fourni à
     *  l'échelle d'un élément seulement. */
    onManageChannels?: () => void;
}

export default function NotificationsSection({ scope, onManageChannels }: Props) {
    const feature = scope.feature as NotificationFeature;
    const descriptor = targetInfo(scope.feature);
    const permissions = useWorkspacePermissions();
    const isAdmin = useCurrentUser()?.role === 'admin';
    // La cible système : un admin, dans un espace qu'il possède, règle tout.
    const managesSystem = isAdmin && permissions.isOwner;
    const canManage = isSystemScope(scope) ? managesSystem : permissions.canChannels(scope.feature);
    /** Le module Mail par son contrat client ; `undefined` sans le module, et
     *  pas de canal e-mail alors. */
    const mail = moduleClientProvider<MailClientProvider>(MAIL_CLIENT_PROVIDER);

    const channelsVersion = useResourceVersion('notify.channelList');
    const routeVersion = useResourceVersion('notify.routeGet');

    const [channels, setChannels] = useState<NotificationChannel[]>([]);
    /**
     * Les canaux de la route qui vivent dans un autre espace (élément projeté) :
     * les omettre afficherait « aucun canal » sur un élément qui prévient.
     */
    const [foreign, setForeign] = useState<NotificationChannel[]>([]);
    /**
     * Cette route se règle-t-elle d'ici ? Faux sur un élément projeté : ses
     * canaux appartiennent à son espace d'origine, le serveur refuse d'ici.
     */
    const [managedHere, setManagedHere] = useState(true);
    /** L'espace où la route se règle : le domicile de l'élément. */
    const [homeWorkspaceId, setHomeWorkspaceId] = useState<number | null>(null);
    const [senders, setSenders] = useState<readonly MailSender[]>([]);
    const [selected, setSelected] = useState<number[]>([]);
    const [draft, setDraft] = useState<NotificationChannelInput | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** Le dialogue de compte Mail, monté à la demande par le « + » du formulaire. */
    const [mailAdd, setMailAdd] = useState(false);
    /** Les boîtes connues à l'ouverture du dialogue Mail : celle qui apparaît
     *  ensuite vient d'être créée pour ce canal, et se sélectionne toute seule. */
    const knownMailIds = useRef<Set<number> | null>(null);

    // Régler où une fonctionnalité prévient est un réglage de cette
    // fonctionnalité : son droit d'écriture suffit. Jamais sur un élément
    // projeté, dont les canaux vivent ailleurs.
    const canRoute =
        (isSystemScope(scope) ? managesSystem : permissions.canFeature(scope.feature, 'write')) && managedHere;

    const itemId = routeItemId(scope) ?? undefined;

    /**
     * La sélection se rend-elle ici ? Sur un élément toujours ; à l'échelle de
     * la fonctionnalité quand elle prévient en son nom propre, sinon cette
     * échelle ne fait que lister les sources disponibles.
     */
    const showSelection = scope.kind === 'item' || descriptor.featureRoute;
    /** Les éléments cochent leurs propres canaux : à dire ici, où l'on les déclare. */
    const itemsRouteThemselves = scope.kind === 'feature' && descriptor.hasItems && descriptor.featureRoute !== true;
    const itemsRouteToo =
        scope.kind === 'feature' && descriptor.hasItems && descriptor.featureRoute && descriptor.featureRouteHint;

    const reload = useCallback(async () => {
        if (!showSelection) {
            // Rien à router à cette échelle : la route n'est même pas demandée.
            const list = await ws.send('notify.channelList', { feature });
            setChannels(list.channels);
            setForeign([]);
            setManagedHere(true);
            setSelected([]);
            return;
        }
        const [list, route] = await Promise.all([
            ws.send('notify.channelList', { feature }),
            ws.send('notify.routeGet', { feature, itemId })
        ]);
        setChannels(list.channels);
        setForeign(route.foreign);
        setManagedHere(route.managedHere);
        setHomeWorkspaceId(route.homeWorkspaceId);
        setSelected(route.route.channelIds);
    }, [feature, itemId, showSelection]);

    useEffect(() => {
        void reload().catch(() => setStatus('Chargement impossible.'));
    }, [reload, channelsVersion, routeVersion]);

    // Les expéditeurs ne servent qu'au formulaire d'ajout, donc à qui peut
    // ajouter. Le module les rend déjà filtrés (comptes « open »).
    useEffect(() => {
        if (!canManage || !mail) return;
        void mail
            .listSenders()
            .then(setSenders)
            .catch(() => undefined);
    }, [canManage, mail]);

    async function run(action: () => Promise<void>, failure: string): Promise<void> {
        setBusy(true);
        setStatus(null);
        try {
            await action();
        } catch {
            setStatus(failure);
        } finally {
            setBusy(false);
        }
    }

    const toggleChannel = (id: number, on: boolean): void => {
        const next = on ? [...selected, id] : selected.filter((c) => c !== id);
        setSelected(next);
        void run(async () => {
            await ws.send('notify.routeSet', { feature, itemId, channelIds: next });
            invalidate('notify.routeGet');
        }, 'Enregistrement impossible.');
    };

    const startAdd = (): void => {
        setEditing(null);
        setDraft(emptyDraft(mail !== undefined));
    };

    const saveDraft = (): void => {
        if (!draft || !draft.label.trim()) return;
        void run(async () => {
            if (editing === null) {
                const created = await ws.send('notify.channelAdd', { ...draft, feature });
                /* Créé depuis un élément, le canal est là pour lui : il part coché,
                   sans quoi l'utilisateur croit être prévenu et ne l'est pas. */
                if (showSelection && canRoute) {
                    const next = [...selected, created.channel.id];
                    setSelected(next);
                    await ws.send('notify.routeSet', { feature, itemId, channelIds: next });
                    invalidate('notify.routeGet');
                }
            } else {
                await ws.send('notify.channelUpdate', { ...draft, id: editing, enabled: true });
            }
            setDraft(null);
            setEditing(null);
            invalidate('notify.channelList');
        }, 'Enregistrement impossible.');
    };

    /** La confirmation nomme ce qui va cesser de prévenir : les cibles sont
     *  demandées avant de l'afficher. */
    const askDelete = (channel: NotificationChannel): void => {
        void run(async () => {
            const usage = await ws.send('notify.channelUsage', { id: channel.id });
            setConfirm({
                title: `Supprimer « ${channel.label} » ?`,
                description:
                    usage.routes.length === 0 ? (
                        <>Aucune fonctionnalité ne s’en sert : sa suppression ne change rien à ce qui est envoyé.</>
                    ) : (
                        <>
                            <span>Ces cibles cesseront de prévenir par ce canal :</span>
                            <ul className={styles.usageList}>
                                {usage.routes.map((r) => (
                                    <li key={`${r.feature}-${r.itemId ?? 0}`}>
                                        {targetInfo(r.feature).label}
                                        {r.itemId !== null && ` · ${r.itemLabel ?? `élément #${r.itemId}`}`}
                                    </li>
                                ))}
                            </ul>
                        </>
                    ),
                confirmLabel: 'Supprimer le canal',
                onConfirm: () =>
                    void run(async () => {
                        await ws.send('notify.channelDelete', { id: channel.id });
                        invalidate('notify.channelList');
                    }, 'Suppression impossible.')
            });
        }, 'Lecture des usages impossible.');
    };

    const testChannel = (channel: NotificationChannel): void =>
        void run(async () => {
            const res = await ws.send('notify.channelTest', { id: channel.id });
            setStatus(
                res.sent ? `Message d’essai envoyé sur « ${channel.label} ».` : (res.error ?? 'Envoi impossible.')
            );
        }, 'Envoi impossible.');

    const testRoute = (): void =>
        void run(async () => {
            const res = await ws.send('notify.routeTest', { feature, itemId });
            setStatus(res.sent ? 'Message d’essai envoyé.' : (res.error ?? 'Envoi impossible.'));
        }, 'Envoi impossible.');

    const startEdit = (channel: NotificationChannel): void => {
        setEditing(channel.id);
        setDraft({
            kind: channel.kind,
            label: channel.label,
            target: channel.target,
            mailAccountId: channel.mailAccountId
        });
    };

    const openMailAdd = (): void => {
        knownMailIds.current = new Set(senders.map((s) => s.id));
        setMailAdd(true);
    };

    /** Le dialogue Mail s'est refermé sans boîte nouvelle. */
    const onMailAddClose = useCallback((): void => {
        setMailAdd(false);
        knownMailIds.current = null;
    }, []);

    /**
     * Une boîte est sortie du dialogue Mail : relire les expéditeurs et adopter
     * la nouvelle. Une boîte au palier gardé n'est pas un expéditeur : rien à
     * adopter alors.
     */
    const onMailAddSaved = useCallback((): void => {
        setMailAdd(false);
        if (!mail) return;
        void mail
            .listSenders()
            .then((list) => {
                setSenders(list);
                const fresh = list.find((s) => !knownMailIds.current?.has(s.id));
                knownMailIds.current = null;
                if (fresh) setDraft((prev) => (prev ? { ...prev, mailAccountId: fresh.id } : prev));
            })
            .catch(() => undefined);
    }, [mail]);

    return (
        <div className={styles.section}>
            {descriptor.notificationsHint && <p className={styles.sectionHint}>{descriptor.notificationsHint}</p>}

            {/* À cette échelle on déclare les sources ; le choix se fait sur
                chaque élément, et le dire évite de chercher des cases ici. */}
            {itemsRouteThemselves && (
                <p className={styles.sectionHint}>
                    Les canaux déclarés ici sont les sources disponibles : chaque {descriptor.itemNoun ?? 'élément'}{' '}
                    choisit les siens dans ses propres réglages.
                </p>
            )}

            {/* Les éléments ont leurs cases ; celles d'ici portent ce qui ne
                vise aucun d'eux en particulier. */}
            {itemsRouteToo && (
                <p className={styles.sectionHint}>
                    Chaque {descriptor.itemNoun ?? 'élément'} coche ses canaux dans ses propres réglages. Les cases
                    ci-dessous valent pour ce que {descriptor.label} dit en son nom propre :{' '}
                    {descriptor.featureRouteHint}
                </p>
            )}

            {showSelection && channels.length > 0 && (
                <span className={styles.sectionLabel}>
                    Cochez les canaux vers lesquels{' '}
                    {scope.kind === 'item' ? `ce ${descriptor.itemNoun ?? 'élément'}` : descriptor.label} écrit.{' '}
                    {itemsRouteToo
                        ? `Sans aucun coché, ces avis suivent les canaux cochés par les ${descriptor.itemNoun ?? 'élément'}s concernés.`
                        : 'Sans aucun coché, rien ne part.'}
                </span>
            )}

            <div className={styles.channelList}>
                {channels.length === 0 && foreign.length === 0 && (
                    // L'état vide porte le geste : le « + » ouvre les réglages de
                    // la fonctionnalité, même sans le droit de gérer (on y lira
                    // sans ajouter).
                    <div className={styles.emptyRow}>
                        <span>
                            {`Aucun canal pour ${descriptor.label} : rien ne vous préviendra.`}
                            {canManage && managedHere
                                ? ' Ajoutez-en un : il sera coché pour vous.'
                                : ' Demandez à un gestionnaire de l’espace d’en déclarer un.'}
                        </span>
                        {canManage && managedHere && (
                            <Button variant='secondary' icon='plus' disabled={busy} onClick={startAdd}>
                                Ajouter un canal
                            </Button>
                        )}
                    </div>
                )}

                {channels.map((channel) => (
                    <div key={channel.id} className={styles.channelRow}>
                        {showSelection && (
                            <Checkbox
                                checked={selected.includes(channel.id)}
                                disabled={!canRoute || busy}
                                onChange={(on) => toggleChannel(channel.id, on)}
                                aria-label={`Envoyer vers ${channel.label}`}
                            />
                        )}
                        <span className={`icon icon-${KIND_ICON[channel.kind]} ${styles.channelIcon}`} />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>
                                {channel.label}
                                {!channel.enabled && <span className={styles.channelOff}>éteint</span>}
                                {!channel.ready && <span className={styles.channelBroken}>ne partira pas</span>}
                            </span>
                            {/* La cible seule sur la ligne tronquable : une URL de
                                webhook est longue par nature. */}
                            <span className={styles.channelMeta}>
                                {KIND_LABEL[channel.kind]}
                                {channel.target && ` · ${channel.target}`}
                            </span>
                        </span>

                        {/* « Utilisé par N » hors de la ligne tronquable, sinon la
                            pastille n'apparaissait jamais. */}
                        <span
                            className={`${styles.channelUsage} ${channel.usageCount === 0 ? styles.channelUsageIdle : ''}`}
                            title={
                                channel.usageCount === 0
                                    ? 'Aucune cible n’écrit vers ce canal'
                                    : `${channel.usageCount} cible(s) écrivent vers ce canal`
                            }
                        >
                            {channel.usageCount === 0 ? 'inutilisé' : `${channel.usageCount}×`}
                        </span>
                        {/* Gestion à l'échelle de la fonctionnalité seulement :
                            depuis un élément on choisit, on ne corrige pas ;
                            « Gérer les canaux » mène au bon endroit. */}
                        {scope.kind === 'feature' && canManage && (
                            <span className={styles.channelActions}>
                                {/* Icônes seules : trois boutons libellés étouffaient
                                    la ligne. */}
                                <button
                                    type='button'
                                    className={styles.rowAction}
                                    title='Envoyer un message d’essai'
                                    aria-label={`Tester ${channel.label}`}
                                    disabled={busy}
                                    onClick={() => testChannel(channel)}
                                >
                                    <span className='icon icon-play' />
                                </button>
                                <button
                                    type='button'
                                    className={styles.rowAction}
                                    title='Modifier ce canal'
                                    aria-label={`Modifier ${channel.label}`}
                                    disabled={busy}
                                    onClick={() => startEdit(channel)}
                                >
                                    <span className='icon icon-edit' />
                                </button>
                                <button
                                    type='button'
                                    className={`${styles.rowAction} ${styles.rowActionDanger}`}
                                    title='Supprimer ce canal'
                                    aria-label={`Supprimer ${channel.label}`}
                                    disabled={busy}
                                    onClick={() => askDelete(channel)}
                                >
                                    <span className='icon icon-trash' />
                                </button>
                            </span>
                        )}
                    </div>
                ))}

                {/* Ceux d'un autre espace : ni case ni action, on ne règle pas
                    d'ici ce qui appartient à la maison. */}
                {foreign.map((channel) => (
                    <div key={`f${channel.id}`} className={`${styles.channelRow} ${styles.channelRowForeign}`}>
                        <span className={styles.foreignMark} aria-hidden='true'>
                            <span className='icon icon-lock' />
                        </span>
                        <span className={`icon icon-${KIND_ICON[channel.kind]} ${styles.channelIcon}`} />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>{channel.label}</span>
                            <span className={styles.channelMeta}>
                                Réglé dans l’espace d’origine : vous ne pouvez ni le lire ni le modifier d’ici.
                            </span>
                        </span>
                    </div>
                ))}
            </div>

            {!managedHere && (
                <p className={styles.sectionHint}>
                    Ce {descriptor.itemNoun ?? 'élément'} vient d’un autre espace : ses canaux s’y règlent, et
                    l’ordonnanceur qui le surveille y tourne. Un canal ajouté ici ne le concernerait pas.
                    {/* Si l'appelant est membre de l'espace d'origine, on l'y
                        emmène, réglages rouverts sur ce même onglet. */}
                    {scope.kind === 'item' &&
                        homeWorkspaceId !== null &&
                        accessibleWorkspaceName(homeWorkspaceId) !== null && (
                            <>
                                {' '}
                                <button
                                    type='button'
                                    className={styles.jumpBtn}
                                    onClick={() =>
                                        goToItemSettings(homeWorkspaceId, scope.feature, scope.itemId, 'notifications')
                                    }
                                >
                                    Régler dans « {accessibleWorkspaceName(homeWorkspaceId)} »
                                </button>
                            </>
                        )}
                </p>
            )}

            {scope.kind === 'feature' && canManage && channels.length > 0 && (
                <div className={styles.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={startAdd}>
                        Ajouter un canal
                    </Button>
                    {/* « Tester cet envoi » éprouve une **sélection** : elle
                        n'existe à cette échelle que si la fonctionnalité prévient
                        en son nom propre. Chaque canal garde son essai sur sa ligne. */}
                    {showSelection && (
                        <Button variant='ghost' icon='play' disabled={busy} onClick={testRoute}>
                            Tester cet envoi
                        </Button>
                    )}
                </div>
            )}

            {/* À l'échelle d'un élément : tester **sa** route (le droit est
                celui du routage, pas de la gestion), et rejoindre l'endroit où
                les canaux se gèrent. */}
            {scope.kind === 'item' && managedHere && (
                <div className={styles.sectionActions}>
                    {canManage && channels.length > 0 && (
                        <Button variant='secondary' icon='plus' disabled={busy} onClick={startAdd}>
                            Ajouter un canal
                        </Button>
                    )}
                    {canRoute && channels.length > 0 && (
                        <Button variant='ghost' icon='play' disabled={busy} onClick={testRoute}>
                            Tester cet envoi
                        </Button>
                    )}
                    {canManage && onManageChannels && (
                        <Button variant='ghost' icon='settings' disabled={busy} onClick={onManageChannels}>
                            Gérer les canaux
                        </Button>
                    )}
                </div>
            )}

            {/* L'ajout et la correction passent par un dialogue empilé, comme
                toutes les sources. */}
            <Dialog
                open={draft !== null}
                onClose={() => {
                    setDraft(null);
                    setEditing(null);
                }}
                title={editing === null ? 'Nouveau canal' : 'Modifier le canal'}
                description={`Une destination propre à ${descriptor.label} : ses alertes, et seulement les siennes, partent là.`}
                width={520}
                onSubmit={saveDraft}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            disabled={busy}
                            onClick={() => {
                                setDraft(null);
                                setEditing(null);
                            }}
                        >
                            Annuler
                        </Button>
                        <Button disabled={busy || draft === null || !draft.label.trim()} onClick={saveDraft}>
                            {editing === null ? 'Ajouter' : 'Enregistrer'}
                        </Button>
                    </>
                }
            >
                {draft !== null && (
                    <div className={styles.section}>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Type</span>
                            <SelectInput
                                value={draft.kind}
                                onChange={(e) =>
                                    setDraft({ ...draft, kind: e.target.value as NotificationChannelKind })
                                }
                            >
                                {/* Un canal e-mail n'existe qu'avec le module Mail ; un
                                    canal déjà déclaré garde son type affiché. */}
                                {(mail || draft.kind === 'email') && <option value='email'>E-mail</option>}
                                <option value='discord'>Discord : mise en page riche, suivi vivant</option>
                                <option value='webhook'>Webhook : POST JSON générique</option>
                            </SelectInput>
                            <span className={styles.fieldHint}>{KIND_HINT[draft.kind]}</span>
                            {!mail && (
                                <span className={styles.fieldHint}>
                                    Sans le module Mail, aucun canal e-mail : les alertes partent par Discord ou par{' '}
                                    <Term id='webhook'>webhook</Term>.
                                </span>
                            )}
                        </label>

                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Nom</span>
                            <TextInput
                                value={draft.label}
                                maxLength={NOTIFICATION_LABEL_MAX}
                                placeholder='Astreinte, #ops, Alertes production…'
                                data-autofocus
                                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                            />
                        </label>

                        {draft.kind === 'email' ? (
                            <>
                                <label className={styles.field}>
                                    <span className={styles.fieldLabel}>Compte expéditeur</span>
                                    <div className={styles.fieldWithAction}>
                                        <SelectInput
                                            value={draft.mailAccountId ?? ''}
                                            onChange={(e) =>
                                                setDraft({
                                                    ...draft,
                                                    mailAccountId: e.target.value ? Number(e.target.value) : null
                                                })
                                            }
                                        >
                                            <option value=''>Aucun</option>
                                            {senders.map((s) => (
                                                <option key={s.id} value={s.id}>
                                                    {s.label} ({s.address})
                                                </option>
                                            ))}
                                        </SelectInput>
                                        {/* Le vrai dialogue de la feature Mail,
                                            par-dessus ; la boîte créée est
                                            sélectionnée ici au retour. */}
                                        <Button
                                            variant='ghost'
                                            icon='plus'
                                            aria-label='Ajouter une boîte mail'
                                            title='Ajouter une boîte mail : elle sera sélectionnée ici une fois créée'
                                            disabled={busy || !mail}
                                            onClick={openMailAdd}
                                        />
                                    </div>
                                    <span className={styles.fieldHint}>
                                        {senders.length === 0
                                            ? 'Aucun compte mail « open » configuré : le « + » ci-contre en crée un.'
                                            : 'Seuls les comptes « open » peuvent envoyer sans intervention manuelle.'}
                                    </span>
                                </label>
                                <label className={styles.field}>
                                    <span className={styles.fieldLabel}>Destinataire</span>
                                    <TextInput
                                        type='email'
                                        value={draft.target}
                                        placeholder='Adresse du compte expéditeur'
                                        onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                                    />
                                    <span className={styles.fieldHint}>
                                        Laissez vide pour utiliser l’adresse du compte expéditeur.
                                    </span>
                                </label>
                            </>
                        ) : (
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>URL appelée en POST</span>
                                <TextInput
                                    value={draft.target}
                                    maxLength={NOTIFICATION_TARGET_MAX}
                                    placeholder='https://discord.com/api/webhooks/…'
                                    onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                                />
                                {draft.kind === 'discord' &&
                                    draft.target.trim() !== '' &&
                                    !looksLikeDiscord(draft.target) && (
                                        <span className={styles.warning}>
                                            Cette URL ne ressemble pas à un webhook Discord. Les embeds y partiront
                                            quand même, et un point d’entrée qui ne les attend pas les refusera :
                                            choisissez « Webhook » pour lui envoyer du texte.
                                        </span>
                                    )}
                            </label>
                        )}
                    </div>
                )}
            </Dialog>

            {status && <p className={styles.notice}>{status}</p>}

            {/* Le vrai dialogue de la feature Mail, offert par son contrat client
                et monté à la demande. */}
            {mail && <mail.AccountDialog open={mailAdd} onClose={onMailAddClose} onSaved={onMailAddSaved} />}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}

/**
 * Miroir client d'`isDiscordWebhook` (`Services/discord.ts`) : analysée, jamais
 * cherchée dans la chaîne (`includes('discord.com')` dirait oui à
 * `https://exemple.com/?ref=discord.com`). Un avertissement, pas un refus.
 */
function looksLikeDiscord(url: string): boolean {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        const known = host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com');
        return known && parsed.pathname.startsWith('/api/webhooks/');
    } catch {
        return false;
    }
}

const KIND_HINT: Record<NotificationChannelKind, string> = {
    email: 'Une boîte Mail « ouverte » de l’espace expédie le message.',
    webhook:
        'Le message lisible est répété dans « content » (Discord) et « text » (Slack), les champs structurés suivent pour un point d’entrée maison.',
    discord:
        'Mise en page riche (couleurs, champs), et pour le déploiement un seul message qui se met à jour du début à la fin.'
};
