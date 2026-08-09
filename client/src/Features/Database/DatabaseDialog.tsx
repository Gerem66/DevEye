import { useEffect, useState } from 'react';
import type { Database, DatabaseAccessKind, DatabaseEngine, DatabaseProbe, DatabaseSshAuth } from 'deveye-types';
import { Button, Checkbox, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError } from '../Projects/api';
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
    /** Charger les tables dès l'ouverture de la fiche. Éteint par défaut. */
    autoLoadTables: boolean;
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
    intervalMinutes: '5',
    autoLoadTables: false
};

/** Les deux moitiés du formulaire. */
type Tab = 'settings' | 'options';

/**
 * Ajouter une base, ou changer ses réglages.
 *
 * ## Deux onglets, et où passe la coupure
 *
 * **Paramètres** : ce qu'il faut pour joindre la base — moteur, nom, adresse,
 * compte. **Options** : tout ce qui se décide *ensuite* — par où l'on passe, si
 * on la relève, ce qu'on charge en ouvrant sa fiche, et sa suppression.
 *
 * La coupure n'est pas décorative : le premier onglet est obligatoire et se
 * remplit en une fois, le second a un défaut valable pour chaque réglage. Une
 * base s'ajoute donc sans jamais quitter le premier — ce qui n'était pas le cas
 * quand les quatre blocs s'empilaient sur la hauteur de l'écran, l'essentiel se
 * retrouvant noyé au milieu de réglages qu'on ne touche presque jamais.
 *
 * Les secrets ne se relisent jamais : un champ laissé intact garde celui en
 * place, et le formulaire le dit. C'est la même convention que les jetons
 * d'accès git — le client ne reçoit pas le secret, il ne peut donc pas le
 * renvoyer inchangé.
 */
export function DatabaseDialog({ open, database, onClose, onSaved, onRemove }: DatabaseDialogProps) {
    const [form, setForm] = useState<Form>(EMPTY);
    const [tab, setTab] = useState<Tab>('settings');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRemove, setConfirmRemove] = useState(false);
    /** L'essai en cours, et son résultat — distinct de l'enregistrement. */
    const [testing, setTesting] = useState(false);
    const [probe, setProbe] = useState<DatabaseProbe | null>(null);

    useEffect(() => {
        if (!open) return;
        setConfirmRemove(false);
        setError(null);
        setProbe(null);
        // Toute ouverture repart des paramètres : c'est là que se trouve ce
        // qu'on vient changer neuf fois sur dix.
        setTab('settings');
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
                      intervalMinutes: String(Math.max(1, Math.round(database.intervalSeconds / 60))),
                      autoLoadTables: database.autoLoadTables
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

    /**
     * Les réglages tels qu'ils sont saisis, dans la forme du contrat.
     *
     * Une seule source pour l'essai et pour l'enregistrement : les deux doivent
     * viser exactement la même chose, sans quoi « Tester » validerait une
     * connexion qui n'est pas celle qu'on s'apprête à écrire.
     */
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
            // Non touché = on garde celui en place ; c'est ce que `undefined`
            // veut dire au contrat.
            ...(form.accessSecretTouched ? { secret: form.accessSecret } : {})
        }
    });

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const common = {
                ...draft(),
                monitorEnabled: form.monitorEnabled,
                intervalSeconds: Math.max(60, Math.round(Number(form.intervalMinutes || '5') * 60)),
                autoLoadTables: form.autoLoadTables
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

    /**
     * Essayer la connexion **avant** d'enregistrer.
     *
     * L'ordre naturel : on saisit une adresse, on vérifie qu'elle répond, puis
     * on garde. Sans cela il fallait créer la base pour découvrir qu'un port
     * était faux, la corriger, et recommencer.
     */
    const test = async () => {
        if (busy || !canSubmit) return;
        setTesting(true);
        setProbe(null);
        setError(null);
        try {
            const res = await ws.send('database.testDraft', {
                // Sur une base existante, le serveur reprend les secrets qu'on
                // n'a pas ressaisis — ils ne redescendent jamais jusqu'ici.
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

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={database ? 'Modifier la base' : 'Ajouter une base de données'}
            width={620}
            onSubmit={submit}
            footer={
                /* Le résultat de l'essai se lit **juste au-dessus du bouton qui
                   le déclenche**, et non au bas du formulaire : c'est là que
                   l'œil est déjà, et un onglet plus loin la phrase serait sortie
                   de l'écran. D'où ce pied en deux étages. */
                <div className={styles.footerStack}>
                    <ProbeLine testing={testing} probe={probe} />
                    <div className={styles.footerRow}>
                        {/* À gauche du couple Annuler / Enregistrer : ce n'est pas
                            une issue de la popup, c'est une vérification qu'on fait
                            avant de choisir. */}
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
                        aria-selected={tab === 'settings'}
                        className={tab === 'settings' ? styles.tabButtonOn : styles.tabButton}
                        onClick={() => setTab('settings')}
                    >
                        Paramètres
                    </button>
                    <button
                        type='button'
                        role='tab'
                        aria-selected={tab === 'options'}
                        className={tab === 'options' ? styles.tabButtonOn : styles.tabButton}
                        onClick={() => setTab('options')}
                    >
                        Options
                    </button>
                </div>

                {/* ---- où elle est ---- */}
                {tab === 'settings' && (
                    <div className={styles.section}>
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

                {tab === 'options' && (
                    <>
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
                                                    onChange={(e) =>
                                                        set('accessAuth', e.target.value as DatabaseSshAuth)
                                                    }
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
                                            La clé reste en mémoire du serveur le temps de la connexion : elle n’est
                                            jamais écrite sur disque, et ne redescend jamais jusqu’ici.
                                        </span>
                                    </label>
                                </>
                            )}
                        </div>

                        {/* ---- si on la surveille ---- */}
                        <div className={styles.section}>
                            <span className={styles.sectionTitle}>Surveillance</span>
                            <Checkbox checked={form.monitorEnabled} onChange={(v) => set('monitorEnabled', v)}>
                                <>
                                    <span className={styles.label}>Relever cette base régulièrement</span>
                                    <span className={styles.hint}>
                                        Décoché — c’est le réglage par défaut — rien ne se connecte : la base ne se
                                        joint qu’au moment où vous le demandez. Coché, DevEye relève sa taille et son
                                        état, et c’est
                                        <strong> ce qui rend ses alertes vivantes</strong>.
                                    </span>
                                </>
                            </Checkbox>

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

                        {/* ---- ce qu'on charge en ouvrant sa fiche ---- */}
                        <div className={styles.section}>
                            <span className={styles.sectionTitle}>Exploration</span>
                            <Checkbox checked={form.autoLoadTables} onChange={(v) => set('autoLoadTables', v)}>
                                <>
                                    <span className={styles.label}>Charger les tables à l’ouverture</span>
                                    <span className={styles.hint}>
                                        Décoché — le réglage par défaut — ouvrir la fiche de cette base ne joint aucun
                                        serveur : c’est « Charger les tables » qui va voir. Coché, l’inventaire des
                                        tables est lu dès l’affichage de la fiche, ce qui fait gagner un clic sur une
                                        base qu’on consulte souvent et coûte une connexion à chaque ouverture.
                                    </span>
                                </>
                            </Checkbox>
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
