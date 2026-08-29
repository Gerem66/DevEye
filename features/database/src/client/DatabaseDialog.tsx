import { useEffect, useState } from 'react';
import { Button, Dialog, humanizeError, SegmentedControl, TextInput } from 'deveye-sdk-client';
import type { Database, DatabaseAccessKind, DatabaseEngine, DatabaseProbe, DatabaseSshAuth } from '../contracts/domain';

import { api } from './api';
import { ProbeLine } from './ProbeLine';
import { ENGINE_LABELS, ENGINE_PORTS } from './format';
import styles from './style.module.css';

interface DatabaseDialogProps {
    open: boolean;
    /** La base modifiée ; `null` = on en ajoute une. */
    database: Database | null;
    onClose: () => void;
    onSaved: (databaseId: number) => void;
    /** Supprimer la base. Absent à la création, ou en lecture seule. */
    onRemove?: () => void;
}

interface Form {
    engine: DatabaseEngine;
    name: string;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    /** Non touché, le mot de passe n'est pas envoyé du tout. */
    passwordTouched: boolean;
    accessKind: DatabaseAccessKind;
    accessHost: string;
    accessPort: string;
    accessUser: string;
    accessAuth: DatabaseSshAuth;
    accessSecret: string;
    accessSecretTouched: boolean;
}

const EMPTY: Form = {
    engine: 'mysql',
    name: '',
    host: '',
    port: String(ENGINE_PORTS.mysql),
    database: '',
    username: '',
    password: '',
    passwordTouched: false,
    accessKind: 'direct',
    accessHost: '',
    accessPort: '',
    accessUser: '',
    accessAuth: 'password',
    accessSecret: '',
    accessSecretTouched: false
};

/** La surveillance d'une base qui naît ; elle se règle ensuite dans le panneau Général. */
const MONITORING_DEFAULTS = { monitorEnabled: false, intervalSeconds: 300, autoLoadTables: false } as const;

const ENGINES: { value: DatabaseEngine; label: string }[] = (Object.keys(ENGINE_LABELS) as DatabaseEngine[]).map(
    (id) => ({ value: id, label: ENGINE_LABELS[id] })
);

const ACCESS_KINDS: { value: DatabaseAccessKind; label: string; title: string }[] = [
    { value: 'direct', label: 'Direct', title: 'Le serveur joint l’hôte lui-même' },
    { value: 'ssh', label: 'Tunnel SSH', title: 'Rebond par une machine du réseau' },
    { value: 'socks', label: 'Proxy SOCKS5', title: 'Un VPN déjà monté ailleurs' }
];

const SSH_AUTHS: { value: DatabaseSshAuth; label: string }[] = [
    { value: 'password', label: 'Mot de passe' },
    { value: 'key', label: 'Clé privée' }
];

type Tab = 'connection' | 'access';

/**
 * Ajouter une base, ou changer son identité et son accès. Deux onglets :
 * Connexion (obligatoire) et Accès (défaut valable). La surveillance se règle
 * dans `DatabaseGeneralPanel` ; le dialogue en renvoie les défauts ou ceux de
 * la base, inchangés. Un secret laissé intact garde celui en place.
 */
