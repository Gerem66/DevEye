import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, SelectInput, TextInput, randomUuid, useDragReorder } from 'deveye-sdk-client';

import { documentTotals, type MoneyLine } from '../contracts/money';
import type {
    InvoicingLine,
    InvoicingLineInput,
    InvoicingTotals,
    LineKind,
    LineUnit,
    VatRegime
} from '../contracts/domain';
import { errorNote, type ErrorNote as Note } from './errors';
import { amountToInput, formatMoney, parseAmount, parseQuantity, quantityToInput, UNIT_OPTIONS } from './format';
import styles from './style.module.css';

/**
 * L'éditeur de lignes d'un brouillon. Trois partis pris :
 *
 *  - **l'édition se fait dans la page**, jamais par un dialogue par ligne : un
 *    devis se lit de haut en bas, et huit dialogues seraient huit fois perdre le
 *    total des yeux ;
 *  - **des champs de texte et non des champs numériques** : un champ numérique
 *    fait défiler sa valeur à la molette quand il a le focus, et une molette qui
 *    change silencieusement un prix unitaire sur une facture est inacceptable.
 *    Ce qui est tapé n'est jamais réécrit tant que le champ a le focus, et se
 *    normalise en le quittant ;
 *  - **aucun bouton « Enregistrer »** : l'écriture part d'elle-même peu après la
 *    dernière frappe, et le seul geste explicite de cet écran reste l'émission.
 */

/** Une ligne en cours de saisie : les nombres y sont des chaînes, le temps de la frappe. */
interface Draft {
    key: string;
    id: number | null;
    kind: LineKind;
    label: string;
    description: string;
    quantity: string;
    unit: LineUnit;
    unitPrice: string;
    vatRateBp: number;
}

const VAT_CHOICES = [0, 210, 550, 1000, 2000];

function toDraft(line: InvoicingLine): Draft {
    return {
        key: `line-${line.id}`,
        id: line.id,
        kind: line.kind,
        label: line.label,
        description: line.description,
        quantity: quantityToInput(line.quantityMilli),
        unit: line.unit,
        unitPrice: amountToInput(line.unitPrice),
        vatRateBp: line.vatRateBp
    };
}

function emptyDraft(vatRateBp: number): Draft {
    return {
        key: randomUuid(),
        id: null,
        kind: 'service',
        label: '',
        description: '',
        quantity: '1',
        unit: 'day',
        unitPrice: '',
        vatRateBp
    };
}

function moneyOf(draft: Draft): MoneyLine {
    return {
        kind: draft.kind,
        quantityMilli: parseQuantity(draft.quantity) ?? 0,
        unitPrice: parseAmount(draft.unitPrice) ?? 0,
        vatRateBp: draft.vatRateBp
    };
}

/** Une ligne est incomplète quand on ne peut pas lire ses nombres. */
function isBroken(draft: Draft): boolean {
    if (draft.kind === 'text') return draft.label.trim().length === 0;
    return (
        draft.label.trim().length === 0 ||
        parseQuantity(draft.quantity) === null ||
        parseAmount(draft.unitPrice) === null
    );
}

export interface LineEditorProps {
    docId: number;
    lines: readonly InvoicingLine[];
    currency: string;
    vatRegime: VatRegime;
    defaultVatBp: number;
    canWrite: boolean;
    /** Appelé à chaque écriture aboutie, avec ce que le serveur a recalculé. */
    onSaved(lines: readonly InvoicingLine[], totals: InvoicingTotals): void;
    onTotals(totals: InvoicingTotals): void;
    /** L'état de l'enregistrement et, sur un refus, ce qu'il faut en dire. */
    onState(state: 'clean' | 'pending' | 'saving' | 'error', error?: Note): void;
    /** L'éditeur tient des chaînes le temps de la frappe ; ce qui sort d'ici est déjà en entiers. */
    save(lines: readonly InvoicingLineInput[]): Promise<{ lines: readonly InvoicingLine[]; totals: InvoicingTotals }>;
}

