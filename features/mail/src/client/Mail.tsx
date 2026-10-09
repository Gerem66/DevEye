import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    invalidate,
    onResourceChange,
    onServerEvent,
    onSocketOpen,
    OpenPopup,
    PlanPausedNotice,
    TextInput,
    useLiveItemTarget,
    useLiveSegment,
    useSubView,
    withSecrecy
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import AccountPanel from './AccountPanel';
import AccountPopup, { ACCOUNT_POPUP, type AccountPopupResult } from './AccountPopup';
import EmptyState from './EmptyState';
import { mailViewState } from './viewState';
import ComposePopup, { COMPOSE_POPUP, type ComposeInput } from './ComposePopup';
import ConfirmPopup, { MAIL_CONFIRM_POPUP } from './ConfirmPopup';
import MessageInfoPopup, { MESSAGE_INFO_POPUP } from './MessageInfoPopup';
import MessageList from './MessageList';
import MessagePopup from './MessagePopup';
import { describeAccountStatus } from './accountStatus';
import { canReconnect, providerLabel, reconnectAccount } from './oauthWindow';
import { api, humanizeError, withSettingsDefaults } from './api';
import styles from './style.module.css';

import { MAIL_MESSAGE_PAGE_SIZE, MAIL_SYNC_PROGRESS_EVENT, mailSyncProgressSchema } from '../contracts/domain';

import type { MailAccount, MailFolder, MailMessage, MailMessageCursor, MailMessageSummary } from '../contracts/domain';

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
/** Results are shown in one go, with no paging, so this is also the ceiling. */
const SEARCH_RESULT_LIMIT = 200;
const ACCOUNTS_LOAD_ERROR = 'Chargement des comptes impossible.';

/** Page cursor pointing just past `message`, or null when there is no row to resume from. */
function cursorOf(message: MailMessageSummary | undefined): MailMessageCursor | null {
    return message ? { date: message.date, id: message.id } : null;
}

