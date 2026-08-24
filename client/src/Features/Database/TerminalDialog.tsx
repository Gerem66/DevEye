import { useEffect, useRef, useState } from 'react';
import type { DatabaseExecution } from '@deveye/types';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
import { ResultDialog, ResultTable } from './ResultTable';
import { formatCount } from './format';
import styles from './style.module.css';

/** Lignes montrées dans l'aperçu d'un résultat, au fil de l'historique. */
const PREVIEW_ROWS = 3;

interface TerminalDialogProps {
    open: boolean;
    databaseId: number;
    databaseName: string;
    onClose: () => void;
    /** Une écriture a eu lieu : la page affichée n'est peut-être plus juste. */
    onWrote: () => void;
}

/** Une instruction passée, et ce qu'elle a donné. */
interface Entry {
    sql: string;
    result: DatabaseExecution | null;
    error: string | null;
}

/** Reconnaît une lecture pour prévenir *avant* d'exécuter le reste. */
function isRead(sql: string): boolean {
    return /^\s*(select|with|show|explain|describe|desc)\b/i.test(sql);
}

/**
 * Un terminal SQL sur la base.
 *
 * Ce que la grille de recherche ne sait pas exprimer — une jointure, un
 * `GROUP BY`, une correction ponctuelle — se tape ici. **Les écritures sont
 * acceptées** : refuser un `UPDATE` dans un terminal alors que l'explorateur en
 * propose par formulaire n'aurait aucun sens.
 *
 * Deux garde-fous, et seulement deux :
 *
 *  - **une instruction à la fois** — un copier-coller de trois instructions dont
 *    on ne visait que la première s'exécuterait en entier, sans qu'aucun écran
 *    n'ait montré les deux autres ;
 *  - une **confirmation** avant toute instruction qui n'est pas une lecture. Le
 *    reste appartient au compte de la base : c'est lui, en dernier ressort, qui
 *    accorde ou refuse.
 *
 * L'historique reste dans la popup, sans jamais quitter le navigateur : ce qu'on
 * tape sur une base de production n'a pas à être conservé par DevEye.
 *
 * ## L'historique ne montre que des aperçus
 *
 * Une requête qui rend quatre cents lignes les déroulait entières dans le fil,
 * poussant l'invite hors de l'écran et rendant illisible tout ce qui précédait.
 * Or ce qu'on attend d'un résultat *passé* tient en une ligne — combien, et à
 * quoi il ressemblait. Le fil en garde donc trois lignes, et le résultat complet
 * s'ouvre d'un clic dans un écran fait pour lui, avec tri et copie.
 */
export function TerminalDialog({ open, databaseId, databaseName, onClose, onWrote }: TerminalDialogProps) {
    const [sql, setSql] = useState('');
    const [history, setHistory] = useState<Entry[]>([]);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<string | null>(null);
    /** Le résultat ouvert en grand, s'il y en a un. */
    const [opened, setOpened] = useState<Entry | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        setConfirm(null);
        setOpened(null);
    }, [open]);

    // Le dernier résultat est celui qu'on attend : on l'amène sous les yeux.
    useEffect(() => {
        const box = scrollRef.current;
        if (box) box.scrollTop = box.scrollHeight;
    }, [history]);

    const run = async (statement: string) => {
        setBusy(true);
        setConfirm(null);
        try {
            const res = await ws.send('database.execute', { databaseId, sql: statement });
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
        // Une écriture se confirme. Pas une politesse : c'est le seul écran de
        // DevEye d'où l'on peut vider une table d'un serveur de production.
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
                                        {/* Un aperçu, cliquable en entier — et non un
                                            tableau suivi d'un lien : la cible du geste
                                            est ce qu'on regarde déjà. */}
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
                                // Entrée insère une ligne — une requête tient
                                // rarement sur une seule. Ctrl/⌘+Entrée exécute.
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