export default function LineEditor(props: LineEditorProps) {
    const { canWrite, currency, defaultVatBp, lines, onState, onTotals, save } = props;
    const [drafts, setDrafts] = useState<Draft[]>(() => lines.map(toDraft));
    const cells = useRef(new Map<string, HTMLElement>());
    const timer = useRef<number | null>(null);
    const pending = useRef<Draft[] | null>(null);

    const totals = useMemo(() => documentTotals(drafts.map(moneyOf)), [drafts]);
    useEffect(() => onTotals({ ...totals, vat: [...totals.vat] }), [totals, onTotals]);

    /**
     * Les rappels les plus récents, tenus dans une référence. Sans cela `flush`
     * changeait d'identité à chaque rendu, l'effet de démontage se rejouait, et
     * son nettoyage vidait l'attente à chaque frappe : l'anti-rebond ne servait
     * plus à rien et chaque touche partait sur le fil.
     */
    const latest = useRef({ save, onSaved: props.onSaved, onState });
    latest.current = { save, onSaved: props.onSaved, onState };

    /** L'écriture différée, et son vidage immédiat sur toute sortie. */
    const flush = useCallback(async () => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
        const wanted = pending.current;
        if (wanted === null) return;
        pending.current = null;

        const { save: send, onSaved, onState: report } = latest.current;
        report('saving');
        try {
            const res = await send(
                wanted.map((draft) => ({
                    id: draft.id,
                    kind: draft.kind,
                    label: draft.label,
                    description: draft.description,
                    quantityMilli: parseQuantity(draft.quantity) ?? 0,
                    unit: draft.unit,
                    unitPrice: parseAmount(draft.unitPrice) ?? 0,
                    vatRateBp: draft.vatRateBp
                }))
            );
            onSaved(res.lines, res.totals);
            // Les identifiants rendus par le serveur remplacent les clés
            // provisoires : sans cela, la frappe suivante recréerait les lignes.
            setDrafts((current) =>
                current.map((draft, index) => {
                    const saved = res.lines[index];
                    return saved === undefined || draft.id !== null ? draft : { ...draft, id: saved.id };
                })
            );
            report('clean');
        } catch (e) {
            report('error', errorNote(e, 'Les lignes n’ont pas pu être enregistrées.'));
        }
    }, []);

    const schedule = useCallback(
        (next: Draft[]) => {
            pending.current = next;
            latest.current.onState('pending');
            if (timer.current !== null) window.clearTimeout(timer.current);
            // Assez long pour qu'on ne parte pas avec « 12 » en route vers
            // « 1 250 », assez court pour qu'un aller-retour ne perde rien.
            timer.current = window.setTimeout(() => void flush(), 700);
        },
        [flush]
    );

    // Toute sortie de l'écran vide l'attente : le démontage est le dernier
    // moment où ce qui a été tapé peut encore être écrit.
    useEffect(() => () => void flush(), [flush]);

    const apply = useCallback(
        (next: Draft[]) => {
            setDrafts(next);
            schedule(next);
        },
        [schedule]
    );

    const patch = (index: number, change: Partial<Draft>) =>
        apply(drafts.map((draft, position) => (position === index ? { ...draft, ...change } : draft)));

    const addLine = (after = drafts.length - 1) => {
        const line = emptyDraft(props.vatRegime === 'exempt' ? 0 : defaultVatBp);
        const next = [...drafts];
        next.splice(after + 1, 0, line);
        apply(next);
        window.setTimeout(() => cells.current.get(`${line.key}:label`)?.focus(), 0);
    };

    const removeLine = (index: number) => {
        const next = drafts.filter((_, position) => position !== index);
        apply(next);
        // Le focus suit la ligne qui prend la place, ou celle d'au-dessus. Sans
        // ligne restante il retombe au document : le bouton d'ajout est juste
        // en dessous, et `Button` ne prend pas de référence.
        const target = next[index] ?? next[index - 1];
        if (target !== undefined) {
            window.setTimeout(() => cells.current.get(`${target.key}:label`)?.focus(), 0);
        }
    };

    const moveLine = (index: number, delta: number) => {
        const target = index + delta;
        if (target < 0 || target >= drafts.length) return;
        const next = [...drafts];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        apply(next);
        window.setTimeout(() => cells.current.get(`${moved.key}:label`)?.focus(), 0);
    };

    const { listRef, barRef, onGripPointerDown, draggingId } = useDragReorder<HTMLOListElement, HTMLLIElement>({
        ids: drafts.map((draft) => draft.key),
        rowSelector: `.${styles.lineRow}`,
        onReorder: (ids) => {
            const byKey = new Map(drafts.map((draft) => [draft.key, draft]));
            apply(ids.map((id) => byKey.get(String(id))).filter((draft): draft is Draft => draft !== undefined));
        },
        layout: 'rows'
    });

    /**
     * Entrée se comporte comme dans un tableur : sur la dernière ligne elle en
     * crée une, ailleurs elle descend dans la même colonne. Une seule phrase à
     * apprendre, et aucune insertion au milieu par surprise.
     */
    const onKeyDown = (event: React.KeyboardEvent, index: number, field: string) => {
        if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            moveLine(index, event.key === 'ArrowUp' ? -1 : 1);
            return;
        }
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        if (index === drafts.length - 1) {
            addLine(index);
            return;
        }
        cells.current.get(`${drafts[index + 1].key}:${field}`)?.focus();
    };

    const bind = (key: string) => (element: HTMLElement | null) => {
        if (element === null) cells.current.delete(key);
        else cells.current.set(key, element);
    };

    const broken = drafts.filter(isBroken).length;

    return (
        <div className={styles.editor}>
            <div className={styles.lineHead} aria-hidden='true'>
                <span className={styles.headLabel}>Désignation</span>
                <span className={styles.headNum}>Qté</span>
                <span className={styles.headText}>Unité</span>
                <span className={styles.headNum}>Prix unitaire</span>
                <span className={styles.headText}>TVA</span>
                <span className={styles.headNum}>Total HT</span>
                <span />
            </div>

            <ol className={styles.lines} ref={listRef}>
                {drafts.map((draft, index) => {
                    const net = documentTotals([moneyOf(draft)]).netCents;
                    return (
                        <li
                            key={draft.key}
                            className={`${styles.lineRow} ${draft.kind === 'text' ? styles.lineRowNote : ''} ${
                                isBroken(draft) ? styles.lineBroken : ''
                            } ${draggingId === draft.key ? styles.lineDragging : ''}`}
                            role='group'
                            aria-label={`Ligne ${index + 1}`}
                        >
                            <span
                                className={`icon ${styles.lineGrip} icon-drag`}
                                aria-hidden='true'
                                onPointerDown={(e) => canWrite && onGripPointerDown(e, draft.key)}
                            />

                            <TextInput
                                ref={bind(`${draft.key}:label`)}
                                className={styles.cellLabel}
                                value={draft.label}
                                disabled={!canWrite}
                                aria-label={`Désignation, ligne ${index + 1}`}
                                placeholder='Ce que vous facturez'
                                onChange={(e) => patch(index, { label: e.target.value })}
                                onKeyDown={(e) => onKeyDown(e, index, 'label')}
                            />

                            {draft.kind === 'text' ? (
                                <span className={styles.cellNote}>Commentaire, sans montant</span>
                            ) : (
                                <>
                                    <TextInput
                                        ref={bind(`${draft.key}:quantity`)}
                                        className={styles.cellQty}
                                        inputMode='decimal'
                                        value={draft.quantity}
                                        disabled={!canWrite}
                                        aria-label={`Quantité, ligne ${index + 1}`}
                                        onChange={(e) => patch(index, { quantity: e.target.value })}
                                        onBlur={() => {
                                            const milli = parseQuantity(draft.quantity);
                                            if (milli !== null) patch(index, { quantity: quantityToInput(milli) });
                                        }}
                                        onKeyDown={(e) => onKeyDown(e, index, 'quantity')}
                                    />

                                    <SelectInput
                                        className={styles.cellUnit}
                                        value={draft.unit}
                                        disabled={!canWrite}
                                        aria-label={`Unité, ligne ${index + 1}`}
                                        onChange={(e) => patch(index, { unit: e.target.value as LineUnit })}
                                    >
                                        {UNIT_OPTIONS.map((option) => (
                                            <option key={option.value} value={option.value}>
                                                {option.label}
                                            </option>
                                        ))}
                                    </SelectInput>

                                    <TextInput
                                        ref={bind(`${draft.key}:unitPrice`)}
                                        className={styles.cellPrice}
                                        inputMode='decimal'
                                        value={draft.unitPrice}
                                        disabled={!canWrite}
                                        aria-label={`Prix unitaire hors taxes, ligne ${index + 1}`}
                                        onChange={(e) => patch(index, { unitPrice: e.target.value })}
                                        onBlur={() => {
                                            const cents = parseAmount(draft.unitPrice);
                                            if (cents !== null) patch(index, { unitPrice: amountToInput(cents) });
                                        }}
                                        onKeyDown={(e) => onKeyDown(e, index, 'unitPrice')}
                                    />

                                    {props.vatRegime === 'exempt' ? (
                                        // Un déroulant désactivé sur « 0 % » aurait l'air d'une
                                        // panne : en franchise, c'est un fait, pas un choix.
                                        <span className={styles.cellVatOff}>Sans TVA</span>
                                    ) : (
                                        <SelectInput
                                            className={styles.cellVat}
                                            value={String(draft.vatRateBp)}
                                            disabled={!canWrite}
                                            aria-label={`Taux de TVA, ligne ${index + 1}`}
                                            onChange={(e) => patch(index, { vatRateBp: Number(e.target.value) })}
                                        >
                                            {VAT_CHOICES.map((bp) => (
                                                <option key={bp} value={String(bp)}>
                                                    {(bp / 100).toString().replace('.', ',')} %
                                                </option>
                                            ))}
                                        </SelectInput>
                                    )}

                                    {/* Calculé, donc `output` ; muet, parce qu'un total
                                        qui parle à chaque frappe est insupportable. */}
                                    <output className={styles.cellTotal} aria-live='off'>
                                        {formatMoney(net, currency)}
                                    </output>
                                </>
                            )}

                            {canWrite && (
                                <button
                                    type='button'
                                    className={styles.lineDrop}
                                    aria-label={`Retirer la ligne ${index + 1}`}
                                    onClick={() => removeLine(index)}
                                >
                                    <span className='icon icon-trash' aria-hidden='true' />
                                </button>
                            )}
                        </li>
                    );
                })}
                {/* La barre d'insertion, seule chose qui bouge pendant le geste. Un
                    `<li>`, seul enfant valide d'une `<ol>` ; en absolu, elle
                    n'occupe aucune place. Sans elle, le glissé n'aboutit pas :
                    c'est sa position qui dit l'interstice visé. */}
                <li ref={barRef} className={styles.dropBar} aria-hidden='true' />
            </ol>

            {canWrite && (
                <div className={styles.editorActions}>
                    <Button variant='secondary' icon='add' onClick={() => addLine()}>
                        Ajouter une ligne
                    </Button>
                    <Button
                        variant='ghost'
                        onClick={() => {
                            const line = { ...emptyDraft(0), kind: 'text' as LineKind };
                            apply([...drafts, line]);
                            window.setTimeout(() => cells.current.get(`${line.key}:label`)?.focus(), 0);
                        }}
                    >
                        Ajouter un commentaire
                    </Button>
                    <p className={styles.editorHint}>
                        Entrée passe à la ligne suivante, et en crée une à la fin. Alt et les flèches déplacent une
                        ligne.
                    </p>
                </div>
            )}

            {broken > 0 && (
                <p className={styles.editorWarn} role='status'>
                    {broken === 1 ? 'Une ligne est à compléter' : `${broken} lignes sont à compléter`} : sans
                    désignation ni montant lisible, le document ne peut pas être émis.
                </p>
            )}
        </div>
    );
}