/**
 * Fusionne une première page fraîchement relue dans la liste déjà affichée. La
 * page 0 est la tête de liste : elle remplace ce qui était là, et tout ce qui est
 * plus ancien que sa dernière ligne est conservé intact, ce qui préserve les
 * pages déjà déroulées et la position de défilement.
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

export default function Mail(_props: FeatureViewProps) {
    const [accounts, setAccounts] = useState<MailAccount[]>([]);
    const [accountsLoading, setAccountsLoading] = useState(true);
    const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);
    const [busyAccounts, setBusyAccounts] = useState<ReadonlySet<number>>(new Set());
    /** A card is being dragged: the periodic reload must not reshuffle under it. */
    const draggingRef = useRef(false);
    const selectedAccountIdRef = useRef<number | null>(null);
    /**
     * Boîte ouverte en pause d'offre : ce qui partirait seul vers IMAP (relève à
     * l'ouverture d'un dossier, incursion vers le passé) ne part pas ; un geste
     * explicite se heurte au refus du serveur, qui l'explique.
     */
    const selectedPausedRef = useRef(false);
    // Which of panel A's two slides is showing: its own bit of state,
    // independent of the selection (see AccountPanel), also used here to
    // widen the column while the (more space-hungry) account list shows.
    const [showAccountList, setShowAccountList] = useState(true);
    /**
     * Which of the two columns is on screen once there is only room for one.
     * Inert on desktop, where the switch itself is pure CSS
     * (`.feature[data-mobile-view]`), keeping the wide layout free of any width
     * detection.
     */
    const [mobileView, setMobileView] = useState<'panel' | 'messages'>('panel');

    const [folders, setFolders] = useState<MailFolder[]>([]);
    const [foldersLoading, setFoldersLoading] = useState(false);
    const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
    const selectedFolderIdRef = useRef<number | null>(null);
    selectedFolderIdRef.current = selectedFolderId;
    /**
     * Jeton du dossier ouvert, incrémenté à chaque changement de sélection. Ouvrir
     * un dossier lance une suite d'allers-retours qui dure bien plus qu'un clic :
     * chaque étape se compare à ce jeton et s'arrête si elle appartient au dossier
     * précédent, ce qui empêche les messages d'atterrir dans un autre.
     */
    const folderRunRef = useRef(0);
    /** Jeton de la relève en vol, s'il y en a une (`null` sinon). */
    const syncRunRef = useRef<number | null>(null);

    const [messages, setMessages] = useState<MailMessageSummary[]>([]);
    const [nextCursor, setNextCursor] = useState<MailMessageCursor | null>(null);
    /** The folder has no older mail left on the server: the scroll can stop. */
    const [reachedFolderStart, setReachedFolderStart] = useState(false);
    const [messagesLoading, setMessagesLoading] = useState(false);
    /**
     * Le dernier chargement de la liste a échoué : le défilement n'en relance
     * plus aucun de lui-même, sans quoi chaque échec en déclenche aussitôt un
     * autre contre le serveur de mail. Un bouton reprend.
     */
    const [loadFailed, setLoadFailed] = useState(false);
    /**
     * Une page 0 est en vol : ce qui est à l'écran appartient encore au dossier
     * qu'on vient de quitter, puisque la liste n'est pas vidée pour éviter qu'elle
     * ne saute. Distinct de `messagesLoading`, qui couvre aussi la pagination, où
     * le contenu affiché reste juste.
     */
    const [firstPageLoading, setFirstPageLoading] = useState(false);
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
    /** `null` while not searching, distinct from `[]`, which means "searched, found nothing". */
    const [searchResults, setSearchResults] = useState<MailMessageSummary[] | null>(null);
    const [searching, setSearching] = useState(false);
    const [searchTruncated, setSearchTruncated] = useState(false);
    /** False when the IMAP leg couldn't run: results then cover only what was synced. */
    const [searchRemote, setSearchRemote] = useState(false);

    const [messagePopupOpen, setMessagePopupOpen] = useState(false);
    /**
     * Le message ouvert, posé dès le clic et non déduit de `selectedMessage` :
     * changer de mail vide celui-ci le temps de la requête, et le chemin de
     * présence clignoterait alors, ce qu'un déplacement de salle remet à zéro
     * (curseur perdu, frappe périmée).
     */
    const [openMessageId, setOpenMessageId] = useState<number | null>(null);
    const [selectedMessage, setSelectedMessage] = useState<MailMessage | null>(null);
    const [messageLoading, setMessageLoading] = useState(false);

    const [error, setError] = useState<string | null>(null);
    const [reconnecting, setReconnecting] = useState(false);

    /**
     * Referme la fiche, d'un seul geste : le chemin de présence se lit sur
     * `openMessageId`, et un popup laissé ouvert sans lui dirait aux autres qu'on
     * est revenu au dossier tout en montrant une fiche vide.
     */
    const closeMessage = useCallback(() => {
        setMessagePopupOpen(false);
        setOpenMessageId(null);
        setSelectedMessage(null);
    }, []);

    const reloadAccounts = useCallback(async () => {
        try {
            const res = await api.send('mail.accountList', {});
            setAccounts(res.accounts);
            // Son propre échec seulement : cette relecture suit chaque
            // `live.changed` et chaque échec d'une commande, et effacerait le
            // bandeau d'un geste à peine affiché.
            setError((current) => (current === ACCOUNTS_LOAD_ERROR ? null : current));
        } catch {
            setError(ACCOUNTS_LOAD_ERROR);
        } finally {
            setAccountsLoading(false);
        }
    }, []);

    /**
     * Reload the list *and* tell the dashboard widget its count moved: every path
     * that adds or removes a mailbox goes through here, the widget subscribing to
     * `mail.accountCount`.
     */
    const reloadAfterAccountChange = useCallback(async () => {
        invalidate('mail.accountCount');
        await reloadAccounts();
    }, [reloadAccounts]);

    // C'est `live.changed` qui prévient d'un nouveau message, qu'il vienne d'un
    // autre membre ou de la synchro de fond.
    useEffect(() => {
        return onResourceChange('mail.accountList', () => {
            // Une relecture réordonne la liste sous le pointeur ; jamais en plein
            // glisser-déposer.
            if (!draggingRef.current) void reloadAccounts();
        });
    }, [reloadAccounts]);

    // L'avancement d'une relève arrive par trames : elles animent la barre, et
    // `mail.accountList` fait foi, qui rend le même couple à chaque relecture.
    // Rien à redemander, et la liste ne se réordonne pas sous le pointeur, la
    // trame ne touchant que deux champs du compte qu'elle nomme.
    useEffect(
        () =>
            onServerEvent(MAIL_SYNC_PROGRESS_EVENT, mailSyncProgressSchema, (frame) =>
                setAccounts((current) =>
                    current.map((a) =>
                        a.id === frame.accountId ? { ...a, syncing: frame.syncing, syncProgress: frame.progress } : a
                    )
                )
            ),
        []
    );

    // Une boîte qui n'est plus dans la liste ne peut pas rester sélectionnée :
    // supprimée depuis ses réglages, retirée par un autre membre ou départagée,
    // la face du compte n'aurait plus rien à montrer, pas même sa flèche de
    // retour. La sélection tombe, et l'effet suivant ramène à la liste.
    useEffect(() => {
        if (accountsLoading || selectedAccountId === null) return;
        if (!accounts.some((a) => a.id === selectedAccountId)) setSelectedAccountId(null);
    }, [accounts, accountsLoading, selectedAccountId]);

    useEffect(() => {
        // Driven only by the id actually changing, not by every render, so the
        // manual back-arrow toggle (same id, `showAccountList` flipped locally) is
        // never overridden. A selection turning null must still fall back to the
        // list, or slide 2 would be stuck empty with no way back to it.
        setShowAccountList(selectedAccountId === null);
    }, [selectedAccountId]);

    // Les trois niveaux profonds de Mail, déclarés au moteur de présence : compte,
    // dossier, message ouvert ; la racine `view:mail` vient de l'accueil. Le
    // compte visé est son identifiant nu, appliqué dès que la liste est chargée ;
    // un compte absent s'ignore.
    useLiveItemTarget(
        'l1',
        selectedAccountId === null ? null : String(selectedAccountId),
        !accountsLoading,
        (value) => {
            if (value === null) {
                setSelectedAccountId(null);
                return;
            }
            const id = Number(value);
            if (!accounts.some((a) => a.id === id)) return;
            setSelectedAccountId(id);
            setMobileView('messages');
        }
    );
    const folderTarget = useLiveSegment('l2', selectedFolderId === null ? null : String(selectedFolderId));
    // Le mail ouvert est un lieu à part entière : sans ce niveau, deux personnes
    // qui lisent deux messages du même dossier ont le même chemin, et le serveur
    // leur envoie mutuellement leurs curseurs par-dessus des popups qui ne
    // montrent pas la même chose.
    const messageTarget = useLiveSegment('l3', openMessageId === null ? null : String(openMessageId));
    useSubView(selectedAccountId !== null && !showAccountList ? 'account' : null);

    // Le dossier visé attend l'arborescence de son compte. La cible est redonnée
    // à chaque rendu tant qu'elle n'est pas atteinte : cette garde attend que les
    // données arrivent, sans rien à acquitter ni à mémoriser.
    useEffect(() => {
        if (!folderTarget) return;
        if (folderTarget.value === null) return;
        const id = Number(folderTarget.value);
        // `loadFolders` sélectionne d'office la boîte de réception : on ne
        // corrige qu'une fois l'arborescence du compte visé effectivement là.
        if (!folders.some((f) => f.id === id)) return;
        setSelectedFolderId(id);
    }, [folderTarget, folders]);

    const loadFolders = useCallback(async (accountId: number) => {
        setFoldersLoading(true);
        try {
            const res = await withSecrecy(() => api.send('mail.folderList', { accountId }));
            setFolders(res.folders);
            setError(null);
            // Land on the inbox by default.
            const inbox = res.folders.find((f) => f.specialUse === 'inbox') ?? res.folders[0] ?? null;
            setSelectedFolderId(inbox?.id ?? null);
        } catch (e) {
            setFolders([]);
            setSelectedFolderId(null);
            setError(humanizeError(e, 'Chargement des dossiers impossible.'));
            // Le serveur vient d'inscrire l'échec sur le compte : relire la
            // liste fait apparaître la pastille et le bandeau sans que
            // l'utilisateur ait à redemander quoi que ce soit.
            invalidate('mail.accountList');
        } finally {
            setFoldersLoading(false);
        }
    }, []);

    useEffect(() => {
        setMessages([]);
        closeMessage();
        setSelectedFolderId(null);
        if (selectedAccountId !== null) void loadFolders(selectedAccountId);
        else setFolders([]);
    }, [selectedAccountId, loadFolders]);

    /**
     * Relit l'arborescence sans toucher à la sélection, ce qui remet les compteurs
     * de non-lus d'aplomb après une relève de fond. Pas `loadFolders`, qui
     * retomberait d'office sur la boîte de réception ; pas de `foldersLoading` ni
     * de `withSecrecy` : un rafraîchissement que personne n'a demandé ne doit pas
     * faire surgir l'invite de déverrouillage.
     */
    const refreshFolders = useCallback(async () => {
        const accountId = selectedAccountIdRef.current;
        if (accountId === null) return;
        try {
            const res = await api.send('mail.folderList', { accountId });
            if (selectedAccountIdRef.current !== accountId) return;
            setFolders(res.folders);
        } catch {
            // On garde l'arborescence affichée : elle reste vraie à un tick près.
        }
    }, []);

    /**
     * One page of the local cache. A null `nextCursor` isn't necessarily the end
     * of the mailbox, only the end of what has been pulled so far, so this reaches
     * past it once, backfilling an older batch from IMAP and re-reading the page.
     * `reachedStart` is the real end of the folder, and the only thing that stops
     * the scroll for good.
     *
     * Rend `false` si la lecture a échoué.
     */
    const loadMessages = useCallback(async (folderId: number, cursor: MailMessageCursor | null): Promise<boolean> => {
        // La lecture appartient au dossier ouvert au moment où elle part ; passé
        // ce point, plus rien ne s'écrit si la sélection a bougé. L'indicateur de
        // chargement appartient déjà à la nouvelle lecture, qui l'éteindra.
        const run = folderRunRef.current;
        const stale = () => folderRunRef.current !== run;
        setMessagesLoading(true);
        setLoadFailed(false);
        if (cursor === null) setFirstPageLoading(true);
        try {
            const page = await withSecrecy(() =>
                api.send('mail.messageList', { folderId, cursor, limit: MESSAGE_PAGE_SIZE })
            );
            if (stale()) return true;
            const messages = page.messages;
            setMessages((prev) => (cursor === null ? messages : [...prev, ...messages]));
            setNextCursor(page.nextCursor);
            setError(null);
            // Posée ici, et pas au bout : à partir de cette ligne, ce qui est à
            // l'écran est bien le dossier sélectionné. Ce qui suit ne fait que
            // l'allonger par le bas, et n'a donc plus à masquer quoi que ce soit.
            if (cursor === null) setFirstPageLoading(false);

            if (page.nextCursor !== null) {
                setReachedFolderStart(false);
                return true;
            }
            // Le cache est tout ce qu'une boîte en pause a à montrer.
            if (selectedPausedRef.current) {
                setReachedFolderStart(true);
                return true;
            }

            // Le cache est épuisé : une seule incursion vers le passé, dont les
            // lignes se posent sous celles déjà affichées.
            const older = await withSecrecy(() =>
                api.send('mail.folderBackfill', { folderId, limit: BACKFILL_BATCH_SIZE })
            );
            if (stale()) return true;
            setReachedFolderStart(older.reachedStart);
            if (older.addedCount === 0) return true;

            const refetched = await withSecrecy(() =>
                api.send('mail.messageList', {
                    folderId,
                    cursor: cursorOf(messages[messages.length - 1]) ?? cursor,
                    limit: MESSAGE_PAGE_SIZE
                })
            );
            if (stale()) return true;
            setMessages((prev) => [...prev, ...refetched.messages]);
            setNextCursor(refetched.nextCursor);
            return true;
        } catch (e) {
            if (stale()) return true;
            setLoadFailed(true);
            setError(humanizeError(e, 'Chargement des messages impossible.'));
            invalidate('mail.accountList');
            return false;
        } finally {
            if (!stale()) {
                setMessagesLoading(false);
                if (cursor === null) setFirstPageLoading(false);
            }
        }
    }, []);

    /**
     * Rafraîchissement du dossier ouvert : une seule page 0, fusionnée en tête.
     * `nextCursor` et `reachedFolderStart` ne bougent pas, ils décrivent la queue
     * de la liste. C'est le pendant client de la réconciliation serveur, qui porte
     * précisément sur cette page.
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
            const page = await api.send('mail.messageList', { folderId, cursor: null, limit: MESSAGE_PAGE_SIZE });
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

    // Le signal `live.changed`, mais pour ce qu'on est en train de lire : sans ces
    // deux abonnements, la liste ouverte garderait ses messages, ses drapeaux et
    // ses compteurs jusqu'au changement de dossier.
    useEffect(() => onResourceChange('mail.folderList', () => void refreshFolders()), [refreshFolders]);
    useEffect(() => onResourceChange('mail.messageList', () => void refreshMessageHead()), [refreshMessageHead]);

    // Les `live.changed` émis pendant une coupure de socket ne sont annoncés à
    // personne : une relecture au retour, donc, sans quoi une veille de la machine
    // laisse la vue figée sur l'état d'avant. `onSocketOpen` appelle aussi tout de
    // suite quand la socket est déjà ouverte : c'est le chargement initial.
    useEffect(
        () =>
            onSocketOpen(() => {
                void reloadAccounts();
                void refreshFolders();
                void refreshMessageHead();
            }),
        [reloadAccounts, refreshFolders, refreshMessageHead]
    );

    /**
     * Debounced search over the whole folder cache. It has to be a server round
     * trip rather than a filter over `messages`: that array only holds the pages
     * scrolled so far, and the envelopes are encrypted at rest.
     *
     * `cancelled` covers the half of the race the debounce doesn't: a request
     * already in flight when the query changes would otherwise land after the
     * newer one and overwrite fresher results with staler ones.
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
                        api.send('mail.messageSearch', {
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
     * Relève douce du dossier ouvert, à la demande : côté serveur la même passe
     * que la synchro de fond, puis la tête de liste est fusionnée ici. Rien n'est
     * jeté : la position de défilement et les pages déjà déroulées survivent.
     *
     * Une relève déjà en vol pour le même dossier n'est pas relancée, c'est la
     * garde du double-clic ; changer de dossier, en revanche, la périme.
     */
    /**
     * Relève ce qui est ouvert : le dossier s'il y en a un, l'arborescence de la
     * boîte sinon. Le bouton portait autrefois le seul cas du dossier et se
     * désactivait sans lui, c'est-à-dire exactement quand il était le seul
     * recours : une boîte dont les dossiers n'ont pas pu être lus n'offrait plus
     * rien du tout.
     */
    const syncNow = useCallback(async () => {
        const accountId = selectedAccountIdRef.current;
        const folderId = selectedFolderIdRef.current;
        const run = folderRunRef.current;
        if (accountId === null || syncRunRef.current === run) return;
        syncRunRef.current = run;
        setRefreshing(true);
        setError(null);
        try {
            if (folderId === null) {
                await loadFolders(accountId);
                return;
            }
            await withSecrecy(() => api.send('mail.folderSync', { folderId }));
            if (folderRunRef.current !== run) return;
            await refreshMessageHead();
            await refreshFolders();
        } catch (e) {
            if (folderRunRef.current === run) setError(humanizeError(e, 'Relève impossible.'));
        } finally {
            if (syncRunRef.current === run) {
                syncRunRef.current = null;
                setRefreshing(false);
            }
        }
    }, [loadFolders, refreshMessageHead, refreshFolders]);

    /**
     * Ouvrir un dossier : la page la plus récente d'abord, depuis le cache local,
     * donc immédiate, puis une relève IMAP dont seule la tête de liste est
     * refusionnée. Les deux paliers suivent ce chemin : une boîte gardée n'a pas
     * de relève de fond, et c'est ici qu'elle se met à jour. Pas de relève après
     * un chargement en échec : elle buterait au même endroit, et chaque refus
     * d'identifiants rapproche du blocage du serveur de mail.
     */
    const openFolder = useCallback(
        async (folderId: number) => {
            const run = folderRunRef.current;
            const loaded = await loadMessages(folderId, null);
            if (!loaded || folderRunRef.current !== run || selectedPausedRef.current) return;
            await syncNow();
        },
        [loadMessages, syncNow]
    );

    useEffect(() => {
        // Tout ce qui est encore en vol appartient au dossier qu'on quitte : ce
        // jeton le périme d'un coup, y compris les étapes pas encore parties.
        folderRunRef.current += 1;
        closeMessage();
        setReachedFolderStart(false);
        // A query only ever means something for the folder it was typed in.
        setSearch('');
        if (selectedFolderId !== null) void openFolder(selectedFolderId);
        else setMessages([]);
    }, [selectedFolderId, openFolder]);

    /*
     * The paginated list and the search results are two views of the same rows, so
     * every local row mutation has to hit both: otherwise marking a message read
     * from a search result leaves it bold the moment you clear the query.
     * `searchResults` stays `null` when not searching, so the second update is a
     * no-op then.
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

    /**
     * Ouvre un message par son identifiant, et non par sa ligne : la
     * téléportation en vise un sans forcément tenir la ligne qui le porte, et
     * `mail.messageGet` n'a jamais eu besoin de plus.
     */
    const openMessage = useCallback(
        async (messageId: number, allowRemoteImages = false) => {
            setMessagePopupOpen(true);
            setOpenMessageId(messageId);
            setMessageLoading(true);
            // Keep showing the current content only while re-fetching the SAME
            // message (to unblock its images): opening a different one must never
            // flash the previous message's content, so clear it up front.
            setSelectedMessage((prev) => (prev && prev.id === messageId ? prev : null));
            try {
                const res = await withSecrecy(() => api.send('mail.messageGet', { messageId, allowRemoteImages }));
                setSelectedMessage(res.message);
                // Reflect the read state in the list without a full reload.
                patchMessage(messageId, { seen: true });
                // L'émetteur n'est pas prévenu de sa propre écriture : le badge
                // du dossier se relit ici.
                void refreshFolders();
            } catch (e) {
                setError(humanizeError(e, 'Ouverture du message impossible.'));
                invalidate('mail.accountList');
            } finally {
                setMessageLoading(false);
            }
        },
        [patchMessage, refreshFolders]
    );

    /**
     * Le message visé attend que son dossier soit posé (`folderTarget` éteint) et
     * que sa page soit lue : l'ouvrir plus tôt le ferait refermer aussitôt par
     * l'effet de changement de dossier. La cible est redonnée à chaque rendu tant
     * qu'elle n'est pas atteinte, comme celle du dossier.
     */
    useEffect(() => {
        if (!messageTarget || folderTarget || messagesLoading) return;
        if (messageTarget.value === null) {
            closeMessage();
            return;
        }
        void openMessage(Number(messageTarget.value));
    }, [messageTarget, folderTarget, messagesLoading, openMessage]);

    const selectedAccount = accounts.find((a) => a.id === selectedAccountId) ?? null;
    const accountStatus = selectedAccount ? describeAccountStatus(selectedAccount) : null;
    selectedAccountIdRef.current = selectedAccountId;
    selectedPausedRef.current = selectedAccount?.planPaused ?? false;
    const selectedFolder = folders.find((f) => f.id === selectedFolderId) ?? null;

    /**
     * La reconnexion depuis le bandeau, là où l'on apprend qu'elle est
     * nécessaire : les réglages restent le chemin long. Les dossiers sont
     * relus derrière, la boîte n'ayant rien pu en rendre tant que l'accès
     * était refusé.
     */
    async function reconnect(): Promise<void> {
        if (!selectedAccount) return;
        setReconnecting(true);
        try {
            await reconnectAccount(selectedAccount);
            await reloadAccounts();
            await loadFolders(selectedAccount.id);
        } catch (e) {
            setError(humanizeError(e, 'Reconnexion impossible.'));
        } finally {
            setReconnecting(false);
        }
    }

    // Reads the selection through the ref so the callback stays stable for the
    // whole session instead of being rebuilt on every mailbox pick.
    const openAccountForm = useCallback(
        async (account: MailAccount | null) => {
            const result: AccountPopupResult = await OpenPopup(ACCOUNT_POPUP, account);
            if (result === null) return;
            try {
                if (result === 'delete' && account) {
                    await api.send('mail.accountDelete', { id: account.id });
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
            api.send('mail.accountReorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reloadAccounts();
            });
        },
        [reloadAccounts]
    );

    const toggleAccountEnabled = useCallback(
        (a: MailAccount) =>
            void withAccountBusy(a.id, async () => {
                await api.send('mail.accountSetEnabled', { id: a.id, enabled: !a.enabled });
            }),
        [withAccountBusy]
    );

    /*
     * Everything handed down to `MessageList` below is a stable callback: the list
     * and its rows are memoized, so a fresh closure here would defeat that and
     * repaint every row on each refresh.
     */

    /** Applies a flag change to a message, keeping the list row and (if open) the popup in sync. */
    const setMessageFlag = useCallback(
        async (message: MailMessageSummary, patch: Partial<{ seen: boolean; flagged: boolean }>): Promise<void> => {
            try {
                await withSecrecy(() => api.send('mail.messageSetFlags', { messageId: message.id, flags: patch }));
                patchMessage(message.id, patch);
                setSelectedMessage((prev) =>
                    prev && prev.id === message.id ? { ...prev, flags: { ...prev.flags, ...patch } } : prev
                );
                if (patch.seen !== undefined) void refreshFolders();
            } catch (e) {
                setError(humanizeError(e, 'Action impossible.'));
            }
        },
        [patchMessage, refreshFolders]
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

    // Read through refs, never through the closure: depending on the open message
    // or the page cursor would re-create these on every selection and every page,
    // and a changed callback prop invalidates *every* memoized row at once.
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
                await withSecrecy(() => api.send('mail.messageDelete', { messageId: message.id }));
                dropMessage(message.id);
                if (openMessageIdRef.current === message.id) closeMessage();
                void refreshFolders();
            } catch (e) {
                setError(humanizeError(e, 'Suppression impossible.'));
            }
        },
        [dropMessage, refreshFolders]
    );

    const handleSelectMessage = useCallback(
        (message: MailMessageSummary) => void openMessage(message.id),
        [openMessage]
    );

    // Sans curseur, la suite reprend sous la dernière ligne affichée : une page
    // vide, puis l'incursion vers le passé. Repartir de la page 0 effacerait
    // tout ce qui a été déroulé.
    const handleLoadMore = useCallback(() => {
        const folderId = selectedFolderIdRef.current;
        if (folderId === null) return;
        const rows = messagesRef.current;
        void loadMessages(folderId, nextCursorRef.current ?? cursorOf(rows[rows.length - 1]));
    }, [loadMessages]);

    async function downloadAttachment(attachmentId: string): Promise<void> {
        if (!selectedMessage) return;
        try {
            const res = await withSecrecy(() =>
                api.send('mail.attachmentDownload', { messageId: selectedMessage.id, attachmentId })
            );
            window.open(res.downloadUrl, '_blank', 'noopener');
        } catch (e) {
            setError(humanizeError(e, 'Téléchargement impossible.'));
        }
    }

    async function openCompose(): Promise<void> {
        const input: ComposeInput = { accounts, defaultAccountId: selectedAccountId };
        const sent = await OpenPopup<boolean>(COMPOSE_POPUP, input);
        if (sent && selectedFolderId !== null) void loadMessages(selectedFolderId, null);
    }

    // Une boîte qui vient d'autoriser toutes ses images les montre aussitôt sur le message ouvert.
    const openAllowsImages = accounts.some((a) => a.id === selectedMessage?.accountId && a.allowRemoteImages);
    const openBlockedId = selectedMessage?.remoteImagesBlocked ? selectedMessage.id : null;
    useEffect(() => {
        if (openAllowsImages && openBlockedId !== null) void openMessage(openBlockedId);
    }, [openAllowsImages, openBlockedId, openMessage]);

    /** Adds hostnames to the trusted-images list, then reloads the open message so it applies. */
    async function trustImageSources(domains: string[]): Promise<void> {
        try {
            const current = withSettingsDefaults((await api.send('mail.getSettings', {})).settings);
            const merged = Array.from(new Set([...current.trustedImageDomains, ...domains]));
            await api.send('mail.setSettings', { ...current, trustedImageDomains: merged });
            if (selectedMessage) void openMessage(selectedMessage.id);
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
     * One line under the search box while searching: how many matched, and whether
     * the search covered only the local cache. Without that, "3 messages trouvés"
     * in a folder holding thousands reads as a complete answer.
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
        if (searchTruncated) return `Plus de ${noun} : affichage des ${SEARCH_RESULT_LIMIT} plus récents.`;
        return `${noun} trouvé${count > 1 ? 's' : ''}${scope}.`;
    })();

    // L'état de la vue, posé une fois : les trois surfaces qui s'en servent (les
    // deux colonnes vides et le bouton de relève) répondaient chacune à leur
    // façon, et se contredisaient dès qu'une boîte n'avait pas de dossiers.
    const viewState = mailViewState({
        accountsLoading,
        foldersLoading,
        accounts,
        selectedAccount,
        folders,
        selectedFolderId
    });

    const refreshLabel = selectedFolderId === null ? 'Relever les dossiers' : 'Relever le dossier ouvert';

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
                    {/* La relève de ce qui est ouvert, à côté du bouton commun :
                        c'est un geste de fenêtre, pas un réglage. Elle fait le même
                        travail que la synchro de fond sans attendre son passage ; la
                        reconstruction du cache, elle, est dans l'onglet Avancé. */}
                    <button
                        type='button'
                        className={styles.iconBtn}
                        title={refreshLabel}
                        aria-label={refreshLabel}
                        disabled={selectedAccountId === null || refreshing}
                        onClick={() => void syncNow()}
                    >
                        <span className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`} />
                    </button>
                    {/* Le bouton commun, comme partout. Sa cible suit la
                        sélection : la fonctionnalité quand aucune boîte n'est
                        ouverte, la boîte sélectionnée sinon ; ses onglets
                        (Général, Synchronisation, Chiffrement) remplacent les
                        deux popups artisanales d'avant. Partage et Permissions
                        viennent de la coquille ; l'onglet Partage n'est pas
                        proposé pour une boîte protégée, que le serveur
                        refuserait de projeter (chiffrée par le mot de passe). */}
                    <FeatureSettingsButton
                        scope={
                            selectedAccount
                                ? {
                                      kind: 'item',
                                      feature: 'mail',
                                      itemId: String(selectedAccount.id),
                                      itemLabel: selectedAccount.displayName,
                                      shareable: selectedAccount.securityTier === 'open'
                                  }
                                : { kind: 'feature', feature: 'mail' }
                        }
                        // Supprimée ou déplacée depuis ses réglages, la boîte
                        // n'est plus ici : la sélection retombe sur la liste.
                        onGone={() => setSelectedAccountId(null)}
                    />
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

            {/* L'état de la boîte ouverte, avant même qu'on ait tenté quoi que ce
                soit : il est porté par le compte, écrit par la dernière opération
                d'où qu'elle vienne, et donc déjà là au premier affichage. C'est ce
                qui remplace le « la liste est vide, allez savoir pourquoi ». */}
            {accountStatus && (
                <div className={styles.accountAlert} data-tone={accountStatus.tone} role='status'>
                    <span className='icon icon-x-circle' />
                    <span>
                        {accountStatus.headline}
                        {selectedAccount?.lastSyncError && (
                            <span className={styles.accountAlertDetail}>{selectedAccount.lastSyncError}</span>
                        )}
                        {selectedAccount && canReconnect(selectedAccount) && (
                            <span className={styles.accountAlertAction}>
                                <Button variant='secondary' disabled={reconnecting} onClick={() => void reconnect()}>
                                    {reconnecting ? 'Connexion…' : `Reconnecter à ${providerLabel(selectedAccount)}`}
                                </Button>
                            </span>
                        )}
                    </span>
                </div>
            )}

            {error && <p className={styles.error}>{error}</p>}

            <PlanPausedNotice count={accounts.filter((a) => a.planPaused).length} one='boîte mail' many='boîtes mail' />

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
                            onToggle={toggleAccountEnabled}
                            onReorder={handleAccountReorder}
                            onDragStateChange={(active) => {
                                draggingRef.current = active;
                            }}
                            onAdd={() => void openAccountForm(null)}
                            folders={folders}
                            viewState={viewState}
                            selectedFolderId={selectedFolderId}
                            onSelectFolder={(f) => {
                                setSelectedFolderId(f.id);
                                setMobileView('messages');
                            }}
                            showList={showAccountList}
                            onShowList={() => setShowAccountList(true)}
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

                    {/* Repère de la voile : `.messageColumn` défile, une voile
                        posée dedans partirait avec le contenu. */}
                    <div className={styles.messageArea}>
                        <div
                            className={`${styles.messageColumn} ${firstPageLoading ? styles.messageColumnBusy : ''}`}
                            ref={messageColumnRef}
                        >
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
                                    loadFailed={loadFailed}
                                    // The status line above already reports an empty
                                    // search, and "aucun message dans ce dossier"
                                    // would be plainly false while a query is on.
                                    emptyLabel={searchMode ? null : 'Aucun message dans ce dossier.'}
                                    scrollRootRef={messageColumnRef}
                                />
                            ) : (
                                <div className={styles.messageColumnEmpty}>
                                    <EmptyState state={viewState} busy={refreshing} onAction={() => void syncNow()} />
                                </div>
                            )}
                        </div>
                        {firstPageLoading && (
                            <div className={styles.listVeil} role='status' aria-label='Chargement du dossier'>
                                <span className={`icon icon-spinner ${styles.listVeilSpinner}`} aria-hidden='true' />
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <AccountPopup />
            <ComposePopup />
            <ConfirmPopup />
            <MessageInfoPopup />
            <MessagePopup
                open={messagePopupOpen}
                message={selectedMessage}
                loading={messageLoading}
                onClose={closeMessage}
                onLoadImages={() => selectedMessage && void openMessage(selectedMessage.id, true)}
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
