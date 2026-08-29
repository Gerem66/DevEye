import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, humanizeError } from 'deveye-sdk-client';
import type { DatabaseExecution } from '../contracts/domain';

import { api } from './api';
import { ResultDialog, ResultTable } from './ResultTable';
import { formatCount } from './format';
import styles from './style.module.css';

/** Lignes montrées dans l'aperçu d'un résultat. */
const PREVIEW_ROWS = 3;

interface TerminalDialogProps {
    open: boolean;
    databaseId: number;
    databaseName: string;
    onClose: () => void;
    /** Une écriture a eu lieu : la page affichée est peut-être périmée. */
    onWrote: () => void;
}

interface Entry {
    sql: string;
    result: DatabaseExecution | null;
    error: string | null;
}

/** Une lecture ne demande pas de confirmation. */
function isRead(sql: string): boolean {
    return /^\s*(select|with|show|explain|describe|desc)\b/i.test(sql);
}

/**
 * Un terminal SQL sur la base, écritures comprises. Deux garde-fous : une
 * instruction à la fois, et une confirmation avant toute instruction qui n'est
 * pas une lecture. L'historique ne quitte jamais le navigateur et ne montre
 * que des aperçus ; le résultat complet s'ouvre dans `ResultDialog`.
 */
export function TerminalDialog({ open, databaseId, databaseName, onClose, onWrote }: TerminalDialogProps) {
    const [sql, setSql] = useState('');
    const [history, setHistory] = useState<Entry[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<string | null>(null);
    const [opened, setOpened] = useState<Entry | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setConfirm(null);
        setOpened(null);
    }, [open]);

    // Le dernier résultat est amené sous les yeux.
    useEffect(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
    }, [history]);

    const run = async (statement: string) => {
        setBusy(true);
        setConfirm(null);
        try {
            const res = await api.send('database.execute', { databaseId, sql: statement });
            setHistory((h) => [...h, { sql: statement, result: res.result, error: null }]);
            setSql('');
            if (res.result.affected !== null && res.result.affected > 0) onWrote();
        } catch (e) {
            setHistory((h) => [
                ...h,
                { sql: statement, result: null, error: humanizeError(e, 'L’instruction a échoué.') }
            ]);
        } finally {
            setBusy(false);
        }
    };

    const submit = () => {
        const statement = sql.trim();
        if (statement === '' || busy) return;
        // Une écriture se confirme : c'est le seul écran d'où l'on peut vider
        // une table de production.
        if (isRead(statement)) void run(statement);
        else setConfirm(statement);
    };

    return (
        <>
            <Dialog
                open={open && confirm === null}
                onClose={onClose}
                title={`Terminal — ${databaseName}`}
                description='Une instruction à la fois. Les écritures sont possibles et demandent confirmation.'
                width={860}
                footer={
                    <>
                        <Button
                            variant='secondary'
                            className={styles.footerLead}
                            onClick={() => setHistory([])}
                            disabled={history.length === 0}
                        >
                            Effacer l’historique
                        </Button>
                        <Button variant='secondary' onClick={onClose}>
                            Fermer
                        </Button>
                        <Button onClick={submit} disabled={busy || sql.trim() === ''}>
                            {busy ? 'Exécution…' : 'Exécuter'}
                        </Button>
                    </>
                }
            >
                <div className={styles.form}>
                    <div className={styles.terminalHistory} ref={scrollRef}>
                        {history.length === 0 && (
                            <p className={styles.hint}>
                                Rien n’a encore été exécuté. L’historique reste dans cette popup et disparaît en la
                                fermant.
                            </p>
                        )}
                        {history.map((entry, i) => (
                            <div key={i} className={styles.terminalEntry}>
                                <pre className={styles.terminalSql}>{entry.sql}</pre>
                                {entry.error && <p className={styles.error}>{entry.error}</p>}
                                {entry.result?.affected !== null && entry.result !== null && (
                                    <p className={styles.ok}>
                                        {entry.result.affected} ligne
                                        {(entry.result.affected ?? 0) > 1 ? 's' : ''} touchée
                                        {(entry.result.affected ?? 0) > 1 ? 's' : ''} en {entry.result.elapsedMs} ms
                                    </p>
                                )}
                                {entry.result?.rows && (
                                    <>
                                        <p className={styles.hint}>
                                            {formatCount(entry.result.rows.rows.length)} ligne
                                            {entry.result.rows.rows.length > 1 ? 's' : ''} · {entry.result.elapsedMs} ms
                                        </p>
                                        <div
                                            role='button'
                                            tabIndex={0}
                                            className={styles.resultPreview}
                                            title='Ouvrir le résultat complet'
                                            onClick={() => setOpened(entry)}
                                            onKeyDown={(e) => {
                                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                                e.preventDefault();
                                                setOpened(entry);
                                            }}
                                        >
                                            <ResultTable rows={entry.result.rows} limit={PREVIEW_ROWS} />
                                            <span className={styles.resultPreviewFoot}>
                                                <span className='icon icon-expand' aria-hidden='true' />
                                                {entry.result.rows.rows.length > PREVIEW_ROWS
                                                    ? `Voir les ${formatCount(entry.result.rows.rows.length)} lignes`
                                                    : 'Ouvrir le résultat'}
                                            </span>
                                        </div>
                                    </>
                                )}
                            </div>
                        ))}
                    </div>

                    <label className={styles.field}>
                        <span className={styles.label}>Instruction</span>
                        <textarea
                            className={styles.sqlField}
                            value={sql}
                            rows={3}
                            spellCheck={false}
                            placeholder='SELECT * FROM clients WHERE ville = &#39;Lyon&#39;'
                            onChange={(e) => setSql(e.target.value)}
                            onKeyDown={(e) => {
                                // Entrée insère une ligne ; Ctrl/⌘+Entrée exécute.
                                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                    e.preventDefault();
                                    submit();
                                }
                            }}
                        />
                        <span className={styles.hint}>Ctrl+Entrée pour exécuter.</span>
                    </label>
                </div>
            </Dialog>

            <Dialog
                open={confirm !== null}
                onClose={() => setConfirm(null)}
                title='Exécuter cette instruction ?'
                width={560}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirm(null)}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => confirm && void run(confirm)}>
                            Exécuter
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    Cette instruction n’est pas une lecture : elle s’applique <strong>immédiatement</strong> sur{' '}
                    <strong>{databaseName}</strong>, et DevEye ne sait pas revenir en arrière.
                </p>
                <pre className={styles.terminalSql}>{confirm}</pre>
            </Dialog>

            <ResultDialog
                open={opened !== null}
                sql={opened?.sql ?? ''}
                rows={opened?.result?.rows ?? null}
                onClose={() => setOpened(null)}
            />
        </>
    );
}

export default TerminalDialog;
