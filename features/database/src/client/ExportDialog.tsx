import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, humanizeError, SegmentedControl, SelectInput, TextInput } from 'deveye-sdk-client';
import type { DatabaseExportFormat, DatabaseIdRange, DatabaseTable } from '../contracts/domain';

import { api } from './api';
import { compareTables, formatBytes, formatCount } from './format';
import styles from './style.module.css';

interface ExportDialogProps {
    open: boolean;
    databaseId: number;
    /** L'inventaire chargé, s'il l'est. */
    tables: DatabaseTable[] | null;
    /** La table affichée, proposée par défaut ; `null` = toute la base. */
    table: DatabaseTable | null;
    onClose: () => void;
}

const FORMATS: { value: DatabaseExportFormat; label: string; title: string }[] = [
    { value: 'csv', label: 'CSV', title: 'Une ligne par enregistrement, ouvrable dans un tableur' },
    { value: 'json', label: 'JSON', title: 'Une entrée par table, valeurs telles quelles' },
    { value: 'sql', label: 'SQL', title: 'Des INSERT, rejouables sur une autre base' }
];

/** La valeur du sélecteur qui désigne la base entière. */
const WHOLE = '*';

/** `schema.name` désigne une table sans ambiguïté. */
function keyOf(table: DatabaseTable): string {
    return `${table.schema}.${table.name}`;
}

/**
 * « 1-50, 80, 200- » en bornes, analysé ici : le serveur ne reçoit que des
 * paires de nombres. Les morceaux invalides sont ignorés. Une borne ouverte
 * vaut l'entier sûr le plus grand : un `BETWEEN` veut deux bouts.
 */
const OPEN = Number.MAX_SAFE_INTEGER;

export function parseIdRanges(input: string): DatabaseIdRange[] {
    const out: DatabaseIdRange[] = [];
    for (const chunk of input.split(/[,;\s]+/)) {
        const piece = chunk.trim();
        if (piece === '') continue;
        const match = /^(-?\d+)?\s*(?:-|–|\.\.)\s*(-?\d+)?$/.exec(piece);
        if (match && (match[1] !== undefined || match[2] !== undefined)) {
            const from = match[1] === undefined ? -OPEN : Number(match[1]);
            const to = match[2] === undefined ? OPEN : Number(match[2]);
            out.push(from <= to ? { from, to } : { from: to, to: from });
            continue;
        }
        if (/^-?\d+$/.test(piece)) {
            const value = Number(piece);
            out.push({ from: value, to: value });
        }
    }
    return out;
}

/** Combien de lignes ces plages désignent, `null` si l'une est ouverte. */
function countOf(ranges: DatabaseIdRange[]): number | null {
    let total = 0;
    for (const range of ranges) {
        if (range.from === -OPEN || range.to === OPEN) return null;
        total += range.to - range.from + 1;
    }
    return total;
}

/**
 * Exporter une table, ou toute la base. L'export lit tout ce que la portée
 * désigne ; une estimation de taille en pied suit la portée et les plages. Le
 * téléchargement passe par un `Blob` local.
 */