export function DatabaseDialog({ open, database, onClose, onSaved, onRemove }: DatabaseDialogProps) {
    const [form, setForm] = useState<Form>(EMPTY);
    const [tab, setTab] = useState<Tab>('connection');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    /** L'essai en cours, et son résultat ; distinct de l'enregistrement. */
    const [testing, setTesting] = useState(false);
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);

    useEffect(() => {
        if (!open) return;
        setConfirmRemove(false);
        setError(null);
        setProbe(null);
        // Toute ouverture repart de la connexion.
        setTab('connection');
        setForm(
            database
                ? {
                      engine: database.engine,
                      name: database.name,
                      host: database.host,
                      port: String(database.port),
                      database: database.database,
                      username: database.username,
                      password: '',
                      passwordTouched: false,
                      accessKind: database.access.kind,
                      accessHost: database.access.host,
                      accessPort: database.access.port === null ? '' : String(database.access.port),
                      accessUser: database.access.username,
                      accessAuth: database.access.auth,
                      accessSecret: '',
                      accessSecretTouched: false
                  }
                : EMPTY
        );
    }, [open, database]);

    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

    /** Changer de moteur propose son port, sauf si un autre est déjà saisi. */
    const setEngine = (engine: DatabaseEngine) =>
        setForm((f) => ({
            ...f,
            engine,
            port: f.port === '' || f.port === String(ENGINE_PORTS[f.engine]) ? String(ENGINE_PORTS[engine]) : f.port
        }));

    const canSubmit =
        form.name.trim() !== '' && form.host.trim() !== '' && form.database.trim() !== '' && form.port.trim() !== '';

    /** Une seule source pour l'essai et l'enregistrement : « Tester » doit viser ce qu'on écrit. */
    const draft = () => ({
        name: form.name.trim(),
        host: form.host.trim(),
        port: Number(form.port),
        database: form.database.trim(),
        username: form.username.trim(),
        access: {
            kind: form.accessKind,
            host: form.accessHost.trim(),
            port: form.accessPort.trim() === '' ? null : Number(form.accessPort),
            username: form.accessUser.trim(),
            auth: form.accessAuth,
            // Non touché = `undefined` = on garde celui en place.
            ...(form.accessSecretTouched ? { secret: form.accessSecret } : {})
        }
    });

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            // La surveillance ne se règle pas ici : défauts à la création, tels
            // quels ensuite.
            const monitoring = database
                ? {
                      monitorEnabled: database.monitorEnabled,
                      intervalSeconds: database.intervalSeconds,
                      autoLoadTables: database.autoLoadTables
                  }
                : MONITORING_DEFAULTS;
            const common = { ...draft(), ...monitoring };

            const res = database
                ? await api.send('database.update', {
                      databaseId: database.id,
                      ...common,
                      ...(form.passwordTouched ? { password: form.password } : {})
                  })
                : await api.send('database.add', { engine: form.engine, ...common, password: form.password });
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
                // Sur une base existante, le serveur reprend les secrets non
                // ressaisis : ils ne redescendent jamais ici.
                ...(database ? { databaseId: database.id } : {}),
                engine: form.engine,
                ...draft(),
                ...(form.passwordTouched || !database ? { password: form.password } : {})
            });
            setProbe(res.probe);
        } catch (e) {
            setError(humanizeError(e, 'L’essai de connexion a échoué.'));
        } finally {
            setTesting(false);
        }
    };

    const tunnelled = form.accessKind !== 'direct';
    const accessKind = ACCESS_KINDS.find((k) => k.value === form.accessKind) ?? ACCESS_KINDS[0];

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={database ? 'Modifier la base' : 'Ajouter une base de données'}
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
                            {busy ? 'Enregistrement…' : database ? 'Enregistrer' : 'Ajouter'}
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
                                value={form.engine}
                                // Le moteur ne se change pas après coup : le relevé
                                // conservé serait celui de l'autre dialecte.
                                disabled={database !== null}
                                onChange={setEngine}
                            />
                        </div>

                        <label className={styles.field}>
                            <span className={styles.label}>Nom</span>
                            <TextInput
                                value={form.name}
                                autoFocus
                                placeholder='Production'
                                onChange={(e) => set('name', e.target.value)}
                            />
                        </label>

                        <div className={styles.fieldRow}>
                            <label className={styles.fieldWide}>
                                <span className={styles.label}>Hôte</span>
                                <TextInput
                                    value={form.host}
                                    placeholder='127.0.0.1'
                                    onChange={(e) => set('host', e.target.value)}
                                />
                            </label>
                            <label className={styles.fieldNarrow}>
                                <span className={styles.label}>Port</span>
                                <TextInput
                                    value={form.port}
                                    inputMode='numeric'
                                    onChange={(e) => set('port', e.target.value)}
                                />
                            </label>
                        </div>

                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={styles.label}>Base</span>
                                <TextInput value={form.database} onChange={(e) => set('database', e.target.value)} />
                            </label>
                            <label className={styles.field}>
                                <span className={styles.label}>Utilisateur</span>
                                <TextInput value={form.username} onChange={(e) => set('username', e.target.value)} />
                            </label>
                        </div>

                        <label className={styles.field}>
                            <span className={styles.label}>Mot de passe</span>
                            <TextInput
                                type='password'
                                value={form.password}
                                placeholder={database?.hasPassword ? '•••••••• (inchangé)' : ''}
                                onChange={(e) =>
                                    setForm((f) => ({ ...f, password: e.target.value, passwordTouched: true }))
                                }
                            />
                            <span className={styles.hint}>
                                Un compte en <strong>lecture seule</strong> suffit tant qu’on ne fait que consulter.
                                Pour modifier des lignes depuis l’explorateur, il faut un compte qui en a le droit :
                                c’est le serveur qui tranche en dernier ressort.
                                {database?.hasPassword && ' Laissez vide pour conserver celui enregistré.'}
                            </span>
                        </label>
                    </div>
                )}

                {tab === 'access' && (
                    <>
                        <div className={styles.section}>
                            <span className={styles.sectionTitle}>Accès</span>
                            <div className={styles.field}>
                                <span className={styles.label}>Chemin</span>
                                <SegmentedControl
                                    aria-label='Chemin'
                                    options={ACCESS_KINDS}
                                    value={form.accessKind}
                                    onChange={(kind) => set('accessKind', kind)}
                                />
                                <span className={styles.hint}>{accessKind.title}.</span>
                            </div>

                            {tunnelled && (
                                <>
                                    <div className={styles.fieldRow}>
                                        <label className={styles.fieldWide}>
                                            <span className={styles.label}>
                                                {form.accessKind === 'ssh' ? 'Hôte SSH' : 'Hôte du proxy'}
                                            </span>
                                            <TextInput
                                                value={form.accessHost}
                                                onChange={(e) => set('accessHost', e.target.value)}
                                            />
                                        </label>
                                        <label className={styles.fieldNarrow}>
                                            <span className={styles.label}>Port</span>
                                            <TextInput
                                                value={form.accessPort}
                                                inputMode='numeric'
                                                placeholder={form.accessKind === 'ssh' ? '22' : '1080'}
                                                onChange={(e) => set('accessPort', e.target.value)}
                                            />
                                        </label>
                                    </div>

                                    <div className={styles.fieldRow}>
                                        <label className={styles.field}>
                                            <span className={styles.label}>Utilisateur</span>
                                            <TextInput
                                                value={form.accessUser}
                                                onChange={(e) => set('accessUser', e.target.value)}
                                            />
                                        </label>
                                        {form.accessKind === 'ssh' && (
                                            <div className={styles.field}>
                                                <span className={styles.label}>Authentification</span>
                                                <SegmentedControl
                                                    aria-label='Authentification'
                                                    options={SSH_AUTHS}
                                                    value={form.accessAuth}
                                                    onChange={(auth) => set('accessAuth', auth)}
                                                />
                                            </div>
                                        )}
                                    </div>

                                    <label className={styles.field}>
                                        <span className={styles.label}>
                                            {form.accessKind === 'ssh' && form.accessAuth === 'key'
                                                ? 'Clé privée'
                                                : 'Mot de passe'}
                                        </span>
                                        {form.accessKind === 'ssh' && form.accessAuth === 'key' ? (
                                            <textarea
                                                className={styles.keyField}
                                                value={form.accessSecret}
                                                rows={4}
                                                placeholder={
                                                    database?.access.hasSecret
                                                        ? '(clé enregistrée — laissez vide pour la conserver)'
                                                        : '-----BEGIN OPENSSH PRIVATE KEY-----'
                                                }
                                                onChange={(e) =>
                                                    setForm((f) => ({
                                                        ...f,
                                                        accessSecret: e.target.value,
                                                        accessSecretTouched: true
                                                    }))
                                                }
                                            />
                                        ) : (
                                            <TextInput
                                                type='password'
                                                value={form.accessSecret}
                                                placeholder={database?.access.hasSecret ? '•••••••• (inchangé)' : ''}
                                                onChange={(e) =>
                                                    setForm((f) => ({
                                                        ...f,
                                                        accessSecret: e.target.value,
                                                        accessSecretTouched: true
                                                    }))
                                                }
                                            />
                                        )}
                                        <span className={styles.hint}>
                                            La clé reste en mémoire du serveur le temps de la connexion : elle n’est
                                            jamais écrite sur disque, et ne redescend jamais jusqu’ici.
                                        </span>
                                    </label>
                                </>
                            )}
                        </div>

                        {onRemove && database && (
                            <div className={styles.dangerZone}>
                                <div className={styles.dangerText}>
                                    <span className={styles.label}>Supprimer cette base</span>
                                    <span className={styles.hint}>
                                        Ses alertes et son historique de relevé sont perdus, et les{' '}
                                        {database.projectCount > 0
                                            ? `${database.projectCount} projet${database.projectCount > 1 ? 's' : ''} qui l’utilisent perdent leur lien`
                                            : 'projets qui l’utiliseraient perdraient leur lien'}
                                        . Le serveur distant, lui, n’est pas touché.
                                    </span>
                                </div>
                                {confirmRemove ? (
                                    <div className={styles.actions}>
                                        <Button
                                            variant='secondary'
                                            onClick={() => setConfirmRemove(false)}
                                            disabled={busy}
                                        >
                                            Annuler
                                        </Button>
                                        <Button variant='danger' onClick={onRemove} disabled={busy}>
                                            Confirmer
                                        </Button>
                                    </div>
                                ) : (
                                    <Button variant='danger' onClick={() => setConfirmRemove(true)} disabled={busy}>
                                        Supprimer
                                    </Button>
                                )}
                            </div>
                        )}
                    </>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default DatabaseDialog;
