import { useEffect, useState } from 'react';
import { Button, Dialog, humanizeError, SegmentedControl } from 'deveye-sdk-client';
import type { DatabaseEngine, DatabaseProbe } from '../contracts/domain';

import { api } from './api';
import {
    AccessFields,
    ConnectionFields,
    connectionComplete,
    connectionTarget,
    EMPTY_CONNECTION,
    type ConnectionForm
} from './ConnectionFields';
import { ProbeLine } from './ProbeLine';
import { ENGINE_LABELS, ENGINE_PORTS } from './format';
import styles from './style.module.css';

interface DatabaseDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (databaseId: number) => void;
}

/** La surveillance d'une base qui naît ; elle se règle ensuite dans le panneau Général. */
const MONITORING_DEFAULTS = { monitorEnabled: false, intervalSeconds: 300, autoLoadTables: false } as const;

const ENGINES: { value: DatabaseEngine; label: string }[] = (Object.keys(ENGINE_LABELS) as DatabaseEngine[]).map(
    (id) => ({ value: id, label: ENGINE_LABELS[id] })
);

type Tab = 'connection' | 'access';

/**
 * Ajouter une base à l'espace. Rien d'autre : une fois ajoutée, une base se
 * règle dans l'onglet Général de sa fiche, comme tout élément. Deux onglets :
 * Connexion (obligatoire) et Accès (défaut valable). Le moteur ne se choisit
 * qu'ici, il ne se change pas après coup.
 */
export function DatabaseDialog({ open, onClose, onSaved }: DatabaseDialogProps) {
    const [engine, setEngine] = useState<DatabaseEngine>('mysql');
    const [form, setForm] = useState<ConnectionForm>(EMPTY_CONNECTION);
    const [tab, setTab] = useState<Tab>('connection');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** L'essai en cours, et son résultat ; distinct de l'enregistrement. */
    const [testing, setTesting] = useState(false);
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setProbe(null);
        // Toute ouverture repart de la connexion.
        setTab('connection');
        setEngine('mysql');
        setForm(EMPTY_CONNECTION);
    }, [open]);

    const patch = (p: Partial<ConnectionForm>) => setForm((f) => ({ ...f, ...p }));

    /** Changer de moteur propose son port, sauf si un autre est déjà saisi. */
    const changeEngine = (next: DatabaseEngine) => {
        setForm((f) => ({
            ...f,
            port: f.port === '' || f.port === String(ENGINE_PORTS[engine]) ? String(ENGINE_PORTS[next]) : f.port
        }));
        setEngine(next);
    };

    const canSubmit = connectionComplete(form);

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            // La surveillance ne se règle pas ici : une base naît au repos.
            const res = await api.send('database.add', {
                engine,
                name: form.name.trim(),
                ...connectionTarget(form),
                password: form.password,
                ...MONITORING_DEFAULTS
            });
            onSaved(res.database.id);
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const test = async () => {
        if (busy || !canSubmit) return;
        setTesting(true);
        setProbe(null);
        setError(null);
        try {
            const res = await api.send('database.testDraft', {
                engine,
                ...connectionTarget(form),
                password: form.password
            });
            setProbe(res.probe);
        } catch (e) {
            setError(humanizeError(e, 'L’essai de connexion a échoué.'));
        } finally {
            setTesting(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Ajouter une base de données'
            width={620}
            onSubmit={submit}
            footer={
                /* Le résultat de l'essai se lit juste au-dessus du bouton qui le
                   déclenche : un onglet plus loin, il serait hors écran. */
                <div className={styles.footerStack}>
                    <ProbeLine testing={testing} probe={probe} />
                    <div className={styles.footerRow}>
                        <Button
                            variant='secondary'
                            className={styles.footerLead}
                            onClick={() => void test()}
                            disabled={busy || testing || !canSubmit}
                        >
                            {testing ? 'Essai…' : 'Tester la connexion'}
                        </Button>
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void submit()} disabled={busy || !canSubmit}>
                            {busy ? 'Enregistrement…' : 'Ajouter'}
                        </Button>
                    </div>
                </div>
            }
        >
            <div className={styles.form}>
                <div className={styles.tabBar} role='tablist'>
                    <button
                        type='button'
                        role='tab'
                        aria-selected={tab === 'connection'}
                        className={tab === 'connection' ? styles.tabButtonOn : styles.tabButton}
                        onClick={() => setTab('connection')}
                    >
                        Connexion
                    </button>
                    <button
                        type='button'
                        role='tab'
                        aria-selected={tab === 'access'}
                        className={tab === 'access' ? styles.tabButtonOn : styles.tabButton}
                        onClick={() => setTab('access')}
                    >
                        Accès
                    </button>
                </div>

                {tab === 'connection' && (
                    <div className={styles.section}>
                        <div className={styles.field}>
                            <span className={styles.label}>Moteur</span>
                            <SegmentedControl
                                aria-label='Moteur'
                                options={ENGINES}
                                value={engine}
                                onChange={changeEngine}
                            />
                        </div>
                        <ConnectionFields form={form} onChange={patch} autoFocus />
                    </div>
                )}

                {tab === 'access' && (
                    <div className={styles.section}>
                        <span className={styles.sectionTitle}>Accès</span>
                        <AccessFields form={form} onChange={patch} />
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default DatabaseDialog;
