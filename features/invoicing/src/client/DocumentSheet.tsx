import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dialog,
    DialogCancelButton,
    copyText,
    NumberInput,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    StatusBadge,
    TextInput,
    useLiveSegment,
    useResource,
    useResourceVersion,
    useSubView,
    useWorkspacePermissions,
    type ConfirmRequest
} from 'deveye-sdk-client';

import { addDays, leavesAnswerTime } from '../contracts/calendar';
import { formatPercent } from '../contracts/display';
import { depositTotals, quoteDepositBp } from '../contracts/money';
import type {
    InvoicingDoc,
    InvoicingLine,
    InvoicingPayment,
    InvoicingQuotaUsage,
    InvoicingTotals,
    VatRegime
} from '../contracts/domain';
import ClientPicker from './ClientPicker';
import DocumentPreview from './DocumentPreview';
import ErrorNote from './ErrorNote';
import LineEditor from './LineEditor';
import LineTable from './LineTable';
import PaymentsBlock from './PaymentsBlock';
import { printDocument } from './printDocument';
import QuotaNote from './QuotaNote';
import Totals from './Totals';
import { api } from './api';
import { errorNote, type ErrorNote as Note } from './errors';
import {
    deadlineNote,
    formatDate,
    formatMoment,
    formatMoney,
    kindLabel,
    STATUS_TONE,
    statusLabel,
    todayIso
} from './format';
import styles from './style.module.css';

/**
 * La fiche d'un document, dans la silhouette de toutes les fiches de l'app :
 * l'en-tête porte le retour, l'identité et les gestes secondaires ; dessous,
 * une barre d'onglets soulignés ; puis le contenu ; et tout en bas, collé au
 * bord de la popup, le bandeau qui dit les totaux et porte le geste principal
 * (émettre, tirer la facture, encaisser). Rien ne flotte entre les deux.
 *
 * Un brouillon s'édite ici même, en-tête compris : ce n'est pas un élément de
 * la feature (c'est son client qui l'est), donc la règle « tout passe par
 * l'onglet Général » ne le lie pas. Dès l'émission, tout devient lecture seule,
 * et la phrase qui l'accompagne dit la vraie raison.
 */

export interface DocumentSheetProps {
    id: number;
    /** Ce que l'offre permet ce mois-ci, pour le dire AVANT le refus. */
    usage: InvoicingQuotaUsage | null;
    /** Le taux que porte une ligne neuve, tel qu'il est réglé (zéro en franchise). */
    defaultVatBp: number;
    /** La part d'acompte qu'un devis annonce sans en dire une autre. */
    defaultDepositBp: number;
    /** Le régime vivant de l'espace : un brouillon le suit, un document émis garde le sien. */
    vatRegime: VatRegime;
    /** Ce que le bouton de retour annonce : d'où l'on vient. */
    backLabel: string;
    onBack(): void;
    /** Ouvrir la pièce qu'on vient de tirer de celle-ci. */
    onOpen(id: number): void;
}

type SaveState = 'clean' | 'pending' | 'saving' | 'error';
type Tab = 'doc' | 'preview' | 'payments';

const STATE_WORDS: Record<SaveState, string> = {
    clean: 'brouillon enregistré',
    pending: 'modifications en cours…',
    saving: 'enregistrement…',
    error: 'enregistrement impossible'
};

/** Ce que l'émission fait, dit avec le mot du document et sans pronom orphelin. */
function issueWording(doc: InvoicingDoc): { title: string; description: string } {
    if (doc.kind === 'quote') {
        return {
            title: 'Émettre ce devis ?',
            description:
                'Un numéro de devis lui sera attribué et son contenu ne changera plus. Vous pourrez ensuite le marquer accepté ou refusé, puis en tirer la facture.'
        };
    }
    if (doc.kind === 'credit') {
        return {
            title: 'Émettre cet avoir ?',
            description:
                'Un numéro d’avoir lui sera attribué et son contenu ne changera plus. S’il couvre la facture en entier, celle-ci sera annulée.'
        };
    }
    return {
        title: 'Émettre cette facture ?',
        description:
            'Un numéro de facture lui sera attribué et son contenu ne changera plus : une facture émise ne se modifie ni ne se supprime, elle se corrige par un avoir.'
    };
}

