import { useCallback, useEffect, useRef, useState } from 'react';

import Button from '@/Components/Button';
import { OpenPopup } from '@/Components/Popup';
import TextInput from '@/Components/TextInput';
import { invalidate, onResourceChange } from '@/stores/invalidation';
import { useLiveSegment } from '@/live/useLiveSegment';
import AccountPanel from './AccountPanel';
import AccountPopup, { ACCOUNT_POPUP, type AccountPopupResult } from './AccountPopup';
import AccountSettingsPopup, { ACCOUNT_SETTINGS_POPUP, type AccountSettingsResult } from './AccountSettingsPopup';
import ComposePopup, { COMPOSE_POPUP, type ComposeInput } from './ComposePopup';
import ConfirmPopup, { MAIL_CONFIRM_POPUP } from './ConfirmPopup';
import MailSettingsPopup, { MAIL_SETTINGS_POPUP } from './MailSettingsPopup';
import MessageInfoPopup, { MESSAGE_INFO_POPUP } from './MessageInfoPopup';
import MessageList from './MessageList';
import MessagePopup from './MessagePopup';
import { humanizeError, withSecrecy, withSettingsDefaults, ws } from './api';
import styles from './style.module.css';

import { MAIL_MESSAGE_PAGE_SIZE } from 'deveye-types';

import type {
    MailAccount,
    MailBodyRenderMode,
    MailFolder,
    MailMessage,
    MailMessageCursor,
    MailMessageSummary
} from 'deveye-types';
import type { FeatureProps } from '../types';

/**
 * Partagée avec le serveur, qui réconcilie exactement cette fenêtre à chaque
 * relève : la page qu'on affiche sans défiler est celle qu'il garde honnête.
 */
const MESSAGE_PAGE_SIZE = MAIL_MESSAGE_PAGE_SIZE;
/** Envelopes pulled from IMAP in one go when the local cache runs out. */
const BACKFILL_BATCH_SIZE = 100;
/**
 * Quiet period after the last keystroke before a search goes out. Generous on
 * purpose: each search reaches the IMAP server, so a tighter value mostly buys
 * extra round trips (and, against Gmail/Outlook, throttling) rather than speed.
 */
const SEARCH_DEBOUNCE_MS = 700;
/** Results are shown in one go — no paging — so this is also the ceiling. */
const SEARCH_RESULT_LIMIT = 200;

/** Page cursor pointing just past `message`, or null when there is no row to resume from. */
function cursorOf(message: MailMessageSummary | undefined): MailMessageCursor | null {
    return message ? { date: message.date, id: message.id } : null;
}

/**
 * Fusionne une première page fraîchement relue dans la liste déjà affichée.
 *
 * La page 0 **est** la tête de liste : elle remplace donc ce qui était là
 * (drapeaux réconciliés, lignes disparues, messages arrivés), et tout ce qui est
 * plus ancien que sa dernière ligne est conservé intact — c'est ce qui préserve
 * les pages déjà déroulées et, avec elles, la position de défilement. Les lignes
 * gardent leur `id`, donc seule celles qui ont réellement changé se repeignent.
 */
function mergeHead(previous: MailMessageSummary[], head: MailMessageSummary[]): MailMessageSummary[] {
    const boundary = cursorOf(head[head.length - 1]);
    // Une page courte veut dire que le cache tient tout entier dans cette tête :
    // ce que `previous` a en plus n'existe plus, il n'y a rien à conserver.
    if (boundary === null || head.length < MESSAGE_PAGE_SIZE) return head;
    return [
        ...head,
        ...previous.filter((m) => m.date < boundary.date || (m.date === boundary.date && m.id < boundary.id))
    ];
}

