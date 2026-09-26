import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
    Button,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    SegmentedControl,
    SelectInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { STATEMENT_LINES_MAX, type StatementImportResult } from '../contracts/statement';

import { api, refreshFinance } from './api';
import { formatDate, formatMoney } from './format';
import { accountOf, activeAccounts, errorNote, signOf } from './shared';
import {
    columnCount,
    columnName,
    csvLines,
    decodeStatement,
    guessMapping,
    headerSignature,
    parseCsvTable,
    type CsvMapping,
    type CsvTable,
    type ParsedStatement
} from './statement/csv';
import { looksLikeOfx, parseOfx } from './statement/ofx';
import styles from './style.module.css';
import type { FinanceBase } from './shared';

/** Un relevé d'un an tient en quelques centaines de kilo-octets : au-delà, ce n'en est pas un. */
const MAX_BYTES = 5 * 1024 * 1024;
const PREVIEW_ROWS = 5;

type Step =
    | { kind: 'pick' }
    | { kind: 'csv'; fileName: string; table: CsvTable; mapping: CsvMapping }
    | { kind: 'ofx'; fileName: string; parsed: ParsedStatement }
    | { kind: 'done'; result: StatementImportResult };

interface ImportDialogProps {
    base: FinanceBase;
    open: boolean;
    /** Le compte que le relevé alimente, choisi d'office depuis sa fiche. */
    accountId: number | null;
    onClose: () => void;
    /** Ouvre les lignes à rapprocher. */
    onReview: () => void;
}

/**
 * L'import d'un relevé exporté de la banque, en CSV ou en OFX. Le fichier est
 * lu dans le navigateur : seules des lignes datées, signées et nommées partent
 * au serveur. Un CSV montre ses colonnes, devinées ou reprises du dernier
 * import du même compte, avant d'envoyer quoi que ce soit.
 */