export default function DocumentSheet({
    id,
    usage,
    defaultVatBp,
    defaultDepositBp,
    vatRegime: liveVatRegime,
    backLabel,
    onBack,
    onOpen
}: DocumentSheetProps) {
    const canWrite = useWorkspacePermissions().canFeature('invoicing', 'write');
    const [doc, setDoc] = useState<InvoicingDoc | null>(null);
    const [lines, setLines] = useState<readonly InvoicingLine[]>([]);
    const [payments, setPayments] = useState<readonly InvoicingPayment[]>([]);
    const [liveTotals, setLiveTotals] = useState<InvoicingTotals | null>(null);
    const [state, setState] = useState<SaveState>('clean');
    const [error, setError] = useState<Note | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [tab, setTab] = useState<Tab>('doc');
    const [deposit, setDeposit] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);
    /** Ce qui a changé depuis le dernier aperçu : il se relit alors, et pas avant. */
    const [revision, setRevision] = useState(0);
    const [paper, setPaper] = useState<string | null>(null);
    const [paperError, setPaperError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const headerTimer = useRef<number | null>(null);
    const copyTimer = useRef<number | null>(null);
    /** Le papier déjà obtenu, et pour quelle révision : inutile de le redemander. */
    const paperCache = useRef<{ revision: number; html: string } | null>(null);

    useLiveSegment('l2', tab);
    useSubView(`document/${tab}`);

    const loadClients = useCallback(
        async () => (await api.send('invoicing.clientList', { archived: false })).clients,
        []
    );
    const { data: clients } = useResource('invoicing.clientList', loadClients, 'Clients illisibles.');

    const load = useCallback(async () => {
        try {
            const res = await api.send('invoicing.doc', { id });
            setDoc(res.doc);
            setLines(res.lines);
            setPayments(res.payments);
            setLiveTotals(res.doc.totals);
        } catch (e) {
            setError(errorNote(e, 'Ce document n’a pas pu être lu.'));
        }
    }, [id]);

    useEffect(() => {
        void load();
    }, [load]);

    /**
     * Le sujet de la feature bat dès qu'un client répond en ligne : la fiche se
     * relit alors d'elle-même, sans que personne rafraîchisse. **Jamais sur un
     * brouillon** : sa vérité est à l'écran, et le relire écraserait ce qui est
     * en train d'être tapé.
     */
    const docVersion = useResourceVersion('invoicing.doc');
    const seenVersion = useRef(docVersion);
    const isDraft = doc === null || doc.status === 'draft';
    useEffect(() => {
        if (docVersion === seenVersion.current) return;
        seenVersion.current = docVersion;
        if (isDraft) return;
        paperCache.current = null;
        setPaper(null);
        setRevision((count) => count + 1);
        void load();
    }, [docVersion, isDraft, load]);

    /**
     * Le régime de l'espace a changé sous un brouillon : l'aperçu gardé en cache
     * porte encore l'ancienne mention, et ses lignes reprennent un autre taux.
     */
    const seenRegime = useRef(liveVatRegime);
    useEffect(() => {
        if (liveVatRegime === seenRegime.current) return;
        seenRegime.current = liveVatRegime;
        if (!isDraft) return;
        paperCache.current = null;
        setPaper(null);
        setRevision((count) => count + 1);
    }, [liveVatRegime, isDraft]);

    /** L'en-tête d'un brouillon part peu après la frappe, comme les lignes. */
    const saveHeader = useCallback((next: InvoicingDoc) => {
        setDoc(next);
        setState('pending');
        if (headerTimer.current !== null) window.clearTimeout(headerTimer.current);
        headerTimer.current = window.setTimeout(() => {
            setState('saving');
            void api
                .send('invoicing.docSave', {
                    id: next.id,
                    kind: next.kind,
                    doc: {
                        clientId: next.clientId,
                        subject: next.subject,
                        intro: next.intro,
                        notes: next.notes,
                        terms: next.terms,
                        purchaseOrder: next.purchaseOrder,
                        performedOn: next.performedOn,
                        dueOn: next.dueOn,
                        validUntil: next.validUntil,
                        depositBp: next.depositBp
                    }
                })
                .then(() => {
                    setState('clean');
                    setPaper(null);
                    setRevision((count) => count + 1);
                    invalidate('invoicing.docList');
                })
                .catch((e) => {
                    setState('error');
                    setError(errorNote(e, 'Enregistrement impossible.'));
                });
        }, 700);
    }, []);

    useEffect(
        () => () => {
            if (headerTimer.current !== null) window.clearTimeout(headerTimer.current);
            if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
        },
        []
    );

    /**
     * Le document imprimable, demandé une fois par révision. L'aperçu et
     * l'impression passent par ici : deux chaînes différentes seraient deux
     * mises en page qui divergent.
     */
    const fetchPaper = useCallback(async (): Promise<string> => {
        const cached = paperCache.current;
        if (cached !== null && cached.revision === revision) return cached.html;
        const res = await api.send('invoicing.paper', { id });
        paperCache.current = { revision, html: res.html };
        setPaper(res.html);
        return res.html;
    }, [id, revision]);

    // L'aperçu ne se prépare qu'une fois regardé, et se refait après une écriture.
    useEffect(() => {
        if (tab !== 'preview') return;
        let cancelled = false;
        setPaperError(null);
        void fetchPaper().catch((e) => {
            if (!cancelled) setPaperError(humanizeError(e, 'L’aperçu n’a pas pu être préparé.'));
        });
        return () => {
            cancelled = true;
        };
    }, [tab, fetchPaper]);

    /**
     * Imprimer est une lecture : pas de relecture du document ni d'invalidation
     * derrière, contrairement à `act`, qui accompagne les écritures.
     */
    const print = async () => {
        setBusy(true);
        setError(null);
        try {
            printDocument(await fetchPaper());
        } catch (e) {
            setError(errorNote(e, 'Le document n’a pas pu être préparé.'));
        } finally {
            setBusy(false);
        }
    };

    const copyLink = async (url: string) => {
        try {
            await copyText(url);
            setCopied(true);
            if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
            copyTimer.current = window.setTimeout(() => setCopied(false), 2500);
        } catch (e) {
            setError(errorNote(e, 'Le lien n’a pas pu être copié.'));
        }
    };

    const act = async (run: () => Promise<unknown>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await run();
            await load();
            setPaper(null);
            setRevision((count) => count + 1);
            invalidate('invoicing.docList', 'invoicing.count', 'invoicing.dashboard', 'invoicing.config');
        } catch (e) {
            setError(errorNote(e, fallback));
        } finally {
            setBusy(false);
            setConfirm(null);
        }
    };

    if (doc === null) {
        return (
            <div className={styles.page}>
                <header className={styles.pageHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        {backLabel}
                    </Button>
                </header>
                {error === null ? <p className={styles.placeholder}>Chargement…</p> : <ErrorNote note={error} />}
            </div>
        );
    }

    const opened = doc;
    const draft = doc.status === 'draft';
    const totals = liveTotals ?? doc.totals;
    const note = deadlineNote(doc.kind, doc.displayStatus, doc.dueOn, doc.validUntil);
    // Le régime d'un brouillon est celui de l'espace, comme le calcule le serveur
    // (`regimeOf`) : passer à la TVA dans les réglages se voit ici sans relire la
    // fiche, ce qu'on ne peut pas faire tant qu'on y tape.
    const vatRegime = draft ? liveVatRegime : doc.vatRegime;
    const withVat = vatRegime === 'standard';
    const wording = issueWording(doc);
    const depositBp = quoteDepositBp(doc, defaultDepositBp);

    const derive = (mode: 'invoice' | 'deposit' | 'credit', percentBp: number, fallback: string) =>
        act(async () => {
            const res = await api.send('invoicing.docDerive', { id: opened.id, mode, percentBp });
            setDeposit(null);
            onOpen(res.doc.id);
        }, fallback);

    const submitDeposit = () => {
        const percent = Number((deposit ?? '').replace(',', '.'));
        if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return;
        void derive('deposit', Math.round(percent * 100), 'L’acompte n’a pas pu être préparé.');
    };

    // Le serveur refuse aussi, mais dire non avant la popup vaut mieux qu'un
    // bouton « Émettre » qui échoue une fois la confirmation donnée. Un jour de
    // marge : le navigateur n'est pas dans le fuseau de l'espace, et cet écran ne
    // doit jamais bloquer ce que le serveur aurait accepté.
    const issue = () => {
        const lenientToday = addDays(todayIso(), -1);
        if (
            opened.kind === 'quote' &&
            opened.validUntil !== null &&
            !leavesAnswerTime(opened.validUntil, lenientToday)
        ) {
            setError({
                message:
                    'Ce devis n’est plus valable assez longtemps : repoussez la date « Valable jusqu’au », votre client doit avoir le temps de répondre.',
                // Le même refus que le serveur : une saisie à corriger, pas un incident.
                code: 'validation',
                section: null,
                clientFiche: false
            });
            return;
        }
        setConfirm({
            ...wording,
            confirmLabel: 'Émettre',
            tone: 'primary',
            onConfirm: () =>
                void act(
                    () => api.send('invoicing.docIssue', { id: opened.id, issuedOn: null }),
                    'Ce document n’a pas pu être émis.'
                )
        });
    };

    /**
     * Le geste principal, un seul, celui qui fait avancer le document : émettre
     * un brouillon, tirer la facture d'un devis accepté, encaisser une facture
     * qui attend. Il vit dans le bandeau du bas, à côté des totaux.
     */
    const primary = (() => {
        if (!canWrite) return null;
        if (draft) {
            return (
                <Button disabled={busy} onClick={issue}>
                    Émettre
                </Button>
            );
        }
        if (doc.kind === 'quote' && doc.status === 'accepted') {
            return (
                <Button
                    disabled={busy}
                    onClick={() => void derive('invoice', 3000, 'La facture n’a pas pu être préparée.')}
                >
                    Créer la facture
                </Button>
            );
        }
        if (doc.kind === 'invoice' && doc.remainingCents > 0 && doc.displayStatus !== 'cancelled') {
            return (
                <Button disabled={busy} onClick={() => setTab('payments')}>
                    Enregistrer un règlement
                </Button>
            );
        }
        return null;
    })();

    /**
     * La remise au client, en section à part entière : le lien d'abord, puisque
     * c'est par lui que le document arrive et que la réponse revient, puis la
     * réponse elle-même. La noter à la main reste possible, mais en voie de
     * secours : c'est le client qui répond, pas l'émetteur à sa place.
     */
    const delivery = (() => {
        const quote = doc.kind === 'quote';
        const answered = doc.status === 'accepted' || doc.status === 'declined';
        const url = doc.publicUrl;

        const share = (revoke: boolean) =>
            void act(
                () => api.send('invoicing.share', { id: opened.id, revoke }),
                revoke ? 'Le lien n’a pas pu être révoqué.' : 'Le lien n’a pas pu être préparé.'
            );

        const mark = (status: 'accepted' | 'declined') => () =>
            void act(
                () => api.send('invoicing.docStatus', { id: opened.id, status }),
                status === 'accepted'
                    ? 'Ce devis n’a pas pu être marqué accepté.'
                    : 'Ce devis n’a pas pu être marqué refusé.'
            );

        const sendByMail = () =>
            setConfirm({
                title: 'Envoyer au client ?',
                description:
                    'Le document part depuis le compte mail réglé dans Facturation, à l’adresse de la fiche du client. Il voyage dans le corps du message, avec son lien en ligne.',
                confirmLabel: 'Envoyer',
                tone: 'primary',
                onConfirm: () =>
                    void act(async () => {
                        const res = await api.send('invoicing.send', { id: opened.id, to: '', message: '' });
                        if (!res.sent) throw new Error(`Le compte mail n’a pas accepté l’envoi à ${res.to}.`);
                    }, 'Le document n’a pas pu être envoyé.')
            });

        return (
            <section className={styles.section}>
                <header className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle}>{quote ? 'Réponse du client' : 'Remise au client'}</h3>
                </header>

                <div className={styles.delivery}>
                    {url === null ? (
                        <>
                            <p className={styles.deliveryNote}>
                                Le lien de ce document a été révoqué : sa page ne s’ouvre plus, pour personne. En créer
                                un autre donnera une autre adresse.
                            </p>
                            {canWrite && (
                                <div className={styles.deliveryActions}>
                                    <Button
                                        variant='secondary'
                                        icon='globe'
                                        disabled={busy}
                                        onClick={() => share(false)}
                                    >
                                        Créer le lien
                                    </Button>
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={styles.deliveryLink}>
                                <a
                                    className={styles.deliveryUrl}
                                    href={url}
                                    target='_blank'
                                    rel='noreferrer'
                                    title='Ouvrir la page du client'
                                >
                                    {url}
                                </a>
                                <div className={styles.deliveryActions}>
                                    <Button
                                        variant='secondary'
                                        icon='copy'
                                        disabled={busy}
                                        onClick={() => void copyLink(url)}
                                    >
                                        {copied ? 'Copié' : 'Copier'}
                                    </Button>
                                    {canWrite && (
                                        <Button variant='secondary' icon='mail' disabled={busy} onClick={sendByMail}>
                                            Envoyer par mail
                                        </Button>
                                    )}
                                    {canWrite && (
                                        <Button
                                            variant='ghost'
                                            disabled={busy}
                                            onClick={() =>
                                                setConfirm({
                                                    title: 'Révoquer ce lien ?',
                                                    description:
                                                        'La page cessera de s’ouvrir, y compris pour un client qui a déjà reçu ce lien. Vous pourrez en créer un autre, mais ce sera une autre adresse.',
                                                    confirmLabel: 'Révoquer',
                                                    tone: 'danger',
                                                    onConfirm: () => share(true)
                                                })
                                            }
                                        >
                                            Révoquer
                                        </Button>
                                    )}
                                </div>
                            </div>
                            <p className={styles.deliveryNote}>
                                Ce lien ouvre le document sans compte ni installation.
                                {quote && !answered && ' Votre client y répond d’un clic, et sa réponse arrive ici.'}
                                {doc.sentAt === null
                                    ? ' Vous ne l’avez pas encore envoyé par mail depuis DevEye.'
                                    : ` Envoyé par mail le ${formatMoment(doc.sentAt)}.`}
                            </p>
                        </>
                    )}

                    {quote && (
                        <div className={styles.deliveryAnswer}>
                            {answered ? (
                                <p className={`${styles.deliveryAnswerText} ${styles.deliveryDone}`}>
                                    <strong>{doc.status === 'accepted' ? 'Accepté' : 'Refusé'}</strong>
                                    {doc.answer === null
                                        ? ' : vous l’avez noté vous-même.'
                                        : ` en ligne le ${formatMoment(doc.answer.at)}${
                                              doc.answer.name.trim().length > 0 ? ` par ${doc.answer.name}` : ''
                                          }.`}
                                </p>
                            ) : (
                                <>
                                    <p className={styles.deliveryAnswerText}>
                                        En attente de sa réponse. S’il répond autrement, notez-la vous-même :
                                    </p>
                                    {canWrite && (
                                        <div className={styles.deliveryActions}>
                                            <Button variant='secondary' disabled={busy} onClick={mark('accepted')}>
                                                Accepté
                                            </Button>
                                            <Button variant='ghost' disabled={busy} onClick={mark('declined')}>
                                                Refusé
                                            </Button>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    )}
                </div>
            </section>
        );
    })();

    const tabs: { id: Tab; label: string; icon: string }[] = [
        { id: 'doc', label: 'Le document', icon: 'file' },
        { id: 'preview', label: 'Aperçu', icon: 'eye-open' },
        ...(doc.kind === 'invoice' && !draft
            ? [
                  {
                      id: 'payments' as const,
                      label: payments.length === 0 ? 'Règlements' : `Règlements (${payments.length})`,
                      icon: 'finance'
                  }
              ]
            : [])
    ];

    return (
        <div className={styles.sheet}>
            <header className={styles.header}>
                <div className={styles.detailHead}>
                    <Button variant='ghost' icon='arrow-left' onClick={onBack}>
                        {backLabel}
                    </Button>
                    <div className={styles.ident}>
                        <h2 className={styles.heading}>
                            {doc.numberLabel ?? `${kindLabel(doc.kind)} en préparation`}
                            {doc.subject.length > 0 && <span className={styles.headingSoft}> · {doc.subject}</span>}
                        </h2>
                        <p className={styles.subheading}>
                            <StatusBadge tone={STATUS_TONE[doc.displayStatus]}>
                                {statusLabel(doc.kind, doc.displayStatus)}
                            </StatusBadge>{' '}
                            {doc.archived && (
                                <>
                                    <StatusBadge tone='neutral'>Archivé</StatusBadge>{' '}
                                </>
                            )}
                            {doc.clientName.length > 0 ? doc.clientName : 'aucun client choisi'}
                            {doc.issuedOn !== null && ` · émis le ${formatDate(doc.issuedOn)}`}
                            {note !== null && ` · ${note}`}
                            {draft && ` · ${STATE_WORDS[state]}`}
                        </p>
                    </div>
                </div>

                <div className={styles.actions}>
                    {canWrite && !draft && doc.kind === 'quote' && doc.status !== 'declined' && (
                        <Button
                            variant='ghost'
                            disabled={busy}
                            onClick={() => setDeposit(String((depositBp || 3000) / 100).replace('.', ','))}
                        >
                            Facture d’acompte
                        </Button>
                    )}

                    {canWrite && !draft && doc.kind === 'invoice' && doc.displayStatus !== 'cancelled' && (
                        <Button
                            variant='ghost'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: 'Créer un avoir ?',
                                    description:
                                        'Une facture émise ne se modifie pas : l’avoir est la façon de la corriger. Il reprend ses lignes, que vous pourrez réduire avant de l’émettre.',
                                    confirmLabel: 'Créer l’avoir',
                                    tone: 'primary',
                                    onConfirm: () => void derive('credit', 3000, 'L’avoir n’a pas pu être préparé.')
                                })
                            }
                        >
                            Créer un avoir
                        </Button>
                    )}

                    {/* Dupliquer, archiver ou supprimer, partir dans un autre
                        espace : un document n'est pas un élément, mais ses
                        réglages s'ouvrent par la même porte. */}
                    <FeatureSettingsButton
                        scope={{
                            kind: 'record',
                            feature: 'invoicing',
                            recordId: String(doc.id),
                            recordLabel: doc.numberLabel ?? `${kindLabel(doc.kind)} en préparation`,
                            description: draft
                                ? 'Dupliquer ce brouillon, l’envoyer dans un autre espace ou le supprimer.'
                                : 'Repartir de ce document vers un brouillon neuf, le copier dans un autre espace ou l’archiver.'
                        }}
                        onGone={onBack}
                        onOpenChange={(open) => {
                            // Un brouillon ne se relit pas : sa vérité est à l'écran.
                            if (!open && !draft) void load();
                        }}
                    />
                </div>
            </header>

            <nav className={styles.tabs} role='tablist'>
                {tabs.map((entry) => (
                    <button
                        key={entry.id}
                        type='button'
                        role='tab'
                        aria-selected={entry.id === tab}
                        className={entry.id === tab ? styles.tabActive : styles.tab}
                        onClick={() => setTab(entry.id)}
                    >
                        <span className={`icon icon-${entry.icon}`} />
                        <span className={styles.tabLabel}>{entry.label}</span>
                    </button>
                ))}
            </nav>

            <div className={styles.sheetBody}>
                <ErrorNote
                    note={error}
                    client={doc.clientId === null ? null : { id: doc.clientId, name: doc.clientName }}
                />

                {tab === 'doc' && !draft && delivery}

                {tab === 'preview' && <DocumentPreview html={paper} error={paperError} />}

                {tab === 'payments' && (
                    <PaymentsBlock
                        doc={doc}
                        payments={payments}
                        canWrite={canWrite}
                        onChanged={(next, nextPayments) => {
                            setDoc(next);
                            setPayments(nextPayments);
                            setLiveTotals(next.totals);
                            setPaper(null);
                            setRevision((count) => count + 1);
                            invalidate('invoicing.docList', 'invoicing.count', 'invoicing.dashboard');
                        }}
                    />
                )}

                {tab === 'doc' && draft && (
                    <div className={styles.headerForm}>
                        <div className={`${styles.field} ${styles.fieldClient}`}>
                            <span className={styles.dialogLabel}>Client</span>
                            <ClientPicker
                                clients={clients ?? null}
                                value={doc.clientId}
                                disabled={!canWrite}
                                onChange={(clientId) => saveHeader({ ...opened, clientId })}
                            />
                        </div>

                        <label className={`${styles.field} ${styles.fieldSubject}`}>
                            <span className={styles.dialogLabel}>Objet</span>
                            <TextInput
                                value={doc.subject}
                                disabled={!canWrite}
                                placeholder='Refonte du site'
                                onChange={(e) => saveHeader({ ...opened, subject: e.target.value })}
                            />
                        </label>

                        <label className={`${styles.field} ${styles.fieldDate}`}>
                            <span className={styles.dialogLabel}>Prestation réalisée le</span>
                            <TextInput
                                type='date'
                                value={doc.performedOn ?? ''}
                                disabled={!canWrite}
                                onChange={(e) => saveHeader({ ...opened, performedOn: e.target.value || null })}
                            />
                        </label>

                        <label className={`${styles.field} ${styles.fieldDate}`}>
                            <span className={styles.dialogLabel}>
                                {doc.kind === 'quote' ? 'Valable jusqu’au' : 'À payer avant le'}
                            </span>
                            <TextInput
                                type='date'
                                value={(doc.kind === 'quote' ? doc.validUntil : doc.dueOn) ?? ''}
                                min={doc.kind === 'quote' ? addDays(todayIso(), 1) : undefined}
                                disabled={!canWrite}
                                placeholder='Selon vos réglages'
                                onChange={(e) =>
                                    saveHeader(
                                        doc.kind === 'quote'
                                            ? { ...opened, validUntil: e.target.value || null }
                                            : { ...opened, dueOn: e.target.value || null }
                                    )
                                }
                            />
                        </label>

                        {doc.kind === 'quote' && (
                            <label className={`${styles.field} ${styles.fieldPercent}`}>
                                <span className={styles.dialogLabel}>Acompte à la commande, en %</span>
                                <NumberInput
                                    value={doc.depositBp === null ? null : doc.depositBp / 100}
                                    min={0}
                                    max={100}
                                    disabled={!canWrite}
                                    placeholder={
                                        defaultDepositBp > 0
                                            ? `${formatPercent(defaultDepositBp)} selon vos réglages`
                                            : 'Aucun'
                                    }
                                    onChange={(value) =>
                                        saveHeader({
                                            ...opened,
                                            depositBp: value === null ? null : Math.round(value * 100)
                                        })
                                    }
                                />
                            </label>
                        )}

                        <label className={`${styles.field} ${styles.fieldRef}`}>
                            <span className={styles.dialogLabel}>Référence de commande</span>
                            <TextInput
                                value={doc.purchaseOrder}
                                disabled={!canWrite}
                                onChange={(e) => saveHeader({ ...opened, purchaseOrder: e.target.value })}
                            />
                        </label>
                    </div>
                )}

                {tab === 'doc' && !draft && (
                    <dl className={styles.readHeader}>
                        <div>
                            <dt>Client</dt>
                            <dd>{doc.clientName}</dd>
                        </div>
                        {doc.performedOn !== null && (
                            <div>
                                <dt>Prestation</dt>
                                <dd>{formatDate(doc.performedOn)}</dd>
                            </div>
                        )}
                        {doc.dueOn !== null && (
                            <div>
                                <dt>Échéance</dt>
                                <dd>{formatDate(doc.dueOn)}</dd>
                            </div>
                        )}
                        {doc.validUntil !== null && (
                            <div>
                                <dt>Valable jusqu’au</dt>
                                <dd>{formatDate(doc.validUntil)}</dd>
                            </div>
                        )}
                        {depositBp > 0 && (
                            <div>
                                <dt>Acompte à la commande</dt>
                                <dd>{formatPercent(depositBp)}</dd>
                            </div>
                        )}
                        {doc.parentNumber !== null && (
                            <div>
                                <dt>{doc.kind === 'credit' ? 'Annule la facture' : 'Issu du devis'}</dt>
                                <dd>{doc.parentNumber}</dd>
                            </div>
                        )}
                    </dl>
                )}

                {tab === 'doc' && draft && (
                    <LineEditor
                        key={doc.id}
                        docId={doc.id}
                        lines={lines}
                        currency={doc.currency}
                        vatRegime={vatRegime}
                        defaultVatBp={defaultVatBp}
                        canWrite={canWrite}
                        onSaved={(saved, savedTotals) => {
                            setLines(saved);
                            setLiveTotals(savedTotals);
                            setPaper(null);
                            setRevision((count) => count + 1);
                            invalidate('invoicing.docList');
                        }}
                        onTotals={setLiveTotals}
                        onState={(next, note) => {
                            setState(next);
                            if (note !== undefined) setError(note);
                        }}
                        save={(drafts) => api.send('invoicing.linesSet', { docId: opened.id, lines: [...drafts] })}
                    />
                )}

                {tab === 'doc' && !draft && (
                    <>
                        <LineTable lines={lines} currency={doc.currency} withVat={withVat} />
                        <p className={styles.frozen}>
                            {doc.kind === 'quote'
                                ? 'Ce devis est parti chez votre client : ses lignes ne changent plus.'
                                : 'Ce document est émis : ses lignes ne changent plus. Une erreur se corrige par un avoir.'}
                        </p>
                        <Totals
                            totals={totals}
                            currency={doc.currency}
                            settledCents={doc.settledCents}
                            remainingCents={doc.remainingCents}
                        />
                    </>
                )}
            </div>

            {/* Le bandeau du bas : les totaux qu'on garde sous les yeux en rédigeant,
                la note de TVA, et le seul geste qui fasse avancer le document. */}
            <footer className={styles.sheetFoot}>
                <div className={styles.footTotals}>
                    <span>
                        <span className={styles.footLabel}>Total HT</span>{' '}
                        <strong>{formatMoney(totals.netCents, doc.currency)}</strong>
                    </span>
                    {withVat ? (
                        <span>
                            <span className={styles.footLabel}>TVA</span>{' '}
                            <strong>{formatMoney(totals.vatCents, doc.currency)}</strong>
                        </span>
                    ) : (
                        <span className={styles.footLabel}>Franchise de TVA</span>
                    )}
                    <span>
                        <span className={styles.footLabel}>{withVat ? 'Total TTC' : 'Total'}</span>{' '}
                        <strong className={styles.footGrand}>{formatMoney(totals.grossCents, doc.currency)}</strong>
                    </span>
                    {depositBp > 0 && (
                        <span>
                            <span className={styles.footLabel}>Acompte {formatPercent(depositBp)}</span>{' '}
                            <strong>{formatMoney(depositTotals(totals, depositBp).grossCents, doc.currency)}</strong>
                        </span>
                    )}
                    {!draft && doc.settledCents > 0 && (
                        <span>
                            <span className={styles.footLabel}>Reste à payer</span>{' '}
                            <strong className={styles.footGrand}>
                                {formatMoney(doc.remainingCents, doc.currency)}
                            </strong>
                        </span>
                    )}
                </div>
                <div className={styles.footActions}>
                    {draft && <QuotaNote usage={usage} only={doc.kind} />}
                    <Button variant='secondary' icon='download' disabled={busy} onClick={() => void print()}>
                        Imprimer ou enregistrer en PDF
                    </Button>
                    {primary}
                </div>
            </footer>

            <Dialog
                open={deposit !== null}
                onClose={() => setDeposit(null)}
                onSubmit={submitDeposit}
                title='Facture d’acompte'
                description='Elle portera la part demandée de ce devis, taux de TVA par taux de TVA. La facture de solde la déduira.'
                width={380}
                footer={
                    <>
                        <DialogCancelButton>Annuler</DialogCancelButton>
                        <Button disabled={busy} onClick={submitDeposit}>
                            Préparer l’acompte
                        </Button>
                    </>
                }
            >
                <label className={styles.dialogField}>
                    <span className={styles.dialogLabel}>Part du devis, en pourcentage</span>
                    <TextInput
                        data-autofocus
                        inputMode='decimal'
                        value={deposit ?? ''}
                        onChange={(e) => setDeposit(e.target.value)}
                    />
                </label>
            </Dialog>

            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} busy={busy} />
        </div>
    );
}
