import { useCallback, useEffect, useState } from 'react';
import {
    NOTIFICATION_LABEL_MAX,
    NOTIFICATION_TARGET_MAX,
    featureDescriptor,
    type MailAccount,
    type NotificationChannel,
    type NotificationChannelInput,
    type NotificationChannelKind,
    type NotificationFeature
} from 'deveye-types';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import SelectInput from '@/Components/SelectInput';
import Switch from '@/Components/Switch';
import TextInput from '@/Components/TextInput';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';

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
 * Ici les destinations sont des **entités de l'espace**, listées une fois. On
 * coche celles que la cible courante doit servir. « Utilisé par N » dit
 * immédiatement lesquelles portent tout le trafic — et, sur les doublons que la
 * reprise de la migration 087 a forcément créés, lesquelles font double emploi.
 *
 * ## Deux droits, deux moitiés d'écran
 *
 * Cocher relève de la fonctionnalité (`<feature>: write`). Ajouter, corriger ou
 * supprimer un canal relève de l'espace (`workspace.notifications`) — et sans
 * cette capacité, la destination elle-même n'est pas rendue par le serveur : on
 * voit « Astreinte · e-mail », on peut y router, on ne peut pas lire l'adresse.
 *
 * ## Deux échelles, deux gestes
 *
 * La **gestion** des canaux (ajouter, corriger, tester, supprimer) ne se rend
 * qu'à l'échelle de la **fonctionnalité**, le contrat des sources : elles se
 * créent et se corrigent à un seul endroit. À l'échelle d'un élément, l'écran
 * ne fait que **choisir** (héritage et cases), et le bouton « Gérer les
 * canaux » ouvre les réglages de la fonctionnalité par-dessus
 * (`onManageChannels`). Avant cette coupe, le formulaire d'ajout se rendait aux
 * deux échelles : on pouvait déclarer l'astreinte de tout l'espace depuis les
 * réglages d'une base, et chaque écran d'élément redevenait un endroit où les
 * canaux se gèrent : cinq portes de plus pour une même liste.
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
    const canManage = permissions.can('workspace.notifications');
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
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [selected, setSelected] = useState<number[]>([]);
    const [inherits, setInherits] = useState(false);
    const [draft, setDraft] = useState<NotificationChannelInput | null>(null);
    const [editing, setEditing] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

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

    const reload = useCallback(async () => {
        const [list, route] = await Promise.all([
            ws.send('notify.channelList', {}),
            ws.send('notify.routeGet', { feature, itemId })
        ]);
        setChannels(list.channels);
        setForeign(route.foreign);
        setManagedHere(route.managedHere);
        setSelected(route.route.channelIds);
        setInherits(route.route.inherits);
    }, [feature, itemId]);

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
            await ws.send('notify.routeSet', { feature, itemId, inherits: false, channelIds: next });
            setInherits(false);
            invalidate('notify.routeGet');
        }, 'Enregistrement impossible.');
    };

    const setInheritance = (on: boolean): void => {
        setInherits(on);
        void run(async () => {
            await ws.send('notify.routeSet', { feature, itemId, inherits: on, channelIds: selected });
            invalidate('notify.routeGet');
            await reload();
        }, 'Enregistrement impossible.');
    };

    const saveDraft = (): void => {
        if (!draft || !draft.label.trim()) return;
        void run(async () => {
            if (editing === null) await ws.send('notify.channelAdd', draft);
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

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>{WHEN[feature]}</p>

            {scope.kind === 'item' && (
                <label className={styles.inheritRow}>
                    <Switch
                        checked={inherits}
                        disabled={!canRoute || busy}
                        onChange={setInheritance}
                        aria-label={`Suivre les canaux de ${descriptor.label}`}
                    />
                    <span>
                        <span className={styles.inheritLabel}>Suivre {descriptor.label}</span>
                        <span className={styles.inheritHint}>
                            {!managedHere
                                ? `Réglé dans l’espace d’origine de ce ${descriptor.itemNoun ?? 'élément'}.`
                                : inherits
                                  ? `Ce ${descriptor.itemNoun ?? 'élément'} prévient là où la fonctionnalité prévient. Décochez pour lui donner ses propres canaux.`
                                  : `Ce ${descriptor.itemNoun ?? 'élément'} a ses propres canaux. Sans aucun coché, il ne prévient personne.`}
                        </span>
                    </span>
                </label>
            )}

            {channels.length > 0 && (
                <span className={styles.sectionLabel}>
                    Cochez les canaux vers lesquels {scope.kind === 'item' ? 'cet élément' : 'cette fonctionnalité'}{' '}
                    écrit
                </span>
            )}

            {/* Atténuée tant que l'élément hérite : les cases y sont déjà
                désactivées, mais une case cochée et une case cochée-mais-héritée
                se ressemblent trop. `filter: opacity()` et non `opacity`, comme
                partout dans l'app — la propriété appartient aux animations. */}
            <div
                className={`${styles.channelList} ${scope.kind === 'item' && inherits ? styles.channelListInherited : ''}`}
            >
                {channels.length === 0 && foreign.length === 0 && (
                    <p className={styles.empty}>
                        Aucun canal dans cet espace.
                        {!canManage
                            ? ' Demandez à un gestionnaire de l’espace d’en déclarer un.'
                            : scope.kind === 'feature'
                              ? ' Ajoutez-en un ci-dessous : il servira à toutes les fonctionnalités qui préviennent.'
                              : ' « Gérer les canaux » ci-dessous ouvre les réglages de la fonctionnalité, où ils se déclarent.'}
                    </p>
                )}

                {channels.map((channel) => (
                    <div key={channel.id} className={styles.channelRow}>
                        <Checkbox
                            checked={selected.includes(channel.id)}
                            disabled={!canRoute || busy || (scope.kind === 'item' && inherits)}
                            onChange={(on) => toggleChannel(channel.id, on)}
                            aria-label={`Envoyer vers ${channel.label}`}
                        />
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
                </p>
            )}

            {scope.kind === 'feature' && canManage && draft === null && (
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
                    <Button variant='ghost' icon='play' disabled={busy} onClick={testRoute}>
                        Tester cet envoi
                    </Button>
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

            {scope.kind === 'feature' && canManage && draft !== null && (
                <div className={styles.draft}>
                    <span className={styles.sectionLabel}>
                        {editing === null ? 'Nouveau canal' : 'Modifier le canal'}
                    </span>

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Type</span>
                        <SelectInput
                            value={draft.kind}
                            onChange={(e) => setDraft({ ...draft, kind: e.target.value as NotificationChannelKind })}
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
                                <span className={styles.fieldHint}>
                                    {openAccounts.length === 0
                                        ? 'Aucun compte mail « open » configuré — ajoutez-en un dans la feature Mail.'
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
                                        Cette URL ne ressemble pas à un webhook Discord. Les embeds y partiront quand
                                        même, et un point d’entrée qui ne les attend pas les refusera — choisissez «
                                        Webhook » pour lui envoyer du texte.
                                    </span>
                                )}
                        </label>
                    )}

                    <div className={styles.sectionActions}>
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
                        <Button disabled={busy || !draft.label.trim()} onClick={saveDraft}>
                            {editing === null ? 'Ajouter' : 'Enregistrer'}
                        </Button>
                    </div>
                </div>
            )}

            {status && <p className={styles.notice}>{status}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
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
