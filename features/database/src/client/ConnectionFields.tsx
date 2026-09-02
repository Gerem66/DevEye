import { SegmentedControl, TextInput } from 'deveye-sdk-client';
import type { Database, DatabaseAccessKind, DatabaseSshAuth } from '../contracts/domain';

import { ENGINE_PORTS } from './format';
import styles from './style.module.css';

/**
 * Ce qu'une base a de réglable hors de son moteur : sa connexion et son accès.
 * Les mêmes champs servent à l'ajouter (dialogue) et à la régler (onglet
 * Général de sa fiche) : un seul formulaire, jamais une copie réduite.
 */
export interface ConnectionForm {
    name: string;
    host: string;
    /** En texte tant qu'on saisit ; converti au moment d'envoyer. */
    port: string;
    database: string;
    username: string;
    /** Vide = le mot de passe enregistré, s'il y en a un, reste en place. */
    password: string;
    accessKind: DatabaseAccessKind;
    accessHost: string;
    accessPort: string;
    accessUser: string;
    accessAuth: DatabaseSshAuth;
    /** Mot de passe SSH ou clé privée ; vide = celui enregistré reste en place. */
    accessSecret: string;
}

export const EMPTY_CONNECTION: ConnectionForm = {
    name: '',
    host: '',
    port: String(ENGINE_PORTS.mysql),
    database: '',
    username: '',
    password: '',
    accessKind: 'direct',
    accessHost: '',
    accessPort: '',
    accessUser: '',
    accessAuth: 'password',
    accessSecret: ''
};

/** Les secrets ne redescendent jamais : ils partent vides. */
export function connectionOf(database: Database): ConnectionForm {
    return {
        name: database.name,
        host: database.host,
        port: String(database.port),
        database: database.database,
        username: database.username,
        password: '',
        accessKind: database.access.kind,
        accessHost: database.access.host,
        accessPort: database.access.port === null ? '' : String(database.access.port),
        accessUser: database.access.username,
        accessAuth: database.access.auth,
        accessSecret: ''
    };
}

/** L'onglet Connexion est rempli ; l'accès a toujours un défaut valable. */
export function connectionComplete(form: ConnectionForm): boolean {
    return form.name.trim() !== '' && form.host.trim() !== '' && form.database.trim() !== '' && form.port.trim() !== '';
}

/**
 * La cible telle que « Tester » et l'enregistrement l'envoient : une seule
 * source, pour que l'essai vise ce qu'on écrit. Sans le nom ni le mot de passe
 * de la base, que chaque commande prend à sa façon. Un secret de tunnel vide
 * n'est pas envoyé : le serveur garde celui en place.
 */
export function connectionTarget(form: ConnectionForm) {
    return {
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
            ...(form.accessSecret ? { secret: form.accessSecret } : {})
        }
    };
}

const ACCESS_KINDS: { value: DatabaseAccessKind; label: string; title: string }[] = [
    { value: 'direct', label: 'Direct', title: 'Le serveur joint l’hôte lui-même' },
    { value: 'ssh', label: 'Tunnel SSH', title: 'Rebond par une machine du réseau' },
    { value: 'socks', label: 'Proxy SOCKS5', title: 'Un VPN déjà monté ailleurs' }
];

const SSH_AUTHS: { value: DatabaseSshAuth; label: string }[] = [
    { value: 'password', label: 'Mot de passe' },
    { value: 'key', label: 'Clé privée' }
];

interface FieldsProps {
    form: ConnectionForm;
    onChange: (patch: Partial<ConnectionForm>) => void;
    disabled?: boolean;
    /** La base existe déjà : ses secrets, jamais renvoyés, se signalent sans se montrer. */
    existing?: Database | null;
}