export default function Mail(_props: FeatureProps) {
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [accountsLoading, setAccountsLoading] = useState(true);
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
    const [busyAccounts, setBusyAccounts] = useState<ReadonlySet<number>>(new Set());
    /** A card is being dragged: the periodic reload must not reshuffle under it. */
    const draggingRef = useRef(false);
    const selectedAccountIdRef = useRef<number | null>(null);
    // Which of panel A's two slides is showing — its own bit of state,
    // independent of the selection (see AccountPanel), also used here to
    // widen the column while the (more space-hungry) account list shows.
    const [showAccountList, setShowAccountList] = useState(true);
    /**
     * Which of the two columns is on screen once there is only room for one.
     * Inert on desktop — nothing reads it there — because the switch itself is
     * pure CSS (see `.feature[data-mobile-view]` in the stylesheet), which keeps
     * the wide layout free of any width detection.
     */
    const [mobileView, setMobileView] = useState<'panel' | 'messages'>('panel');

    const [folders, setFolders] = useState<MailFolder[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(false);
    const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
    const selectedFolderIdRef = useRef<number | null>(null);
    selectedFolderIdRef.current = selectedFolderId;

    const [messages, setMessages] = useState<MailMessageSummary[]>([]);
    const [nextCursor, setNextCursor] = useState<MailMessageCursor | null>(null);
    /** The folder has no older mail left on the server — the scroll can stop. */
    const [reachedFolderStart, setReachedFolderStart] = useState(false);
    const [messagesLoading, setMessagesLoading] = useState(false);
    // Lus par le rafraîchissement de fond, qui ne doit dépendre d'aucune closure :
    // il est appelé par un abonnement, longtemps après le rendu qui l'a créé.
    const messagesRef = useRef<MailMessageSummary[]>([]);
    messagesRef.current = messages;
    const messagesLoadingRef = useRef(false);
    messagesLoadingRef.current = messagesLoading;
    /** Une relève du dossier ouvert est en cours (bouton de rafraîchissement). */
    const [refreshing, setRefreshing] = useState(false);
    const messageColumnRef = useRef<HTMLDivElement>(null);

    /** Raw search box content. Empty = not searching; the paginated list shows instead. */
    const [search, setSearch] = useState('');
    /** `null` while not searching — distinct from `[]`, which means "searched, found nothing". */
    const [searchResults, setSearchResults] = useState<MailMessageSummary[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchTruncated, setSearchTruncated] = useState(false);
    /** False when the IMAP leg couldn't run: results then cover only what was synced. */
    const [searchRemote, setSearchRemote] = useState(false);

    const [messagePopupOpen, setMessagePopupOpen] = useState(false);
    const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
    const [messageLoading, setMessageLoading] = useState(false);
    const [renderMode, setRenderMode] = useState<MailBodyRenderMode>('embedded');

    const [error, setError] = useState<string | null>(null);

    const reloadAccounts = useCallback(async () => {
        try {
            const res = await ws.send('mail.accountList', {});
            setAccounts(res.accounts);
            setError(null);
        } catch {
            setError('Chargement des comptes impossible.');
        } finally {
            setAccountsLoading(false);
        }
    }, []);

    /**
     * Reload the list *and* tell the dashboard widget its count moved. Every
     * path that adds or removes a mailbox goes through here — the widget
     * subscribes to `mail.accountCount` but nothing was ever bumping it, so its
     * number stayed at whatever it was until the socket next reconnected.
     */
    const reloadAfterAccountChange = useCallback(async () => {
        invalidate('mail.accountCount');
        await reloadAccounts();
    }, [reloadAccounts]);

    useEffect(() => {
        void reloadAccounts();
    }, [reloadAccounts]);

    // Le sondage au repos a disparu : c'est `live.changed` qui prévient d'un
    // nouveau message, qu'il vienne d'un autre membre ou de la synchro de fond.
    useEffect(() => {
        return onResourceChange('mail.accountList', () => {
            // Une relecture réordonne la liste sous le pointeur ; jamais en plein
            // glisser-déposer.
            if (!draggingRef.current) void reloadAccounts();
        });
    }, [reloadAccounts]);

    // Seul minuteur conservé, et ce n'est pas un sondage de données : la barre
    // de progression d'une synchro en cours (voir AccountCard/AccountPanel) lit
    // un compteur qui ne vit qu'en mémoire du serveur, le temps de la synchro.
    // Il ne tourne donc que pendant celle-ci, et s'arrête avec elle.
    const anySyncing = accounts.some((a) => a.syncing);
    useEffect(() => {
        if (!anySyncing) return;
        const id = setInterval(() => {
            if (!draggingRef.current) void reloadAccounts();
        }, 1500);
        return () => clearInterval(id);
    }, [anySyncing, reloadAccounts]);

    useEffect(() => {
        // Driven only by the id actually changing — not by every render — so
        // the manual back-arrow toggle (same id, `showAccountList` flipped
        // locally) is never overridden. A selection turning null (e.g. the
        // selected account got deleted) must still fall back to the list,
        // though, or slide 2 would be stuck empty with no way back to it.
        setShowAccountList(selectedAccountId === null);
    }, [selectedAccountId]);

    // Les deux niveaux profonds de Mail, déclarés au moteur de présence. Le
    // composant ne sait rien de l'arbre : il annonce ses deux niveaux (compte,
    // puis dossier), et la racine `view:mail` vient de l'accueil.
    const accountTarget = useLiveSegment('l1', selectedAccountId === null ? null : String(selectedAccountId));
    const folderTarget = useLiveSegment('l2', selectedFolderId === null ? null : String(selectedFolderId));

    // Rejoindre quelqu'un. La cible est **redonnée à chaque rendu** tant qu'elle
    // n'est pas atteinte : ces gardes attendent simplement que les données
    // arrivent, sans rien avoir à acquitter ni à mémoriser.
    useEffect(() => {
        if (!accountTarget) return;
        if (accountTarget.value === null) {
            setSelectedAccountId(null);
            return;
        }
        const id = Number(accountTarget.value);
        if (!accounts.some((a) => a.id === id)) return;
        setSelectedAccountId(id);
        setMobileView('messages');
    }, [accountTarget, accounts]);

    useEffect(() => {
        if (!folderTarget) return;
        if (folderTarget.value === null) return;
        const id = Number(folderTarget.value);
        // `loadFolders` sélectionne d'office la boîte de réception : on ne
        // corrige qu'une fois l'arborescence du compte visé effectivement là.
        if (!folders.some((f) => f.id === id)) return;
        setSelectedFolderId(id);
    }, [folderTarget, folders]);

    const reloadRenderMode = useCallback(async () => {
        try {
            const res = await ws.send('mail.getSettings', {});
            setRenderMode(res.settings.bodyRenderMode);
        } catch {
            // Keep the previous mode — a settings-load hiccup shouldn't block reading mail.
        }
    }, []);

    useEffect(() => {
        void reloadRenderMode();
    }, [reloadRenderMode]);

    const loadFolders = useCallback(async (accountId: number) => {
        setFoldersLoading(true);
        try {
            const res = await withSecrecy(() => ws.send('mail.folderList', { accountId }));
            setFolders(res.folders);
            setError(null);
            // Land on the inbox by default.
            const inbox = res.folders.find((f) => f.specialUse === 'inbox') ?? res.folders[0] ?? null;
            setSelectedFolderId(inbox?.id ?? null);
        } catch (e) {
            setFolders([]);
            setSelectedFolderId(null);
            setError(humanizeError(e, 'Chargement des dossiers impossible.'));
        } finally {
            setFoldersLoading(false);
        }
    }, []);

    useEffect(() => {
        setMessages([]);
        setSelectedMessage(null);
        setSelectedFolderId(null);
        if (selectedAccountId !== null) void loadFolders(selectedAccountId);
        else setFolders([]);
    }, [selectedAccountId, loadFolders]);

    /**
     * Relit l'arborescence sans toucher à la sélection — c'est ce qui remet les
     * compteurs de non-lus d'aplomb après une relève de fond.
     *
     * Pas `loadFolders`, qui retombe d'office sur la boîte de réception et
     * déplacerait l'utilisateur à chaque tick ; pas de `foldersLoading` non plus,
     * un rafraîchissement de fond n'ayant pas à remplacer la liste par
     * « Chargement… ». Et pas de `withSecrecy` : un rafraîchissement que personne
     * n'a demandé ne doit jamais faire surgir l'invite de déverrouillage.
     */
    const refreshFolders = useCallback(async () => {
        const accountId = selectedAccountIdRef.current;
        if (accountId === null) return;
        try {
            const res = await ws.send('mail.folderList', { accountId });
            if (selectedAccountIdRef.current !== accountId) return;
            setFolders(res.folders);
        } catch {
            // On garde l'arborescence affichée : elle reste vraie à un tick près.
        }
    }, []);

    /**
     * One page of the local cache. When the cache runs dry (`nextCursor` comes
     * back null) that isn't necessarily the end of the mailbox — only the end of
     * what has been pulled so far — so this reaches past it once, backfilling an
     * older batch from IMAP and re-reading the page. `reachedStart` is the real
     * end of the folder, and the only thing that stops the scroll for good.
     */
    const loadMessages = useCallback(async (folderId: number, cursor: MailMessageCursor | null) => {
        setMessagesLoading(true);
        try {
            const page = await withSecrecy(() =>
                ws.send('mail.messageList', { folderId, cursor, limit: MESSAGE_PAGE_SIZE })
            );
            let messages = page.messages;
            let nextCursor = page.nextCursor;

            if (nextCursor === null) {
                const older = await withSecrecy(() =>
                    ws.send('mail.folderBackfill', { folderId, limit: BACKFILL_BATCH_SIZE })
                );
                setReachedFolderStart(older.reachedStart);
                if (older.addedCount > 0) {
                    // The batch landed below everything already cached, so the
                    // re-read picks up exactly where this page stopped.
                    const refetched = await withSecrecy(() =>
                        ws.send('mail.messageList', {
                            folderId,
                            cursor: cursorOf(messages[messages.length - 1]) ?? cursor,
                            limit: MESSAGE_PAGE_SIZE
                        })
                    );
                    messages = [...messages, ...refetched.messages];
                    nextCursor = refetched.nextCursor;
                }
            } else {
                setReachedFolderStart(false);
            }

            setMessages((prev) => (cursor === null ? messages : [...prev, ...messages]));
            setNextCursor(nextCursor);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Chargement des messages impossible.'));
        } finally {
            setMessagesLoading(false);
        }
    }, []);

    useEffect(() => {
        setSelectedMessage(null);
        setReachedFolderStart(false);
        // A query only ever means something for the folder it was typed in.
        setSearch('');
        if (selectedFolderId !== null) void loadMessages(selectedFolderId, null);
        else setMessages([]);
    }, [selectedFolderId, loadMessages]);

    /**
     * Rafraîchissement du dossier ouvert : une seule page 0, fusionnée en tête.
     *
     * `nextCursor` et `reachedFolderStart` ne bougent pas — ils décrivent la
     * queue de la liste, que cette relecture ne touche pas. C'est le pendant
     * client de la réconciliation serveur : ce qu'elle vient de corriger tient
     * précisément dans cette page.
     */
    const refreshMessageHead = useCallback(async () => {
        const folderId = selectedFolderIdRef.current;
        if (folderId === null) return;
        // Une page est déjà en vol : elle écrit `messages` aussi, et la fusion
        // partirait d'un état qu'elle est en train de remplacer.
        if (messagesLoadingRef.current) return;
        // Rien à préserver : le chemin normal (avec son backfill) est plus juste
        // qu'une fusion, et il remet `nextCursor` d'aplomb.
        if (messagesRef.current.length === 0) {
            void loadMessages(folderId, null);
            return;
        }
        try {
            const page = await ws.send('mail.messageList', { folderId, cursor: null, limit: MESSAGE_PAGE_SIZE });
            if (selectedFolderIdRef.current !== folderId) return;
            setMessages((prev) => mergeHead(prev, page.messages));
            // La fiche ouverte doit porter les mêmes drapeaux que sa ligne.
            setSelectedMessage((prev) => {
                if (!prev) return prev;
                const fresh = page.messages.find((m) => m.id === prev.id);
                return fresh ? { ...prev, flags: fresh.flags } : prev;
            });
        } catch {
            // Ce qui est à l'écran reste valable : pas de bandeau d'erreur pour un
            // rafraîchissement que l'utilisateur n'a pas demandé.
        }
    }, [loadMessages]);

    // Le signal `live.changed`, mais pour ce qu'on est en train de lire. Sans ces
    // deux abonnements, la relève de fond ne rafraîchissait que les cartes de
    // comptes : la liste ouverte gardait ses messages, ses drapeaux et ses
    // compteurs jusqu'à ce qu'on change de dossier.
    useEffect(() => onResourceChange('mail.folderList', () => void refreshFolders()), [refreshFolders]);
    useEffect(() => onResourceChange('mail.messageList', () => void refreshMessageHead()), [refreshMessageHead]);

    // Les `live.changed` émis pendant une coupure de socket ne sont annoncés à
    // personne, et la reconnexion ne fait que rétablir le lien. Une relecture au
    // retour, donc — sans quoi une veille de la machine laisse la vue figée sur
    // l'état d'avant.
    useEffect(
        () =>
            ws.onStateChange((state) => {
                if (state !== 'open') return;
                void reloadAccounts();
                void refreshFolders();
                void refreshMessageHead();
            }),
        [reloadAccounts, refreshFolders, refreshMessageHead]
    );

    /**
     * Debounced search over the whole folder cache. It has to be a server round
     * trip rather than a filter over `messages`: that array only holds the pages
     * scrolled so far, and the envelopes are encrypted at rest, so only the
     * server can look inside them (see `mail.messageSearch`).
     *
     * `cancelled` covers the second half of the race the debounce doesn't: a
     * request already in flight when the query changes would otherwise land
     * after the newer one and overwrite fresher results with staler ones.
     */
    useEffect(() => {
        const query = search.trim();
        if (query === '' || selectedFolderId === null) {
            setSearchResults(null);
            setSearchTruncated(false);
            setSearching(false);
            return;
        }
        let cancelled = false;
        setSearching(true);
        const timer = setTimeout(() => {
            void (async () => {
                try {
                    const res = await withSecrecy(() =>
                        ws.send('mail.messageSearch', {
                            folderId: selectedFolderId,
                            query,
                            limit: SEARCH_RESULT_LIMIT
                        })
                    );
                    if (cancelled) return;
                    setSearchResults(res.messages);
                    setSearchTruncated(res.truncated);
                    setSearchRemote(res.remote);
                    setError(null);
                } catch (e) {
                    if (cancelled) return;
                    setSearchResults([]);
                    setSearchTruncated(false);
                    setSearchRemote(false);
                    setError(humanizeError(e, 'Recherche impossible.'));
                } finally {
                    if (!cancelled) setSearching(false);
                }
            })();
        }, SEARCH_DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [search, selectedFolderId]);

    /**
     * Relève douce du dossier ouvert, à la demande : côté serveur, la même passe
     * que la synchro de fond — les arrivées, plus la réconciliation des drapeaux
     * et des disparus sur la fenêtre récente — puis la tête de liste est fusionnée
     * ici. Rien n'est jeté : la position de défilement et les pages déjà déroulées
     * survivent, et l'aller-retour IMAP se compte en un fetch plutôt qu'en deux
     * cents enveloppes.
     */
    const syncFolder = useCallback(async () => {
        const folderId = selectedFolderIdRef.current;
        if (folderId === null || refreshing) return;
        setRefreshing(true);
        setError(null);
        try {
            await withSecrecy(() => ws.send('mail.folderSync', { folderId }));
            await refreshMessageHead();
            await refreshFolders();
        } catch (e) {
            setError(humanizeError(e, 'Relève impossible.'));
        } finally {
            setRefreshing(false);
        }
    }, [refreshing, refreshMessageHead, refreshFolders]);

    /**
     * La réparation de dernier recours : le cache du dossier est jeté côté serveur
     * et reconstruit sur la boîte telle qu'elle est, puis la liste repart du haut.
     *
     * Ce n'est plus le geste ordinaire — {@link syncFolder} l'est — mais il reste
     * le seul à pouvoir remettre d'aplomb ce qui a dérivé au-delà de la fenêtre
     * que la relève réconcilie. Les lignes changent d'`id` en repassant, donc la
     * fusion de tête ne s'y applique pas : on recharge vraiment.
     */
    const resetFolder = useCallback(async () => {
        const folderId = selectedFolderIdRef.current;
        if (folderId === null || refreshing) return;
        setRefreshing(true);
        setError(null);
        try {
            await withSecrecy(() => ws.send('mail.folderReset', { folderId }));
            setMessages([]);
            setNextCursor(null);
            setReachedFolderStart(false);
            await loadMessages(folderId, null);
        } catch (e) {
            setError(humanizeError(e, 'Rechargement impossible.'));
        } finally {
            setRefreshing(false);
        }
    }, [refreshing, loadMessages]);

    /*
     * The paginated list and the search results are two views of the same rows,
     * so every local row mutation has to hit both — otherwise marking a message
     * read from a search result leaves it bold the moment you clear the query.
     * `searchResults` stays `null` when not searching, so the second update is
     * a no-op then.
     */
    const patchMessage = useCallback((id: number, patch: Partial<MailMessageSummary['flags']>) => {
        const apply = (list: MailMessageSummary[]) =>
            list.map((m) => (m.id === id ? { ...m, flags: { ...m.flags, ...patch } } : m));
        setMessages(apply);
        setSearchResults((prev) => (prev ? apply(prev) : prev));
    }, []);

    const dropMessage = useCallback((id: number) => {
        const apply = (list: MailMessageSummary[]) => list.filter((m) => m.id !== id);
        setMessages(apply);
        setSearchResults((prev) => (prev ? apply(prev) : prev));
    }, []);

    const openMessage = useCallback(
        async (message: MailMessageSummary, allowRemoteImages = false) => {
            setMessagePopupOpen(true);
            setMessageLoading(true);
            // Keep showing the current content only while re-fetching the SAME
            // message (e.g. to unblock its images) — opening a different one (or
            // reopening after close) must never flash the previous message's
            // content, so clear it up front in that case.
            setSelectedMessage((prev) => (prev && prev.id === message.id ? prev : null));
            try {
                const res = await withSecrecy(() =>
                    ws.send('mail.messageGet', { messageId: message.id, allowRemoteImages })
                );
                setSelectedMessage(res.message);
                // Reflect the read state in the list without a full reload.
                patchMessage(message.id, { seen: true });
            } catch (e) {
                setError(humanizeError(e, 'Ouverture du message impossible.'));
            } finally {
                setMessageLoading(false);
            }
        },
        [patchMessage]
    );

    const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;
    selectedAccountIdRef.current = selectedAccountId;
    const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;

    // Reads the selection through the ref, like `deleteAccount` below, so the
    // callback stays stable for the whole session instead of being rebuilt
    // every time a different mailbox is picked.
    const openAccountForm = useCallback(
        async (account: MailAccount | null) => {
            const result: AccountPopupResult = await OpenPopup(ACCOUNT_POPUP, account);
            if (result === null) return;
            try {
                if (result === 'delete' && account) {
                    await ws.send('mail.accountDelete', { id: account.id });
                    if (selectedAccountIdRef.current === account.id) setSelectedAccountId(null);
                }
                await reloadAfterAccountChange();
            } catch {
                setError('Action impossible.');
            }
        },
        [reloadAfterAccountChange]
    );

    const withAccountBusy = useCallback(
        async (id: number, run: () => Promise<void>) => {
            setBusyAccounts((prev) => new Set(prev).add(id));
            try {
                await run();
                await reloadAccounts();
            } catch {
                setError('Action impossible.');
            } finally {
                setBusyAccounts((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        },
        [reloadAccounts]
    );

    const handleAccountReorder = useCallback(
        (ids: number[]) => {
            setAccounts((prev) => {
                const byId = new Map(prev.map((a) => [a.id, a]));
                return ids.flatMap((id) => byId.get(id) ?? []);
            });
            ws.send('mail.accountReorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reloadAccounts();
            });
        },
        [reloadAccounts]
    );

    const deleteAccount = useCallback(
        async (account: MailAccount) => {
            const confirmed = await OpenPopup<boolean>(MAIL_CONFIRM_POPUP, {
                title: 'Supprimer cette boîte mail ?',
                message: `« ${account.displayName} » et tout son cache local seront supprimés. Les messages restent intacts sur le serveur.`,
                confirmLabel: 'Supprimer'
            });
            if (!confirmed) return;
            try {
                await ws.send('mail.accountDelete', { id: account.id });
                if (selectedAccountIdRef.current === account.id) setSelectedAccountId(null);
                await reloadAfterAccountChange();
            } catch (e) {
                setError(humanizeError(e, 'Suppression impossible.'));
            }
        },
        [reloadAfterAccountChange]
    );

    const openAccountSettings = useCallback(
        async (account: MailAccount) => {
            const folderId = selectedFolderIdRef.current;
            const result = await OpenPopup<AccountSettingsResult>(ACCOUNT_SETTINGS_POPUP, {
                account,
                folderName: folders.find((f) => f.id === folderId)?.name ?? null
            });
            if (result === 'saved') await reloadAccounts();
            else if (result === 'reset') await resetFolder();
        },
        [reloadAccounts, resetFolder, folders]
    );

    const toggleAccountEnabled = useCallback(
        (a: MailAccount) =>
            void withAccountBusy(a.id, async () => {
                await ws.send('mail.accountSetEnabled', { id: a.id, enabled: !a.enabled });
            }),
        [withAccountBusy]
    );

    /*
     * Everything handed down to `MessageList` below is a stable callback. The
     * list and its rows are memoized (see MessageList.tsx), so a fresh closure
     * here would defeat that outright and repaint every row on each sync poll
     * — which is what made opening a message read as several redraws.
     */

    /** Applies a flag change to a message, keeping the list row and (if open) the popup in sync. */
    const setMessageFlag = useCallback(
        async (message: MailMessageSummary, patch: Partial<{ seen: boolean; flagged: boolean }>): Promise<void> => {
            try {
                await withSecrecy(() => ws.send('mail.messageSetFlags', { messageId: message.id, flags: patch }));
                patchMessage(message.id, patch);
                setSelectedMessage((prev) =>
                    prev && prev.id === message.id ? { ...prev, flags: { ...prev.flags, ...patch } } : prev
                );
            } catch (e) {
                setError(humanizeError(e, 'Action impossible.'));
            }
        },
        [patchMessage]
    );

    const toggleSeen = useCallback(
        (message: MailMessageSummary): void => {
            void setMessageFlag(message, { seen: !message.flags.seen });
        },
        [setMessageFlag]
    );

    const toggleFlagged = useCallback(
        (message: MailMessageSummary): void => {
            void setMessageFlag(message, { flagged: !message.flags.flagged });
        },
        [setMessageFlag]
    );

    const openMessageId = selectedMessage?.id ?? null;

    // Read through refs, never through the closure. Depending on the open
    // message or the page cursor would re-create these on every selection and
    // every page — and a changed callback prop invalidates *every* memoized row
    // at once, which is exactly the repaint storm the memoization exists to
    // avoid. Only `messages` and `selectedId` may move a row now.
    const openMessageIdRef = useRef<number | null>(null);
    openMessageIdRef.current = openMessageId;
    const nextCursorRef = useRef<MailMessageCursor | null>(null);
    nextCursorRef.current = nextCursor;

    const deleteMessage = useCallback(
        async (message: MailMessageSummary): Promise<void> => {
            const confirmed = await OpenPopup<boolean>(MAIL_CONFIRM_POPUP, {
                title: 'Supprimer ce message ?',
                message: `« ${message.subject || '(sans objet)'} » sera définitivement supprimé.`,
                confirmLabel: 'Supprimer'
            });
            if (!confirmed) return;
            try {
                await withSecrecy(() => ws.send('mail.messageDelete', { messageId: message.id }));
                dropMessage(message.id);
                if (openMessageIdRef.current === message.id) {
                    setMessagePopupOpen(false);
                    setSelectedMessage(null);
                }
            } catch (e) {
                setError(humanizeError(e, 'Suppression impossible.'));
            }
        },
        [dropMessage]
    );

    const handleSelectMessage = useCallback((message: MailMessageSummary) => void openMessage(message), [openMessage]);

    const handleLoadMore = useCallback(() => {
        const folderId = selectedFolderIdRef.current;
        if (folderId !== null) void loadMessages(folderId, nextCursorRef.current);
    }, [loadMessages]);

    async function downloadAttachment(attachmentId: string): Promise<void> {
        if (!selectedMessage) return;
        try {
            const res = await withSecrecy(() =>
                ws.send('mail.attachmentDownload', { messageId: selectedMessage.id, attachmentId })
            );
            window.open(res.downloadUrl, '_blank');
        } catch (e) {
            setError(humanizeError(e, 'Téléchargement impossible.'));
        }
    }

    async function openCompose(): Promise<void> {
        const input: ComposeInput = { accounts, defaultAccountId: selectedAccountId };
        const sent = await OpenPopup<boolean>(COMPOSE_POPUP, input);
        if (sent && selectedFolderId !== null) void loadMessages(selectedFolderId, null);
    }

    async function openSettings(): Promise<void> {
        const saved = await OpenPopup<boolean>(MAIL_SETTINGS_POPUP, true);
        if (saved) void reloadRenderMode();
    }

    /** Adds hostnames to the trusted-images list, then reloads the open message so it applies. */
    async function trustImageSources(domains: string[]): Promise<void> {
        try {
            const current = withSettingsDefaults((await ws.send('mail.getSettings', {})).settings);
            const merged = Array.from(new Set([...current.trustedImageDomains, ...domains]));
            await ws.send('mail.setSettings', { ...current, trustedImageDomains: merged });
            if (selectedMessage) void openMessage(selectedMessage);
        } catch (e) {
            setError(humanizeError(e, 'Action impossible.'));
        }
    }

    /**
     * Driven by the query, not by the results: during the debounce and the very
     * first request there are no results yet, and keying off those would leave
     * the unfiltered folder on screen with nothing saying a search is running.
     */
    const searchMode = search.trim() !== '';

    /**
     * One line under the search box while searching. It says how many matched
     * *and* that the search covered the local cache rather than the whole
     * remote mailbox — without that, "3 messages trouvés" in a folder holding
     * thousands of server-side messages reads as a complete answer when it is
     * only a complete answer about what has been synced.
     */
    const searchStatus = ((): string | null => {
        if (!searchMode) return null;
        if (searching || searchResults === null) return 'Recherche…';
        // The caveat is only warranted when the IMAP leg didn't run: with it,
        // the search really did cover the whole mailbox, bodies included.
        const scope = searchRemote ? '' : ', parmi ceux déjà synchronisés (serveur injoignable)';
        const count = searchResults.length;
        if (count === 0) return `Aucun message ne correspond${scope || ''}.`;
        const noun = `${count} message${count > 1 ? 's' : ''}`;
        if (searchTruncated) return `Plus de ${noun} — affichage des ${SEARCH_RESULT_LIMIT} plus récents.`;
        return `${noun} trouvé${count > 1 ? 's' : ''}${scope}.`;
    })();

    const headline = accountsLoading
        ? 'Chargement…'
        : accounts.length === 0
          ? 'Aucune boîte mail configurée'
          : selectedFolder
            ? `${selectedFolder.name}${selectedFolder.unreadCount > 0 ? ` · ${selectedFolder.unreadCount} non lu${selectedFolder.unreadCount > 1 ? 's' : ''}` : ''}`
            : (selectedAccount?.displayName ?? 'Sélectionnez une boîte mail');

    // The messages step only exists once a folder is picked; anything else (no
    // account yet, a deleted one) falls back to the panel rather than to an
    // empty column with no way back.
    const mobileStep = selectedFolderId !== null ? mobileView : 'panel';

    return (
        <div className={styles.root}>
            <div className={styles.toolbar}>
                {mobileStep === 'messages' && (
                    <button
                        type='button'
                        className={`${styles.iconBtn} ${styles.mobileBack}`}
                        title='Retour aux dossiers'
                        aria-label='Retour aux dossiers'
                        onClick={() => setMobileView('panel')}
                    >
                        <span className='icon icon-arrow-left' />
                    </button>
                )}
                <p className={styles.headline}>{headline}</p>
                <div className={styles.toolbarActions}>
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title='Paramètres Mail'
                        aria-label='Paramètres Mail'
                        onClick={() => void openSettings()}
                    >
                        <span className='icon icon-settings' />
                    </button>
                    <Button
                        variant='ghost'
                        icon='edit'
                        disabled={accounts.length === 0}
                        onClick={() => void openCompose()}
                    >
                        Nouveau message
                    </Button>
                </div>
            </div>

            {error && <p className={styles.error}>{error}</p>}

            {/* The sidebar width goes through a custom property rather than
                `grid-template-columns` directly: an inline shorthand would
                outrank the media query that collapses this to one column. */}
            <div
                className={styles.feature}
                data-mobile-view={mobileStep}
                style={{ '--mail-sidebar-width': showAccountList ? '300px' : '230px' } as React.CSSProperties}
            >
                <div className={styles.sidebar}>
                    {accountsLoading ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : accounts.length === 0 ? (
                        <div className={styles.emptyState}>
                            <p className={styles.empty}>Ajoutez une boîte IMAP/SMTP pour commencer.</p>
                            <Button icon='plus' onClick={() => void openAccountForm(null)}>
                                Ajouter une boîte mail
                            </Button>
                        </div>
                    ) : (
                        <AccountPanel
                            accounts={accounts}
                            selectedId={selectedAccountId}
                            busy={busyAccounts}
                            onSelect={(a) => {
                                setSelectedAccountId(a.id);
                                setShowAccountList(false);
                            }}
                            onEdit={(a) => void openAccountForm(a)}
                            onToggle={toggleAccountEnabled}
                            onReorder={handleAccountReorder}
                            onDragStateChange={(active) => {
                                draggingRef.current = active;
                            }}
                            onAdd={() => void openAccountForm(null)}
                            folders={folders}
                            foldersLoading={foldersLoading}
                            selectedFolderId={selectedFolderId}
                            onSelectFolder={(f) => {
                                setSelectedFolderId(f.id);
                                setMobileView('messages');
                            }}
                            showList={showAccountList}
                            onShowList={() => setShowAccountList(true)}
                            onDeleteAccount={(a) => void deleteAccount(a)}
                            onRefreshFolder={() => void syncFolder()}
                            refreshingFolder={refreshing}
                            onOpenAccountSettings={(a) => void openAccountSettings(a)}
                        />
                    )}
                </div>

                {/* The search bar sits outside the scrolling area, not inside it:
                    `.messageColumn` is both the scroll container and the
                    IntersectionObserver root for infinite scroll, so a bar within
                    it would slide away as soon as you scrolled the results. */}
                <div className={styles.messageColumnWrap}>
                    {selectedFolderId !== null && (
                        <div className={styles.searchBar}>
                            <TextInput
                                type='search'
                                placeholder='Rechercher : objet, expéditeur, destinataire…'
                                aria-label='Rechercher dans ce dossier'
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Escape') setSearch('');
                                }}
                            />
                            {search !== '' && (
                                <button
                                    type='button'
                                    className={`${styles.iconBtn} ${styles.searchClear}`}
                                    title='Effacer la recherche'
                                    aria-label='Effacer la recherche'
                                    onClick={() => setSearch('')}
                                >
                                    <span className='icon icon-x' />
                                </button>
                            )}
                        </div>
                    )}

                    {searchStatus && <p className={styles.searchStatus}>{searchStatus}</p>}

                    <div className={styles.messageColumn} ref={messageColumnRef}>
                        {selectedFolderId !== null ? (
                            <MessageList
                                // While a new query is in flight the previous
                                // results stay up, so the list doesn't blink
                                // empty on every keystroke.
                                messages={searchMode ? (searchResults ?? []) : messages}
                                selectedId={openMessageId}
                                onSelect={handleSelectMessage}
                                onToggleSeen={toggleSeen}
                                onToggleFlagged={toggleFlagged}
                                onDelete={deleteMessage}
                                onLoadMore={handleLoadMore}
                                // Search returns its whole (capped) result set at
                                // once, so there is nothing left to page through.
                                hasMore={!searchMode && (nextCursor !== null || !reachedFolderStart)}
                                loading={searchMode ? searching : messagesLoading}
                                // The status line above already reports an empty
                                // search, and "aucun message dans ce dossier"
                                // would be plainly false while a query is on.
                                emptyLabel={searchMode ? null : 'Aucun message dans ce dossier.'}
                                scrollRootRef={messageColumnRef}
                            />
                        ) : (
                            <div className={styles.messageColumnEmpty}>
                                <p className={styles.empty}>Sélectionnez une boîte mail.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <AccountPopup />
            <AccountSettingsPopup />
            <ComposePopup />
            <ConfirmPopup />
            <MailSettingsPopup />
            <MessageInfoPopup />
            <MessagePopup
                open={messagePopupOpen}
                message={selectedMessage}
                loading={messageLoading}
                renderMode={renderMode}
                onClose={() => setMessagePopupOpen(false)}
                onLoadImages={() => selectedMessage && void openMessage(selectedMessage, true)}
                onTrustImageSources={(domains) => void trustImageSources(domains)}
                onToggleSeen={() => selectedMessage && toggleSeen(selectedMessage)}
                onToggleFlagged={() => selectedMessage && toggleFlagged(selectedMessage)}
                onDelete={() => selectedMessage && void deleteMessage(selectedMessage)}
                onDownloadAttachment={(id) => void downloadAttachment(id)}
                onShowInfo={() => selectedMessage && void OpenPopup(MESSAGE_INFO_POPUP, selectedMessage)}
            />
        </div>
    );
}