export function ExportDialog({ open, databaseId, tables, table, onClose }: ExportDialogProps) {
    const [format, setFormat] = useState<DatabaseExportFormat>('csv');
    /** `WHOLE`, ou `schema.name`. */
    const [scope, setScope] = useState<string>(WHOLE);
    const [ids, setIds] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ rowCount: number; tableCount: number; truncated: boolean } | null>(null);

    const listed = useMemo(() => (tables === null ? [] : [...tables].sort(compareTables)), [tables]);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setDone(null);
        setIds('');
        setScope(table ? keyOf(table) : WHOLE);
    }, [open, table]);

    const target = scope === WHOLE ? null : (listed.find((t) => keyOf(t) === scope) ?? table);
    const ranges = parseIdRanges(ids);
    const selected = countOf(ranges);

    // Un ordre de grandeur, tiré de la taille déclarée par le moteur (index compris).
    const estimate = useMemo(() => {
        const scoped = target ? [target] : listed;
        if (scoped.length === 0) return null;
        const bytes = scoped.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0);
        const rows = scoped.reduce((sum, t) => sum + (t.rowCount ?? 0), 0);
        // Au prorata des lignes retenues, quand la table sait combien elle en compte.
        if (target && selected !== null && ranges.length > 0 && rows > 0) {
            const kept = Math.min(selected, rows);
            return { bytes: Math.round((bytes * kept) / rows), rows: kept };
        }
        return { bytes, rows };
    }, [target, listed, selected, ranges.length]);

    const run = async () => {
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            const res = await api.send('database.export', {
                databaseId,
                format,
                ...(target ? { schema: target.schema, table: target.name } : {}),
                ...(target && ranges.length > 0 ? { idRanges: ranges } : {})
            });

            const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = res.filename;
            link.click();
            // Le clic est synchrone : le navigateur a déjà pris le blob.
            URL.revokeObjectURL(url);

            setDone({ rowCount: res.rowCount, tableCount: res.tableCount, truncated: res.truncated });
        } catch (e) {
            setError(humanizeError(e, 'L’export a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Exporter'
            width={620}
            onSubmit={() => void run()}
            footer={
                <>
                    <span className={styles.footerNote}>
                        {estimate === null
                            ? 'Chargez les tables pour estimer la taille.'
                            : `≈ ${formatBytes(estimate.bytes)} · ${formatCount(estimate.rows)} ligne${estimate.rows > 1 ? 's' : ''}`}
                    </span>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Fermer
                    </Button>
                    <Button icon='download' onClick={() => void run()} disabled={busy}>
                        {busy ? 'Lecture…' : 'Exporter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={styles.section}>
                    <label className={styles.field}>
                        <span className={styles.label}>Portée</span>
                        <SelectInput value={scope} onChange={(e) => setScope(e.target.value)}>
                            <option value={WHOLE}>Toute la base</option>
                            {listed.map((t) => (
                                <option key={keyOf(t)} value={keyOf(t)}>
                                    {t.name}
                                    {t.rowCount === null ? '' : ` (${formatCount(t.rowCount)} l.)`}
                                </option>
                            ))}
                            {listed.length === 0 && table && <option value={keyOf(table)}>{table.name}</option>}
                        </SelectInput>
                    </label>

                    <div className={styles.field}>
                        <span className={styles.label}>Format</span>
                        <SegmentedControl aria-label='Format' options={FORMATS} value={format} onChange={setFormat} />
                        <span className={styles.hint}>
                            {(FORMATS.find((f) => f.value === format) ?? FORMATS[0]).title}.
                        </span>
                    </div>

                    <label className={styles.field}>
                        <span className={styles.label}>Identifiants (facultatif)</span>
                        <TextInput
                            value={ids}
                            disabled={target === null}
                            placeholder='1-500, 812, 2000-'
                            onChange={(e) => setIds(e.target.value)}
                        />
                        <span className={styles.hint}>
                            {target === null ? (
                                <>
                                    Réservé à une table : d’une table à l’autre, la clé primaire n’a ni le même nom ni
                                    le même sens, et « 1 à 500 » ne désignerait pas les mêmes objets.
                                </>
                            ) : (
                                <>
                                    Des valeurs et des plages de la clé primaire, séparées par des virgules ; bornes
                                    comprises. Vide, la table part en entier.
                                    {ranges.length > 0 &&
                                        ` ${ranges.length} plage${ranges.length > 1 ? 's' : ''} retenue${ranges.length > 1 ? 's' : ''}${
                                            selected === null ? '' : `, ${formatCount(selected)} identifiants couverts`
                                        }.`}
                                </>
                            )}
                        </span>
                    </label>
                </div>

                {done && (
                    <p className={done.truncated ? styles.warn : styles.ok}>
                        {formatCount(done.rowCount)} lignes sur {done.tableCount} table
                        {done.tableCount > 1 ? 's' : ''} — fichier téléchargé.
                        {done.truncated &&
                            ' Le garde-fou mémoire du serveur a été atteint : la suite manque. Passez par mysqldump ou pg_dump pour un volume pareil.'}
                    </p>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default ExportDialog;