/** Nom, hôte, base et compte : ce qui identifie la base chez son serveur. */
export function ConnectionFields({
    form,
    onChange,
    disabled,
    existing,
    autoFocus
}: FieldsProps & { autoFocus?: boolean }) {
    return (
        <>
            <label className={styles.field}>
                <span className={styles.label}>Nom</span>
                <TextInput
                    value={form.name}
                    autoFocus={autoFocus}
                    placeholder='Production'
                    disabled={disabled}
                    onChange={(e) => onChange({ name: e.target.value })}
                />
            </label>

            <div className={styles.fieldRow}>
                <label className={styles.fieldWide}>
                    <span className={styles.label}>Hôte</span>
                    <TextInput
                        value={form.host}
                        placeholder='127.0.0.1'
                        disabled={disabled}
                        onChange={(e) => onChange({ host: e.target.value })}
                    />
                </label>
                <label className={styles.fieldNarrow}>
                    <span className={styles.label}>Port</span>
                    <TextInput
                        value={form.port}
                        inputMode='numeric'
                        disabled={disabled}
                        onChange={(e) => onChange({ port: e.target.value })}
                    />
                </label>
            </div>

            <div className={styles.fieldRow}>
                <label className={styles.field}>
                    <span className={styles.label}>Base</span>
                    <TextInput
                        value={form.database}
                        disabled={disabled}
                        onChange={(e) => onChange({ database: e.target.value })}
                    />
                </label>
                <label className={styles.field}>
                    <span className={styles.label}>Utilisateur</span>
                    <TextInput
                        value={form.username}
                        disabled={disabled}
                        onChange={(e) => onChange({ username: e.target.value })}
                    />
                </label>
            </div>

            <label className={styles.field}>
                <span className={styles.label}>Mot de passe</span>
                <TextInput
                    type='password'
                    value={form.password}
                    placeholder={existing?.hasPassword ? '•••••••• (inchangé)' : ''}
                    disabled={disabled}
                    onChange={(e) => onChange({ password: e.target.value })}
                />
                <span className={styles.hint}>
                    Un compte en <strong>lecture seule</strong> suffit tant qu’on ne fait que consulter. Pour modifier
                    des lignes depuis l’explorateur, il faut un compte qui en a le droit : c’est le serveur qui tranche
                    en dernier ressort.
                    {existing?.hasPassword && ' Laissez vide pour conserver celui enregistré.'}
                </span>
            </label>
        </>
    );
}

/** Le chemin vers le serveur : direct, tunnel SSH ou proxy SOCKS, et ses identifiants. */
export function AccessFields({ form, onChange, disabled, existing }: FieldsProps) {
    const tunnelled = form.accessKind !== 'direct';
    const kind = ACCESS_KINDS.find((k) => k.value === form.accessKind) ?? ACCESS_KINDS[0];
    const privateKey = form.accessKind === 'ssh' && form.accessAuth === 'key';

    return (
        <>
            <div className={styles.field}>
                <span className={styles.label}>Chemin</span>
                <SegmentedControl
                    aria-label='Chemin'
                    options={ACCESS_KINDS}
                    value={form.accessKind}
                    disabled={disabled}
                    onChange={(accessKind) => onChange({ accessKind })}
                />
                <span className={styles.hint}>{kind.title}.</span>
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
                                disabled={disabled}
                                onChange={(e) => onChange({ accessHost: e.target.value })}
                            />
                        </label>
                        <label className={styles.fieldNarrow}>
                            <span className={styles.label}>Port</span>
                            <TextInput
                                value={form.accessPort}
                                inputMode='numeric'
                                placeholder={form.accessKind === 'ssh' ? '22' : '1080'}
                                disabled={disabled}
                                onChange={(e) => onChange({ accessPort: e.target.value })}
                            />
                        </label>
                    </div>

                    <div className={styles.fieldRow}>
                        <label className={styles.field}>
                            <span className={styles.label}>Utilisateur</span>
                            <TextInput
                                value={form.accessUser}
                                disabled={disabled}
                                onChange={(e) => onChange({ accessUser: e.target.value })}
                            />
                        </label>
                        {form.accessKind === 'ssh' && (
                            <div className={styles.field}>
                                <span className={styles.label}>Authentification</span>
                                <SegmentedControl
                                    aria-label='Authentification'
                                    options={SSH_AUTHS}
                                    value={form.accessAuth}
                                    disabled={disabled}
                                    onChange={(accessAuth) => onChange({ accessAuth })}
                                />
                            </div>
                        )}
                    </div>

                    <label className={styles.field}>
                        <span className={styles.label}>{privateKey ? 'Clé privée' : 'Mot de passe'}</span>
                        {privateKey ? (
                            <textarea
                                className={styles.keyField}
                                value={form.accessSecret}
                                rows={4}
                                disabled={disabled}
                                placeholder={
                                    existing?.access.hasSecret
                                        ? '(clé enregistrée : laissez vide pour la conserver)'
                                        : '-----BEGIN OPENSSH PRIVATE KEY-----'
                                }
                                onChange={(e) => onChange({ accessSecret: e.target.value })}
                            />
                        ) : (
                            <TextInput
                                type='password'
                                value={form.accessSecret}
                                placeholder={existing?.access.hasSecret ? '•••••••• (inchangé)' : ''}
                                disabled={disabled}
                                onChange={(e) => onChange({ accessSecret: e.target.value })}
                            />
                        )}
                        <span className={styles.hint}>
                            La clé reste en mémoire du serveur le temps de la connexion : elle n’est jamais écrite sur
                            disque, et ne redescend jamais jusqu’ici.
                        </span>
                    </label>
                </>
            )}
        </>
    );
}
