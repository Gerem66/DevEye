import { useCallback, useEffect, useRef, useState } from 'react';
import {
    NOTIFICATION_LABEL_MAX,
    NOTIFICATION_TARGET_MAX,
    featureDescriptor,
    type MailAccount,
    type NotificationChannel,
    type NotificationChannelInput,
    type NotificationChannelKind,
    type NotificationFeature
} from '@deveye/types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { Dialog } from '@/Components/Dialog';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { OpenPopup } from '@/Components/Popup';
import SelectInput from '@/Components/SelectInput';
import TextInput from '@/Components/TextInput';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { accessibleWorkspaceName, goToItemSettings } from '../goToHome';
/* Le vrai dialogue de la feature Mail, jamais une copie réduite (le patron des
   dialogues de liaison des Projets). Chemins directs des deux côtés : ni lui ni
   ses imports ne passent par le baril `@/Components`, pas de cycle. */
import AccountPopup, { ACCOUNT_POPUP, type AccountPopupResult } from '@/Features/Mail/AccountPopup';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Où partent les alertes — **la liste des canaux de l'espace, et ce qui y est
 * relié**.
 *
 * ## Ce que ça remplace
 *
 * Cinq dialogues identiques réglant chacun deux cases à cocher : « par e-mail »
 * et « par webhook ». Le même salon Discord y était redéclaré cinq fois, une URL
 * à corriger se corrigeait cinq fois, et router deux bases vers deux
 * destinataires différents était impossible.
 *
 * Ici les destinations sont les **sources de la fonctionnalité** : chaque
 * émetteur a les siennes (091), déclarées dans ses réglages, comme un jeton
 * Dokploy est une source du Déploiement. On coche celles que la cible courante
 * doit servir. « Utilisé par N » dit immédiatement lesquelles portent tout le
 * trafic. La 087 les avait faites communes aux cinq émetteurs : on retrouvait
 * une même liste gérée depuis cinq endroits, l'inverse du patron des sources.
 *
 * ## Deux droits, deux moitiés d'écran
 *
 * Cocher relève de la fonctionnalité (`<feature>: write`). Ajouter, corriger ou
 * supprimer un canal relève de la gestion des canaux de CETTE fonctionnalité
 * (le champ `channels` de son grant de rôle, migration 093) : sans elle, la
 * destination elle-même n'est pas rendue par le serveur, on voit
 * « Astreinte · e-mail », on peut y router, on ne peut pas lire l'adresse.
 *
 * ## Deux échelles, deux gestes
 *
 * À l'échelle de la **fonctionnalité** : la liste de ses canaux (ses sources
 * disponibles) et leur gestion (ajouter, corriger, tester, supprimer). Pas de
 * cases à cocher : une sélection à cette échelle ne viserait aucun élément
 * nommable (092). À l'échelle d'un **élément** : les cases, directement
 * actives (cocher un ou plusieurs canaux est LE geste de cet écran), et le
 * bouton « Gérer les canaux » qui ouvre les réglages de la fonctionnalité
 * par-dessus (`onManageChannels`). L'interrupteur « Suivre la fonctionnalité »
 * a été retiré avec l'héritage : il grisait les cases par défaut, et l'écran
 * semblait interdire précisément ce qu'il servait à faire.
 *
 * Exception mécanique : un émetteur **sans éléments** (Sentinelle) garde ses
 * cases à l'échelle de la fonctionnalité — il n'a pas d'échelle plus fine.
 */

const KIND_LABEL: Record<NotificationChannelKind, string> = {
    email: 'E-mail',
    webhook: 'Webhook',
    discord: 'Discord'
};

/**
 * Icônes prises dans `Styles/icons.css`, et **seulement** là.
 *
 * Aucun jeu Discord ni « send » n'y existe : une classe absente se rend en
 * carré vide, que ni TypeScript ni le typage des modules CSS n'attrapent —
 * `icon-*` est une chaîne, pas une clé. D'où ce tableau explicite, relu contre
 * la feuille plutôt que deviné.
 */
