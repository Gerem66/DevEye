import { useEffect, useState } from 'react';
import type { Database, DatabaseAccessKind, DatabaseEngine, DatabaseSshAuth } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
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

/** L'état du formulaire, à plat : un champ, une valeur, aucune structure imbriquée. */
interface Form {
    engine: DatabaseEngine;
    name: string;
    host: string;
    port: string;
    database: string;
    username: string;
    password: string;
    /** Le mot de passe a-t-il été touché ? Sinon on ne l'envoie pas du tout. */
    passwordTouched: boolean;
    accessKind: DatabaseAccessKind;
    accessHost: string;
    accessPort: string;
    accessUser: string;
    accessAuth: DatabaseSshAuth;
    accessSecret: string;
    accessSecretTouched: boolean;
    monitorEnabled: boolean;
    intervalMinutes: string;
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
    accessSecretTouched: false,
    monitorEnabled: false,
    intervalMinutes: '5'
};

/**
 * Ajouter une base, ou changer ses réglages.
 *
 * Trois blocs, dans l'ordre où l'on y pense : **où elle est**, **par où on y
 * va**, **si on la surveille**. Le tunnel au milieu parce qu'il conditionne
 * l'accessibilité de ce qui précède, et la surveillance en dernier parce que
 * c'est la seule chose qui puisse être laissée telle quelle.
 *
 * Les secrets ne se relisent jamais : un champ laissé intact garde celui en
 * place, et le formulaire le dit. C'est la même convention que les jetons
 * d'accès git — le client ne reçoit pas le secret, il ne peut donc pas le
 * renvoyer inchangé.
 */
export function DatabaseDialog({ open, database, onClose, onSaved, onRemove }: DatabaseDialogProps) {
    const [form, setForm] = useState<Form>(EMPTY);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);

    useEffect(() => {
        if (!open) return;
        setConfirmRemove(false);
        setError(null);
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
                      accessSecretTouched: false,
                      monitorEnabled: database.monitorEnabled,
                      intervalMinutes: String(Math.max(1, Math.round(database.intervalSeconds / 60)))
                  }
                : EMPTY
        );
    }, [open, database]);

    const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

    /** Changer de moteur propose son port — sauf si l'on en a déjà saisi un autre. */
    const setEngine = (engine: DatabaseEngine) =>
        setForm((f) => ({
            ...f,
            engine,
            port: f.port === '' || f.port === String(ENGINE_PORTS[f.engine]) ? String(ENGINE_PORTS[engine]) : f.port
        }));

    const canSubmit =
        form.name.trim() !== '' && form.host.trim() !== '' && form.database.trim() !== '' && form.port.trim() !== '';

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const access = {
                kind: form.accessKind,
                host: form.accessHost.trim(),
                port: form.accessPort.trim() === '' ? null : Number(form.accessPort),
                username: form.accessUser.trim(),
                auth: form.accessAuth,
                // Non touché = on garde celui en place ; c'est ce que
                // `undefined` veut dire au contrat.
                ...(form.accessSecretTouched ? { secret: form.accessSecret } : {})
            };
            const common = {
                name: form.name.trim(),
                host: form.host.trim(),
                port: Number(form.port),
                database: form.database.trim(),
                username: form.username.trim(),
                access,
                monitorEnabled: form.monitorEnabled,
                intervalSeconds: Math.max(60, Math.round(Number(form.intervalMinutes || '5') * 60))
            };

            const res = database
                ? await ws.send('database.update', {
                      databaseId: database.id,
                      ...common,
                      ...(form.passwordTouched ? { password: form.password } : {})
                  })
                : await ws.send('database.add', { engine: form.engine, ...common, password: form.password });
            onSaved(res.database.id);
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const tunnelled = form.accessKind !== 'direct';

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={database ? 'Modifier la base' : 'Ajouter une base de données'}
            width={620}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || !canSubmit}>
                        {busy ? 'Enregistrement…' : database ? 'Enregistrer' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {/* ---- où elle est ---- */}
                <div className={styles.fieldRow}>
                    <label className={styles.field}>
                        <span className={styles.label}>Moteur</span>
                        <SelectInput
                            value={form.engine}
                            // Le moteur ne se change pas après coup : les deux
                            // dialectes n'exposent pas les mêmes notions, et le
                            // relevé conservé serait celui de l'autre.
                            disabled={database !== null}
                            onChange={(e) => setEngine(e.target.value as DatabaseEngine)}
                        >
                            {(Object.keys(ENGINE_LABELS) as DatabaseEngine[]).map((id) => (
                                <option key={id} value={id}>
                                    {ENGINE_LABELS[id]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Nom</span>
                        <TextInput
                            value={form.name}
                            autoFocus
                            placeholder='Production'
                            onChange={(e) => set('name', e.target.value)}
                        />
                    </label>
                </div>

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
                        onChange={(e) => setForm((f) => ({ ...f, password: e.target.value, passwordTouched: true }))}
                    />
                    <span className={styles.hint}>
                        Un compte en <strong>lecture seule</strong> suffit et reste le bon réflexe : DevEye ne fait que
                        lire, mais c’est le serveur qui tranche en dernier ressort.
                        {database?.hasPassword && ' Laissez vide pour conserver celui enregistré.'}
                    </span>
                </label>

                {/* ---- par où on y va ---- */}
                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Accès</span>
                    <label className={styles.field}>
                        <span className={styles.label}>Chemin</span>
                        <SelectInput
                            value={form.accessKind}
                            onChange={(e) => set('accessKind', e.target.value as DatabaseAccessKind)}
                        >
                            <option value='direct'>Direct — le serveur joint l’hôte lui-même</option>
                            <option value='ssh'>Tunnel SSH — rebond par une machine du réseau</option>
                            <option value='socks'>Proxy SOCKS5 — un VPN déjà monté ailleurs</option>
                        </SelectInput>
                    </label>

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
                                    <label className={styles.field}>
                                        <span className={styles.label}>Authentification</span>
                                        <SelectInput
                                            value={form.accessAuth}
                                            onChange={(e) => set('accessAuth', e.target.value as DatabaseSshAuth)}
                                        >
                                            <option value='password'>Mot de passe</option>
                                            <option value='key'>Clé privée</option>
                                        </SelectInput>
                                    </label>
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
                                    La clé reste en mémoire du serveur le temps de la connexion : elle n’est jamais
                                    écrite sur disque, et ne redescend jamais jusqu’ici.
                                </span>
                            </label>
                        </>
                    )}
                </div>

                {/* ---- si on la surveille ---- */}
                <div className={styles.section}>
                    <span className={styles.sectionTitle}>Surveillance</span>
                    <label className={styles.checkRow}>
                        <input
                            type='checkbox'
                            checked={form.monitorEnabled}
                            onChange={(e) => set('monitorEnabled', e.target.checked)}
                        />
                        <span>
                            <span className={styles.label}>Relever cette base régulièrement</span>
                            <span className={styles.hint}>
                                Décoché — c’est le réglage par défaut — rien ne se connecte : la base ne se joint qu’au
                                moment où vous le demandez. Coché, DevEye relève sa taille et son état, et c’est
                                <strong> ce qui rend ses alertes vivantes</strong>.
                            </span>
                        </span>
                    </label>

                    {form.monitorEnabled && (
                        <label className={styles.fieldNarrow}>
                            <span className={styles.label}>Toutes les (minutes)</span>
                            <TextInput
                                value={form.intervalMinutes}
                                inputMode='numeric'
                                onChange={(e) => set('intervalMinutes', e.target.value)}
                            />
                        </label>
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
                                <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
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

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default DatabaseDialog;