export function ImportDialog({ base, open, accountId: preset, onClose, onReview }: ImportDialogProps) {
    const accounts = activeAccounts(base.accounts);
    const [accountId, setAccountId] = useState<number>(preset ?? accounts[0]?.id ?? 0);
    const [step, setStep] = useState<Step>({ kind: 'pick' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [openingTaken, setOpeningTaken] = useState(false);

    useEffect(() => {
        if (!open) return;
        setAccountId(preset ?? activeAccounts(base.accounts)[0]?.id ?? 0);
        setStep({ kind: 'pick' });
        setError(null);
        setOpeningTaken(false);
        // À l'ouverture seulement : une liste de comptes relue en cours d'import ne remet rien à zéro.
    }, [open, preset]);

    const account = accountOf(base.accounts, accountId);
    const currency = base.config.currency;

    const parsed = useMemo<ParsedStatement | null>(() => {
        if (step.kind === 'csv') return csvLines(step.table, step.mapping);
        if (step.kind === 'ofx') return step.parsed;
        return null;
    }, [step]);

    const read = async (file: File) => {
        setError(null);
        if (file.size > MAX_BYTES) {
            setError({ message: 'Ce fichier dépasse 5 Mo : ce n’est sans doute pas un relevé.', code: null });
            return;
        }
        setBusy(true);
        try {
            const text = decodeStatement(new Uint8Array(await file.arrayBuffer()));
            if (looksLikeOfx(text)) {
                const statement = parseOfx(text);
                if (statement.lines.length === 0) {
                    setError({ message: 'Aucune opération lue dans ce fichier OFX.', code: null });
                    return;
                }
                setStep({ kind: 'ofx', fileName: file.name, parsed: statement });
                return;
            }
            const table = parseCsvTable(text);
            if (table === null) {
                setError({
                    message:
                        'Ce fichier ne ressemble ni à un CSV ni à un OFX. Exportez le relevé depuis votre banque dans l’un de ces formats.',
                    code: null
                });
                return;
            }
            const saved = (await api.send('finance.importMapping', { accountId })).mapping;
            const width = columnCount(table);
            const fits =
                saved !== null &&
                saved.signature === headerSignature(table) &&
                [saved.date, ...saved.label, saved.amount, saved.debit, saved.credit, saved.balance].every(
                    (index) => index === null || index < width
                );
            const mapping: CsvMapping = fits
                ? {
                      date: saved.date,
                      label: saved.label,
                      amount: saved.amount,
                      debit: saved.debit,
                      credit: saved.credit,
                      balance: saved.balance,
                      dayFirst: saved.dayFirst
                  }
                : guessMapping(table);
            setStep({ kind: 'csv', fileName: file.name, table, mapping });
        } catch (e) {
            setError(errorNote(e, 'Lecture du fichier impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        if (busy || parsed === null || parsed.lines.length === 0 || parsed.lines.length > STATEMENT_LINES_MAX) return;
        if (step.kind !== 'csv' && step.kind !== 'ofx') return;
        setBusy(true);
        setError(null);
        try {
            const { result } = await api.send('finance.statementImport', {
                accountId,
                format: step.kind,
                lines: parsed.lines,
                closing: parsed.closing,
                mapping: step.kind === 'csv' ? { signature: headerSignature(step.table), ...step.mapping } : null
            });
            refreshFinance();
            setStep({ kind: 'done', result });
        } catch (e) {
            setError(errorNote(e, 'Import impossible.'));
        } finally {
            setBusy(false);
        }
    };

    const takeOpening = async (opening: NonNullable<StatementImportResult['opening']>) => {
        if (account === null || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('finance.accountUpdate', {
                accountId: account.id,
                account: {
                    name: account.name,
                    kind: account.kind,
                    color: account.color,
                    initialBalance: opening.balance,
                    openedOn: opening.date,
                    note: account.note,
                    archived: account.archived
                }
            });
            setOpeningTaken(true);
            base.reloadBase();
            refreshFinance();
        } catch (e) {
            setError(errorNote(e, 'Le solde de départ n’a pas pu être repris.'));
        } finally {
            setBusy(false);
        }
    };

    const setMapping = (patch: Partial<CsvMapping>) =>
        setStep((current) =>
            current.kind === 'csv' ? { ...current, mapping: { ...current.mapping, ...patch } } : current
        );

    const tooMany = parsed !== null && parsed.lines.length > STATEMENT_LINES_MAX;
    const count = parsed?.lines.length ?? 0;

    let footer;
    if (step.kind === 'pick') {
        footer = <DialogCancelButton>Annuler</DialogCancelButton>;
    } else if (step.kind === 'done') {
        footer = (
            <>
                <DialogCancelButton>Fermer</DialogCancelButton>
                {step.result.pending > 0 && <Button onClick={onReview}>Rapprocher</Button>}
            </>
        );
    } else {
        footer = (
            <>
                <Button variant='ghost' className={styles.footerStart} onClick={() => setStep({ kind: 'pick' })}>
                    Autre fichier
                </Button>
                <DialogCancelButton>Annuler</DialogCancelButton>
                <Button onClick={() => void submit()} disabled={busy || count === 0 || tooMany}>
                    {busy ? 'Import…' : `Importer ${count} ligne${count > 1 ? 's' : ''}`}
                </Button>
            </>
        );
    }

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Importer un relevé'
            description={
                step.kind === 'pick'
                    ? 'Le relevé exporté depuis l’espace en ligne de votre banque, en CSV ou en OFX.'
                    : step.kind === 'done'
                      ? `Sur « ${account?.name ?? 'ce compte'} ».`
                      : `« ${step.fileName} », sur « ${account?.name ?? 'ce compte'} ».`
            }
            width={step.kind === 'csv' ? 640 : 520}
            onSubmit={step.kind === 'csv' || step.kind === 'ofx' ? () => void submit() : undefined}
            footer={footer}
        >
            <div className={styles.form}>
                {step.kind === 'pick' && (
                    <>
                        {accounts.length > 1 && (
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Compte</span>
                                <SelectInput value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
                                    {accounts.map((entry) => (
                                        <option key={entry.id} value={entry.id}>
                                            {entry.name}
                                        </option>
                                    ))}
                                </SelectInput>
                            </label>
                        )}
                        <Dropzone busy={busy} onFile={(file) => void read(file)} />
                    </>
                )}

                {step.kind === 'csv' && <ColumnsForm table={step.table} mapping={step.mapping} onChange={setMapping} />}

                {parsed !== null && (step.kind === 'csv' || step.kind === 'ofx') && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Aperçu</span>
                        {parsed.lines.length === 0 ? (
                            <p className={styles.placeholder}>
                                Aucune ligne lue avec ces colonnes : vérifiez la date et le montant.
                            </p>
                        ) : (
                            <ul className={styles.rows}>
                                {parsed.lines.slice(0, PREVIEW_ROWS).map((line, index) => (
                                    <li key={index} className={styles.rowStatic}>
                                        <span className={styles.rowText}>
                                            <span className={styles.rowLabel}>
                                                <span className={styles.rowLabelText}>
                                                    {line.label || 'Sans libellé'}
                                                </span>
                                            </span>
                                            <span className={styles.rowMeta}>{formatDate(line.date)}</span>
                                        </span>
                                        <span
                                            className={styles.rowAmount}
                                            data-flow={line.direction === 'in' ? 'in' : undefined}
                                        >
                                            {signOf(line.direction === 'in' ? 'income' : 'expense')}
                                            {formatMoney(line.amount, currency)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <span className={styles.fieldHint}>{summaryOf(parsed, currency)}</span>
                    </div>
                )}

                {tooMany && (
                    <ErrorNote
                        note={{
                            message: `Ce relevé compte ${count} lignes : exportez-le en plusieurs fichiers de ${STATEMENT_LINES_MAX} lignes au plus, par trimestre par exemple.`,
                            code: null
                        }}
                    />
                )}

                {step.kind === 'done' && (
                    <>
                        <dl className={styles.figures}>
                            <div className={styles.figure}>
                                <dt>Nouvelles lignes</dt>
                                <dd>{step.result.added}</dd>
                                <p className={styles.figureNote}>
                                    {step.result.duplicates > 0
                                        ? `${step.result.duplicates} déjà importée${step.result.duplicates > 1 ? 's' : ''}, laissée${step.result.duplicates > 1 ? 's' : ''} de côté`
                                        : 'Aucune déjà importée'}
                                </p>
                            </div>
                            <div className={styles.figure}>
                                <dt>Rangées d’office</dt>
                                <dd>{step.result.matched + step.result.ruled}</dd>
                                <p className={styles.figureNote}>
                                    {step.result.matched} retrouvée{step.result.matched > 1 ? 's' : ''} au livre,{' '}
                                    {step.result.ruled} par vos règles
                                </p>
                            </div>
                            <div className={styles.figure}>
                                <dt>À rapprocher</dt>
                                <dd>{step.result.pending}</dd>
                                <p className={styles.figureNote}>Sur ce compte, cet import et les précédents</p>
                            </div>
                        </dl>
                        {step.result.opening !== null && !openingTaken && (
                            <div className={styles.notice} role='status'>
                                <span className='icon icon-finance' aria-hidden='true' />
                                <p className={styles.noticeText}>
                                    <strong>Reprendre le solde de départ ?</strong> D’après ce relevé, le compte avait{' '}
                                    {formatMoney(step.result.opening.balance, currency)} avant le{' '}
                                    {formatDate(step.result.opening.date)}. Une fois les lignes rapprochées, le livre
                                    tombera juste avec la banque.
                                </p>
                                <Button
                                    variant='secondary'
                                    disabled={busy}
                                    onClick={() => {
                                        const opening = step.result.opening;
                                        if (opening !== null) void takeOpening(opening);
                                    }}
                                >
                                    Reprendre
                                </Button>
                            </div>
                        )}
                    </>
                )}

                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}

/** Ce que le fichier a donné, en une phrase. */
function summaryOf(parsed: ParsedStatement, currency: string): string {
    const dates = parsed.lines.map((line) => line.date).sort();
    const parts: string[] = [];
    if (dates.length > 0) {
        const n = dates.length;
        parts.push(
            `${n} ligne${n > 1 ? 's' : ''} du ${formatDate(dates[0])} au ${formatDate(dates[dates.length - 1])}`
        );
    }
    if (parsed.skipped > 0) {
        parts.push(`${parsed.skipped} laissée${parsed.skipped > 1 ? 's' : ''} de côté, sans date ou sans montant`);
    }
    let text = parts.join(', ');
    if (parsed.closing !== null) {
        text += `${text ? '. ' : ''}Solde annoncé par la banque : ${formatMoney(parsed.closing.balance, currency)} au ${formatDate(parsed.closing.date)}.`;
    } else if (text) {
        text += '.';
    }
    return text;
}

/**
 * Le dépôt du fichier. Un vrai bouton : le clavier et les lecteurs d'écran
 * ouvrent le sélecteur du système, le glisser-déposer n'est qu'un raccourci.
 */
function Dropzone({ busy, onFile }: { busy: boolean; onFile: (file: File) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);

    const onDrop = (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
    };

    return (
        <>
            <button
                type='button'
                className={styles.dropzone}
                data-over={over ? 'true' : undefined}
                disabled={busy}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
            >
                <span className={`icon icon-file ${styles.dropzoneIcon}`} aria-hidden='true' />
                <span className={styles.dropzoneTitle}>{busy ? 'Lecture…' : 'Choisir le fichier du relevé'}</span>
                <span className={styles.dropzoneHint}>
                    CSV, OFX ou QFX. Une ligne déjà importée n’est jamais comptée deux fois.
                </span>
            </button>
            <input
                ref={input}
                type='file'
                hidden
                accept='.csv,.txt,.ofx,.qfx'
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onFile(file);
                    e.target.value = '';
                }}
            />
        </>
    );
}

const AMOUNT_MODES = [
    { value: 'signed', label: 'Une colonne' },
    { value: 'split', label: 'Débit et crédit' }
] as const;

const DATE_ORDERS = [
    { value: 'day', label: 'Jour d’abord, 31/12' },
    { value: 'month', label: 'Mois d’abord, 12/31' }
] as const;

/** Quelle colonne dit quoi. Devinée ou reprise, elle reste corrigeable avant l'envoi. */
function ColumnsForm({
    table,
    mapping,
    onChange
}: {
    table: CsvTable;
    mapping: CsvMapping;
    onChange: (patch: Partial<CsvMapping>) => void;
}) {
    const width = columnCount(table);
    const split = mapping.amount === null;
    const columns = Array.from({ length: width }, (_, index) => {
        const sample = table.rows.find((row) => (row[index] ?? '').trim() !== '')?.[index]?.trim() ?? '';
        const name = columnName(table, index);
        return { index, label: sample && sample !== name ? `${name} (${sample.slice(0, 24)})` : name };
    });

    const select = (value: number | null, set: (index: number | null) => void, optional: boolean) => (
        <SelectInput value={value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))}>
            {optional && <option value=''>Aucune</option>}
            {columns.map((column) => (
                <option key={column.index} value={column.index}>
                    {column.label}
                </option>
            ))}
        </SelectInput>
    );

    return (
        <>
            <div className={styles.formRow}>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Date</span>
                    {select(mapping.date, (index) => onChange({ date: index ?? 0 }), false)}
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Libellé</span>
                    {select(
                        mapping.label[0] ?? null,
                        (index) => onChange({ label: [index ?? 0, ...mapping.label.slice(1)] }),
                        false
                    )}
                </label>
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Complément (facultatif)</span>
                    {select(
                        mapping.label[1] ?? null,
                        (index) =>
                            onChange({
                                label: index === null ? mapping.label.slice(0, 1) : [mapping.label[0] ?? 0, index]
                            }),
                        true
                    )}
                </label>
            </div>

            <div className={styles.field}>
                <span className={styles.fieldLabel}>Montant</span>
                <SegmentedControl
                    aria-label='Colonnes du montant'
                    value={split ? 'split' : 'signed'}
                    options={AMOUNT_MODES}
                    onChange={(mode) =>
                        onChange(
                            mode === 'split'
                                ? { amount: null, debit: mapping.debit ?? 0, credit: mapping.credit ?? 0 }
                                : { amount: mapping.debit ?? mapping.credit ?? 0, debit: null, credit: null }
                        )
                    }
                />
                <span className={styles.fieldHint}>
                    {split
                        ? 'Les sorties dans une colonne, les entrées dans l’autre.'
                        : 'Les sorties en négatif, les entrées en positif.'}
                </span>
            </div>

            <div className={styles.formRow}>
                {split ? (
                    <>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Débit</span>
                            {select(mapping.debit, (index) => onChange({ debit: index }), false)}
                        </label>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Crédit</span>
                            {select(mapping.credit, (index) => onChange({ credit: index }), false)}
                        </label>
                    </>
                ) : (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Montant</span>
                        {select(mapping.amount, (index) => onChange({ amount: index ?? 0 }), false)}
                    </label>
                )}
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Solde (facultatif)</span>
                    {select(mapping.balance, (index) => onChange({ balance: index }), true)}
                </label>
            </div>

            <div className={styles.field}>
                <span className={styles.fieldLabel}>Dates</span>
                <SegmentedControl
                    aria-label='Ordre du jour et du mois'
                    value={mapping.dayFirst ? 'day' : 'month'}
                    options={DATE_ORDERS}
                    onChange={(order) => onChange({ dayFirst: order === 'day' })}
                />
            </div>
        </>
    );
}

export default ImportDialog;