const KIND_ICON: Record<NotificationChannelKind, string> = {
    email: 'mail',
    webhook: 'chevrons-right',
    discord: 'users'
};

const EMPTY_DRAFT: NotificationChannelInput = { kind: 'discord', label: '', target: '', mailAccountId: null };

interface Props {
    scope: SettingsScope;
    /**
     * Ouvre les réglages de la **fonctionnalité** sur cet onglet, fourni par
     * la coquille à l'échelle d'un élément seulement, où les canaux ne se
     * gèrent pas sur place.
     */
    onManageChannels?: () => void;
}

export default function NotificationsSection({ scope, onManageChannels }: Props) {
    const feature = scope.feature as NotificationFeature;
    const descriptor = featureDescriptor(scope.feature);
    const permissions = useWorkspacePermissions();
    const canManage = permissions.canChannels(scope.feature);
    // Le droit fin, pas `write` : c'est ce qui permet de confier le routage des
    // alertes sans confier la modification des services surveillés.

    const channelsVersion = useResourceVersion('notify.channelList');
    const routeVersion = useResourceVersion('notify.routeGet');

    const [channels, setChannels] = useState<NotificationChannel[]>([]);
    /**
     * Les canaux de la route qui vivent dans un **autre** espace.
     *
     * Le cas d'un élément projeté : ses destinations appartiennent à son
     * espace d'origine. Les omettre afficherait « aucun canal » sur un élément
     * qui prévient — précisément le mensonge que la projection devait éviter.
     */
    const [foreign, setForeign] = useState<NotificationChannel[]>([]);
    /**
     * Cette route se règle-t-elle d'ici ?
     *
     * Faux sur un élément projeté : ses canaux appartiennent à son espace
     * d'origine. Sans ce drapeau, l'écran offrait un interrupteur et un bouton
     * « Ajouter un canal » que le serveur refuse — un écran qui ment.
     */
    const [managedHere, setManagedHere] = useState(true);
    /** L'espace où la route se règle : le domicile de l'élément. */
    const [homeWorkspaceId, setHomeWorkspaceId] = useState<number | null>(null);
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [selected, setSelected] = useState<number[]>([]);
    const [draft, setDraft] = useState<NotificationChannelInput | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** Le dialogue de compte Mail, monté à la demande par le « + » du formulaire. */
    const [mailAdd, setMailAdd] = useState(false);
    /**
     * Les boîtes connues au moment d'ouvrir le dialogue Mail : celle qui
     * apparaît ensuite vient d'y être créée, et c'est pour ce canal-ci ; elle
     * se sélectionne donc toute seule au retour.
     */
    const knownMailIds = useRef<Set<number> | null>(null);

    /**
     * Le droit fin, pas `write` : c'est ce qui permet de confier le routage des
     * alertes sans confier la modification des services surveillés. Et jamais
     * sur un élément projeté, dont les canaux vivent ailleurs.
     */
    // Régler où une fonctionnalité prévient est un réglage de cette
    // fonctionnalité : son droit d'écriture suffit. L'étage de « droits fins »
    // qui distinguait le routage de l'écriture a été essayé puis retiré.
    const canRoute = permissions.canFeature(feature, 'write') && managedHere;

    const itemId = scope.kind === 'item' ? scope.itemId : undefined;

    /**
     * La sélection se rend-elle ici ? Sur un élément toujours ; à l'échelle de
     * la fonctionnalité seulement quand elle n'a pas d'éléments (Sentinelle) —
     * sinon cette échelle ne fait que lister les sources disponibles.
     */
    const showSelection = scope.kind === 'item' || !descriptor.hasItems;

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

    // Les comptes expéditeurs ne servent qu'au formulaire d'ajout, et seulement
    // à qui peut en ajouter : les demander sinon serait une requête pour un
    // champ que personne ne verra.
    useEffect(() => {
        if (!canManage) return;
        void ws
            .send('mail.accountList', {})
            .then((r) => setAccounts(r.accounts))
            .catch(() => undefined);
    }, [canManage]);

    /** Seuls les comptes « open » peuvent envoyer sans déverrouillage. */
    const openAccounts = accounts.filter((a) => a.securityTier === 'open' && a.enabled);

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

    const saveDraft = (): void => {
        if (!draft || !draft.label.trim()) return;
        void run(async () => {
            if (editing === null) await ws.send('notify.channelAdd', { ...draft, feature });
            else await ws.send('notify.channelUpdate', { ...draft, id: editing, enabled: true });
            setDraft(null);
            setEditing(null);
            invalidate('notify.channelList');
        }, 'Enregistrement impossible.');
    };

    /**
     * La confirmation nomme ce qui va cesser de prévenir.
     *
     * Les cibles sont demandées **avant** de l'afficher : « Êtes-vous sûr ? »
     * sans dire de quoi ne fait pas confirmer, il fait cliquer.
     */
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
                                        {featureDescriptor(r.feature).label}
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
        knownMailIds.current = new Set(accounts.map((a) => a.id));
        setMailAdd(true);
    };

    /** Retour du dialogue Mail : relire les boîtes, adopter celle qui vient de naître. */
    const onMailAddDone = useCallback((result: AccountPopupResult): void => {
        setMailAdd(false);
        // `saved` pour une connexion manuelle, `oauth-connected` pour un
        // consentement Google/Microsoft abouti puis simplement refermé.
        if (result !== 'saved' && result !== 'oauth-connected') {
            knownMailIds.current = null;
            return;
        }
        void ws
            .send('mail.accountList', {})
            .then((r) => {
                setAccounts(r.accounts);
                const fresh = r.accounts.find((a) => !knownMailIds.current?.has(a.id));
                knownMailIds.current = null;
                if (!fresh) return;
                if (fresh.securityTier === 'open' && fresh.enabled) {
                    setDraft((prev) => (prev ? { ...prev, mailAccountId: fresh.id } : prev));
                } else {
                    // Créée au palier gardé : sélectionnable nulle part ici, et
                    // le dire vaut mieux qu'un sélecteur qui l'ignore en silence.
                    setStatus('La boîte créée n’est pas au palier « ouvert » : elle ne peut pas expédier ces alertes.');
                }
            })
            .catch(() => undefined);
    }, []);

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>{WHEN[feature]}</p>

            {/* À cette échelle on déclare les sources ; le choix se fait sur
                chaque élément, et le dire évite de chercher des cases ici. */}
            {!showSelection && (
                <p className={styles.sectionHint}>
                    Les canaux déclarés ici sont les sources disponibles : chaque {descriptor.itemNoun ?? 'élément'}{' '}
                    choisit les siens dans ses propres réglages.
                </p>
            )}

            {showSelection && channels.length > 0 && (
                <span className={styles.sectionLabel}>
                    Cochez les canaux vers lesquels{' '}
                    {scope.kind === 'item' ? `ce ${descriptor.itemNoun ?? 'élément'}` : descriptor.label} écrit. Sans
                    aucun coché, rien ne part.
                </span>
            )}

            <div className={styles.channelList}>
                {channels.length === 0 && foreign.length === 0 && (
                    // L'état vide porte le geste : le « + » ouvre les réglages
                    // de la fonctionnalité sur cet onglet, où les canaux se
                    // déclarent. Offert même sans le droit de gérer : le
                    // chemin reste le même, on y lira simplement sans ajouter.
                    <div className={styles.emptyRow}>
                        <span>
                            {`Aucun canal pour ${descriptor.label}.`}
                            {onManageChannels
                                ? ' Le « + » ouvre les réglages de la fonctionnalité, où ils se déclarent.'
                                : canManage
                                  ? ' Ajoutez-en un ci-dessous : il recevra ses alertes.'
                                  : ' Demandez à un gestionnaire de l’espace d’en déclarer un.'}
                        </span>
                        {onManageChannels && (
                            <button
                                type='button'
                                className={styles.rowAction}
                                title='Ouvrir les réglages de la fonctionnalité, où les canaux se déclarent'
                                aria-label='Déclarer un canal dans les réglages de la fonctionnalité'
                                onClick={onManageChannels}
                            >
                                <span className='icon icon-plus' />
                            </button>
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
                                webhook est longue par nature, et c'est le seul
                                élément qu'on peut couper sans rien perdre. */}
                            <span className={styles.channelMeta}>
                                {KIND_LABEL[channel.kind]}
                                {channel.target && ` · ${channel.target}`}
                            </span>
                        </span>

                        {/* « Utilisé par N » **hors** de la ligne tronquable, et
                            c'est la raison d'être de cette pastille : mesuré, la
                            meta ne disposait que de 101 px pour 387 px de texte,
                            si bien que le compteur — ce qui donne à voir les
                            doublons de la reprise 087 — n'apparaissait jamais. */}
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
                                {/* Icônes seules : trois boutons libellés prenaient
                                    361 px des 554 de la ligne et étouffaient ce
                                    qu'ils accompagnaient. Même parti que la liste
                                    des rôles de « Gérer l'espace ». */}
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

                {/* Ceux d'un autre espace : on voit qu'ils existent et ce qu'ils
                    sont, jamais qui ils désignent. Ni case ni action — on ne
                    règle pas depuis une fenêtre ce qui appartient à la maison. */}
                {foreign.map((channel) => (
                    <div key={`f${channel.id}`} className={`${styles.channelRow} ${styles.channelRowForeign}`}>
                        <span className={styles.foreignMark} aria-hidden='true'>
                            <span className='icon icon-lock' />
                        </span>
                        <span className={`icon icon-${KIND_ICON[channel.kind]} ${styles.channelIcon}`} />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>{channel.label}</span>
                            <span className={styles.channelMeta}>
                                Réglé dans l’espace d’origine — vous ne pouvez ni le lire ni le modifier d’ici.
                            </span>
                        </span>
                    </div>
                ))}
            </div>

            {!managedHere && (
                <p className={styles.sectionHint}>
                    Ce {descriptor.itemNoun ?? 'élément'} vient d’un autre espace : ses canaux s’y règlent, et
                    l’ordonnanceur qui le surveille y tourne. Un canal ajouté ici ne le concernerait pas.
                    {/* Le refus expliqué devient un chemin : si l'appelant est
                        membre de l'espace d'origine, on l'y emmène, fiche
                        ouverte, réglages rouverts sur ce même onglet. */}
                    {scope.kind === 'item' &&
                        homeWorkspaceId !== null &&
                        accessibleWorkspaceName(homeWorkspaceId) !== null && (
                            <>
                                {' '}
                                <button
                                    type='button'
                                    className={styles.jumpBtn}
                                    onClick={() =>
                                        goToItemSettings(homeWorkspaceId, feature, scope.itemId, 'notifications')
                                    }
                                >
                                    Régler dans « {accessibleWorkspaceName(homeWorkspaceId)} »
                                </button>
                            </>
                        )}
                </p>
            )}

            {scope.kind === 'feature' && canManage && (
                <div className={styles.sectionActions}>
                    <Button
                        variant='secondary'
                        icon='plus'
                        disabled={busy}
                        onClick={() => {
                            setEditing(null);
                            setDraft(EMPTY_DRAFT);
                        }}
                    >
                        Ajouter un canal
                    </Button>
                    {/* « Tester cet envoi » éprouve une **sélection** : elle
                        n'existe à cette échelle que sans éléments (Sentinelle).
                        Chaque canal garde son essai individuel sur sa ligne. */}
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
                    {canRoute && (
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
                toutes les sources : un formulaire qui pousse la liste sous lui
                faisait sauter le panneau, et deux méthodes d'ajout dans une
                même popup de réglages étaient une de trop. */}
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
                                <option value='discord'>Discord — mise en page riche, suivi vivant</option>
                                <option value='webhook'>Webhook — POST JSON générique</option>
                                <option value='email'>E-mail</option>
                            </SelectInput>
                            <span className={styles.fieldHint}>{KIND_HINT[draft.kind]}</span>
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
                                            {openAccounts.map((a) => (
                                                <option key={a.id} value={a.id}>
                                                    {a.displayName} ({a.emailAddress})
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
                                            disabled={busy}
                                            onClick={openMailAdd}
                                        />
                                    </div>
                                    <span className={styles.fieldHint}>
                                        {openAccounts.length === 0
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
                                            quand même, et un point d’entrée qui ne les attend pas les refusera —
                                            choisissez « Webhook » pour lui envoyer du texte.
                                        </span>
                                    )}
                            </label>
                        )}
                    </div>
                )}
            </Dialog>

            {status && <p className={styles.notice}>{status}</p>}

            {mailAdd && <MailAccountLauncher onDone={onMailAddDone} />}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}

/**
 * Monte le dialogue de compte Mail **à la demande**, l'ouvre, rend le résultat.
 *
 * `AccountPopup` passe par le registre impératif des Popup : il faut qu'une
 * instance soit montée pour qu'`OpenPopup` la trouve, et la feature Mail n'est
 * pas forcément vivante quand on règle un canal. D'où ce lanceur : monter,
 * ouvrir, démonter au retour. Le registre est une pile, et l'instance de Mail
 * (si sa feature est gardée vivante en arrière-plan) reprend la main ensuite.
 *
 * L'ouverture vit dans l'effet du **parent** : React exécute les effets des
 * enfants d'abord, donc `AccountPopup` est déjà inscrit quand `OpenPopup` le
 * vise ; aucun tour d'attente à bricoler.
 */
function MailAccountLauncher({ onDone }: { onDone: (result: AccountPopupResult) => void }) {
    const doneRef = useRef(onDone);
    doneRef.current = onDone;

    useEffect(() => {
        let live = true;
        void OpenPopup<AccountPopupResult>(ACCOUNT_POPUP, null).then((result) => {
            if (live) doneRef.current(result);
        });
        return () => {
            live = false;
        };
    }, []);

    return <AccountPopup />;
}

/**
 * Miroir client d'`isDiscordWebhook` (`Services/discord.ts`) : analysée, jamais
 * cherchée dans la chaîne — `includes('discord.com')` dirait oui à
 * `https://exemple.com/?ref=discord.com`.
 *
 * Ici c'est un **avertissement**, pas un refus : le serveur ne devine plus, donc
 * déclarer un canal Discord sur une autre URL reste possible. On dit simplement
 * que ça ne fonctionnera probablement pas.
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
    email: 'Un compte Mail « open » de l’espace expédie le message.',
    webhook:
        'Le message lisible est répété dans « content » (Discord) et « text » (Slack), les champs structurés suivent pour un point d’entrée maison.',
    discord:
        'Mise en page riche (couleurs, champs), et pour le déploiement un seul message qui se met à jour du début à la fin.'
};

/** Quand cette fonctionnalité écrit — la phrase qui évite de régler la mauvaise. */
const WHEN: Record<NotificationFeature, string> = {
    uptime: 'Envoyées à chaque bascule d’un service surveillé : hors ligne (avec l’heure et l’erreur) puis retour en ligne (avec la durée de la panne).',
    sentinel:
        'Envoyées à chaque nouveau constat de la Sentinelle : une machine suspecte, une dérive de configuration, une règle enfreinte.',
    database:
        'Envoyées au franchissement d’un seuil d’alerte d’une base, dans les deux sens — déclenchement et retour à la normale.',
    deploy: 'Envoyées à l’atterrissage d’un déploiement, échec comme succès, y compris ceux lancés depuis Dokploy, une CI ou un push git.',
    backup: 'Envoyées à l’échec d’une sauvegarde. Les réussites ne disent rien, sinon l’échec se perdrait dans le flot des succès.'
};
