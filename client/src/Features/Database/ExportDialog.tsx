import { useEffect, useMemo, useState } from 'react';
import type { DatabaseExportFormat, DatabaseIdRange, DatabaseTable } from '@deveye/types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import { compareTables, formatBytes, formatCount } from './format';
import styles from './style.module.css';

interface ExportDialogProps {
    open: boolean;
    databaseId: number;
    /** L'inventaire chargé, s'il l'est : c'est lui qui peuple la liste. */
    tables: DatabaseTable[] | null;
    /** La table affichée, proposée par défaut ; `null` = toute la base. */
    table: DatabaseTable | null;
    onClose: () => void;
}

const FORMAT_LABELS: Record<DatabaseExportFormat, string> = {
    csv: 'CSV — une ligne par enregistrement, ouvrable dans un tableur',
    json: 'JSON — une entrée par table, valeurs telles quelles',
    sql: 'SQL — des INSERT, rejouables sur une autre base'
};

/** La valeur du sélecteur qui désigne la base entière. */
const WHOLE = '*';

/** Une table dans le sélecteur — `schema.name` désigne une table sans ambiguïté. */
function keyOf(table: DatabaseTable): string {
    return `${table.schema}.${table.name}`;
}

/**
 * « 1-50, 80, 200- » → des bornes.
 *
 * Analysé **ici**, dans le navigateur : le serveur ne reçoit que des paires de
 * nombres, jamais ce texte. Une saisie incompréhensible ne bloque rien — les
 * morceaux valides sont gardés, les autres ignorés, et l'écran dit combien de
 * lignes la sélection représente pour qu'une faute de frappe se voie.
 *
 * Une borne ouverte (`200-`, `-99`) est bornée par l'entier sûr le plus grand :
 * c'est un `BETWEEN`, il lui faut deux bouts, et aucun identifiant réel ne les
 * atteint.
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
 * Exporter une table, ou toute la base.
 *
 * ## Ce que l'écran promet, il le tient
 *
 * L'export lit **tout** ce que la portée désigne. Il portait autrefois un bandeau
 * d'avertissement et un plafond de vingt mille lignes ; un export qui s'arrête au
 * milieu n'est pas un export, et prévenir n'y changeait rien. Ce qui reste au
 * serveur est un garde-fou mémoire, placé là où un export réel n'arrive pas.
 *
 * À la place de l'avertissement : une **estimation de taille**, en pied, à côté
 * du bouton. Elle répond à la seule question qu'on se pose avant de cliquer —
 * « est-ce que ça va tenir ? » — et elle suit la portée comme le champ
 * d'identifiants, donc elle réagit à ce qu'on vient de changer.
 *
 * Le téléchargement passe par un `Blob` local : le contenu est déjà dans le
 * navigateur, il n'a pas à repartir vers un serveur pour redescendre.
 */
export function ExportDialog({ open, databaseId, tables, table, onClose }: ExportDialogProps) {
    const [format, setFormat] = useState<DatabaseExportFormat>('csv');
    /** `WHOLE`, ou la clé `schema.name` d'une table. */
    const [scope, setScope] = useState<string>(WHOLE);
    const [ids, setIds] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ rowCount: number; tableCount: number; truncated: boolean } | null>(null);

    /** L'inventaire dans l'ordre où l'on cherche une table. */
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

    /**
     * Ce que pèsera l'export, à la louche.
     *
     * Tirée de la taille que le moteur déclare pour la table — index compris,
     * donc plutôt au-dessus de la vérité pour un CSV, plutôt en dessous pour du
     * SQL où chaque ligne réécrit ses noms de colonnes. C'est un ordre de
     * grandeur, et l'écran ne prétend pas autre chose : il dit « environ ».
     */
    const estimate = useMemo(() => {
        const scoped = target ? [target] : listed;
        if (scoped.length === 0) return null;
        const bytes = scoped.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0);
        const rows = scoped.reduce((sum, t) => sum + (t.rowCount ?? 0), 0);
        // Les plages ne s'appliquent qu'à une table : la part gardée est celle
        // des lignes retenues, faute de mieux, et seulement si l'on sait
        // combien la table en compte.
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
            const res = await ws.send('database.export', {
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
            // Libérer tout de suite : le clic est synchrone, le navigateur a
            // déjà pris ce qu'il lui fallait.
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
                    {/* L'estimation prend la place de gauche : elle n'est pas une
                        action, elle est ce qu'on lit avant d'en déclencher une. */}
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
                            {/* Tout l'inventaire, pas seulement la table ouverte :
                                exporter une autre table demandait de la sélectionner
                                d'abord, alors qu'elle est déjà chargée ici. */}
                            {listed.map((t) => (
                                <option key={keyOf(t)} value={keyOf(t)}>
                                    {t.name}
                                    {t.rowCount === null ? '' : ` (${formatCount(t.rowCount)} l.)`}
                                </option>
                            ))}
                            {listed.length === 0 && table && <option value={keyOf(table)}>{table.name}</option>}
                        </SelectInput>
                    </label>

                    <label className={styles.field}>
                        <span className={styles.label}>Format</span>
                        <SelectInput value={format} onChange={(e) => setFormat(e.target.value as DatabaseExportFormat)}>
                            {(Object.keys(FORMAT_LABELS) as DatabaseExportFormat[]).map((id) => (
                                <option key={id} value={id}>
                                    {FORMAT_LABELS[id]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>

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
