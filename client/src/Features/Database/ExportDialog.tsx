import { useEffect, useState } from 'react';
import type { DatabaseExportFormat, DatabaseTable } from 'deveye-types';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import { formatCount } from './format';
import styles from './style.module.css';

interface ExportDialogProps {
    open: boolean;
    databaseId: number;
    /** La table affichée, proposée par défaut ; `null` = toute la base. */
    table: DatabaseTable | null;
    onClose: () => void;
}

const FORMAT_LABELS: Record<DatabaseExportFormat, string> = {
    csv: 'CSV — une ligne par enregistrement, ouvrable dans un tableur',
    json: 'JSON — une entrée par table, valeurs telles quelles',
    sql: 'SQL — des INSERT, rejouables sur une autre base'
};

/**
 * Exporter une table, ou toute la base.
 *
 * **Ce n'est pas une sauvegarde**, et l'écran le dit avant qu'on clique : le
 * résultat traverse la connexion en un seul morceau, donc il est plafonné. Un
 * export tronqué qui se croirait complet serait bien pire que pas d'export du
 * tout — c'est la raison du bandeau, et de l'avertissement rendu par le serveur.
 *
 * Le téléchargement passe par un `Blob` local : le contenu est déjà dans le
 * navigateur, il n'a pas à repartir vers un serveur pour redescendre.
 */
export function ExportDialog({ open, databaseId, table, onClose }: ExportDialogProps) {
    const [format, setFormat] = useState<DatabaseExportFormat>('csv');
    const [scope, setScope] = useState<'table' | 'database'>('table');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<{ rowCount: number; tableCount: number; truncated: boolean } | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setDone(null);
        setScope(table ? 'table' : 'database');
    }, [open, table]);

    const run = async () => {
        setBusy(true);
        setError(null);
        setDone(null);
        try {
            const res = await ws.send('database.export', {
                databaseId,
                format,
                ...(scope === 'table' && table ? { schema: table.schema, table: table.name } : {})
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
                        <SelectInput
                            value={scope}
                            onChange={(e) => setScope(e.target.value as 'table' | 'database')}
                            disabled={!table}
                        >
                            {table && <option value='table'>La table {table.name}</option>}
                            <option value='database'>Toute la base</option>
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

                    <p className={styles.warn}>
                        Un export <strong>n’est pas une sauvegarde</strong> : il traverse la connexion en un seul
                        morceau, et s’arrête donc à 20 000 lignes ou 6 Mo. Pour une copie fidèle, <code>mysqldump</code>{' '}
                        et <code>pg_dump</code> restent les bons outils.
                    </p>
                </div>

                {done && (
                    <p className={done.truncated ? styles.warn : styles.ok}>
                        {formatCount(done.rowCount)} lignes sur {done.tableCount} table
                        {done.tableCount > 1 ? 's' : ''} — fichier téléchargé.
                        {done.truncated && ' Le plafond a été atteint : la suite manque.'}
                    </p>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default ExportDialog;
