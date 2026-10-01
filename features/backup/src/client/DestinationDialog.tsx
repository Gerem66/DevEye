import { useEffect, useId, useState } from 'react';
import type { BackupDestination, BackupDestinationKind, BackupSftpAuth } from '../contracts/domain';

import {
    Button,
    DeviceFolderField,
    Dialog,
    humanizeError,
    SearchSelect,
    SegmentedControl,
    Switch,
    TextInput,
    useDevices
} from 'deveye-sdk-client';
import { api } from './api';
import { DESTINATION_LABELS, DESTINATION_SHORT_LABELS } from './format';
import styles from './style.module.css';

interface DestinationDialogProps {
    open: boolean;
    /** `null` = création. */
    destination: BackupDestination | null;
    onClose: () => void;
    onSaved: () => void;
}

/** Ce que chaque genre veut dire, sous le sélecteur. */
const KIND_HINTS: Record<BackupDestinationKind, string> = {
    local: 'Sur le disque du serveur DevEye. Simple, mais la copie meurt avec la machine qu’elle sauvegarde.',
    device: 'Sur une machine où tourne un agent (un Raspberry Pi, un NAS). Rien à installer de plus.',
    s3: 'Garage, MinIO, Scaleway, Backblaze, AWS : un stockage objet, sur place ou chez un prestataire.',
    sftp: 'Un serveur joignable en SSH : un NAS, un VPS, un Synology. Son empreinte est retenue au premier test.',
    webdav: 'Nextcloud, Synology, kDrive, et tout serveur WebDAV joignable en https.'
};

const NAME_PLACEHOLDERS: Record<BackupDestinationKind, string> = {
    local: 'Disque de sauvegarde',
    device: 'Disque du Raspberry',
    s3: 'Garage du Raspberry',
    sftp: 'NAS du bureau',
    webdav: 'Nextcloud'
};

const PATH_PLACEHOLDERS: Record<BackupDestinationKind, string> = {
    local: 'nuit',
    device: '/mnt/backup/deveye',
    s3: 'deveye/nuit',
    sftp: '/srv/sauvegardes',
    webdav: 'Sauvegardes/DevEye'
};

const PATH_HINTS: Record<BackupDestinationKind, string> = {
    local: 'Sous-dossier de la racine des sauvegardes du serveur. Laisser vide pour écrire à la racine.',
    device: 'Chemin absolu sur la machine. Il est créé s’il n’existe pas.',
    s3: 'Préfixe des clés dans le bucket. Laisser vide pour écrire à la racine.',
    sftp: 'Absolu, ou relatif au dossier de connexion. Il est créé s’il n’existe pas.',
    webdav: 'Sous l’adresse du serveur. Il est créé s’il n’existe pas ; vide, les archives vont à l’adresse même.'
};

const SFTP_AUTHS: { value: BackupSftpAuth; label: string }[] = [
    { value: 'password', label: 'Mot de passe' },
    { value: 'key', label: 'Clé privée' }
];

/**
 * Un seul formulaire pour tous les genres, champs selon le genre choisi. Le
 * genre n'est pas modifiable après coup : les archives déjà écrites resteraient
 * pointées par des exécutions devenues introuvables.
 */
export default function DestinationDialog({ open, destination, onClose, onSaved }: DestinationDialogProps) {
    const { devices } = useDevices();

    const [kind, setKind] = useState<BackupDestinationKind>('local');
    const [name, setName] = useState('');
    const [deviceId, setDeviceId] = useState('');
    const [path, setPath] = useState('');
    const [endpoint, setEndpoint] = useState('');
    const [region, setRegion] = useState('');
    const [bucket, setBucket] = useState('');
    const [accessKeyId, setAccessKeyId] = useState('');
    const [host, setHost] = useState('');
    const [port, setPort] = useState(22);
    const [username, setUsername] = useState('');
    const [sftpAuth, setSftpAuth] = useState<BackupSftpAuth>('password');
    const [secret, setSecret] = useState('');
    const [pathStyle, setPathStyle] = useState(true);
    const [resetHostKey, setResetHostKey] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setSecret('');
        setResetHostKey(false);
        if (destination) {
            setKind(destination.kind);
            setName(destination.name);
            setDeviceId(destination.deviceId ?? '');
            setPath(destination.path);
            setEndpoint(destination.endpoint ?? '');
            setRegion(destination.region ?? '');
            setBucket(destination.bucket ?? '');
            setAccessKeyId(destination.accessKeyId ?? '');
            setHost(destination.host ?? '');
            setPort(destination.port ?? 22);
            setUsername(destination.username ?? '');
            setSftpAuth(destination.sftpAuth ?? 'password');
            setPathStyle(destination.pathStyle);
            return;
        }
        setKind('local');
        setName('');
        setDeviceId('');
        setPath('');
        setEndpoint('');
        setRegion('');
        setBucket('');
        setAccessKeyId('');
        setHost('');
        setPort(22);
        setUsername('');
        setSftpAuth('password');
        setPathStyle(true);
    }, [open, destination]);

    const selectedDevice = devices.find((d) => d.id === deviceId) ?? null;
    const pathId = useId();
    const hasSecret = destination?.hasSecret ?? false;
    // Changer de mode de connexion rend l'ancien secret inutilisable : il faut le nouveau.
    const secretKept = hasSecret && (kind !== 'sftp' || destination?.sftpAuth === sftpAuth);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const body = {
                name: name.trim(),
                deviceId: kind === 'device' ? deviceId || null : null,
                path: path.trim(),
                endpoint: kind === 's3' || kind === 'webdav' ? endpoint.trim() : null,
                region: kind === 's3' ? region.trim() || 'us-east-1' : null,
                bucket: kind === 's3' ? bucket.trim() : null,
                accessKeyId: kind === 's3' ? accessKeyId.trim() : null,
                host: kind === 'sftp' ? host.trim() : null,
                port: kind === 'sftp' ? port : null,
                username: kind === 'sftp' || kind === 'webdav' ? username.trim() : null,
                sftpAuth: kind === 'sftp' ? sftpAuth : null,
                pathStyle
            };
            // Une clé garde ses retours à la ligne ; un mot de passe perd ses espaces de bord.
            const typed = kind === 'sftp' && sftpAuth === 'key' ? secret.trim() + '\n' : secret.trim();
            if (destination) {
                await api.send('backup.destinationUpdate', {
                    destinationId: destination.id,
                    ...body,
                    // Champ vide = secret inchangé. Le serveur ne l'a jamais
                    // rendu, on ne peut donc pas le renvoyer à l'identique.
                    ...(secret.trim() ? { secret: typed } : {}),
                    resetHostKey
                });
            } else {
                await api.send('backup.destinationAdd', { kind, ...body, secret: secret.trim() ? typed : null });
            }
            onSaved();
            onClose();
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’enregistrer cette destination.'));
        } finally {
            setBusy(false);
        }
    };

    const secretField = (label: string) => (
        <label className={styles.field}>
            <span className={styles.fieldLabel}>{label}</span>
            <TextInput
                type='password'
                enableShowHideButton
                value={secret}
                maxLength={512}
                placeholder={secretKept ? '•••••••• (inchangé)' : ''}
                onChange={(e) => setSecret(e.target.value)}
            />
        </label>
    );

    return (
        <Dialog
            open={open}
            onClose={onClose}
            onSubmit={() => void submit()}
            title={destination ? 'Modifier la destination' : 'Nouvelle destination'}
            description='Un endroit qui accepte des archives. Plusieurs travaux peuvent écrire au même endroit.'
            width={620}
            footer={
                <>
                    <Button variant='ghost' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || name.trim() === ''}>
                        {busy ? 'Enregistrement…' : 'Enregistrer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {!destination && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Type</span>
                        <SegmentedControl
                            aria-label='Type de destination'
                            value={kind}
                            onChange={setKind}
                            fullWidth
                            options={(Object.keys(DESTINATION_LABELS) as BackupDestinationKind[]).map((k) => ({
                                value: k,
                                label: DESTINATION_SHORT_LABELS[k],
                                title: DESTINATION_LABELS[k]
                            }))}
                        />
                        <span className={styles.fieldHint}>{KIND_HINTS[kind]}</span>
                    </div>
                )}

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom</span>
                    <TextInput
                        data-autofocus=''
                        value={name}
                        maxLength={120}
                        placeholder={NAME_PLACEHOLDERS[kind]}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                {kind === 'device' && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Machine</span>
                        <SearchSelect
                            value={deviceId}
                            aria-label='Machine'
                            placeholder='Choisir une machine…'
                            options={devices.map((d) => ({
                                value: d.id,
                                label: d.name,
                                detail: d.online ? undefined : 'hors ligne'
                            }))}
                            onChange={setDeviceId}
                        />
                        <span className={styles.fieldHint}>
                            L’agent y écrit les archives. Une machine hors ligne au moment d’un passage fait échouer ce
                            passage-là, pas les suivants.
                        </span>
                    </label>
                )}

                {kind === 'sftp' && (
                    <>
                        <div className={styles.fieldRow}>
                            <label className={`${styles.field} ${styles.fieldGrow}`}>
                                <span className={styles.fieldLabel}>Hôte</span>
                                <TextInput
                                    value={host}
                                    maxLength={255}
                                    placeholder='nas.exemple.fr'
                                    onChange={(e) => setHost(e.target.value)}
                                />
                            </label>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Port</span>
                                <TextInput
                                    type='number'
                                    min={1}
                                    max={65535}
                                    value={port}
                                    onChange={(e) =>
                                        setPort(Math.min(65535, Math.max(1, Number(e.target.value) || 22)))
                                    }
                                />
                            </label>
                        </div>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Identifiant</span>
                            <TextInput
                                value={username}
                                maxLength={255}
                                placeholder='sauvegardes'
                                autoComplete='off'
                                onChange={(e) => setUsername(e.target.value)}
                            />
                        </label>
                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>Connexion</span>
                            <SegmentedControl
                                aria-label='Connexion au serveur SFTP'
                                value={sftpAuth}
                                onChange={setSftpAuth}
                                options={SFTP_AUTHS}
                            />
                        </div>
                        {sftpAuth === 'key' ? (
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Clé privée</span>
                                <textarea
                                    className={styles.keyField}
                                    value={secret}
                                    rows={4}
                                    spellCheck={false}
                                    placeholder={
                                        secretKept
                                            ? '(clé enregistrée : laissez vide pour la conserver)'
                                            : '-----BEGIN OPENSSH PRIVATE KEY-----'
                                    }
                                    onChange={(e) => setSecret(e.target.value)}
                                />
                                <span className={styles.fieldHint}>
                                    Une clé sans phrase de passe, réservée à ces sauvegardes : elle ne redescend jamais
                                    jusqu’ici.
                                </span>
                            </label>
                        ) : (
                            secretField('Mot de passe')
                        )}
                        {destination && (
                            <div className={styles.field}>
                                <span className={styles.fieldLabel}>Empreinte du serveur</span>
                                {destination.hostKey && !resetHostKey ? (
                                    <div className={styles.fieldWithAction}>
                                        <code className={styles.hostKey}>{destination.hostKey}</code>
                                        <Button variant='ghost' type='button' onClick={() => setResetHostKey(true)}>
                                            Oublier
                                        </Button>
                                    </div>
                                ) : (
                                    <span className={styles.fieldHint}>
                                        {resetHostKey
                                            ? 'Elle sera oubliée à l’enregistrement ; le prochain test retiendra la nouvelle.'
                                            : 'Pas encore validée : testez la destination, le premier test réussi la retient.'}
                                    </span>
                                )}
                            </div>
                        )}
                    </>
                )}

                {kind === 'webdav' && (
                    <>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Adresse du serveur</span>
                            <TextInput
                                value={endpoint}
                                maxLength={255}
                                placeholder='https://cloud.exemple.fr/remote.php/dav/files/moi'
                                onChange={(e) => setEndpoint(e.target.value)}
                            />
                            <span className={styles.fieldHint}>
                                Pour Nextcloud : Fichiers → Paramètres de fichiers → WebDAV.
                            </span>
                        </label>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Identifiant</span>
                                <TextInput
                                    value={username}
                                    maxLength={255}
                                    autoComplete='off'
                                    onChange={(e) => setUsername(e.target.value)}
                                />
                            </label>
                            {secretField('Mot de passe')}
                        </div>
                    </>
                )}

                <div className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={pathId}>
                        {kind === 's3' ? 'Préfixe' : 'Dossier'}
                    </label>
                    {kind === 'device' ? (
                        <DeviceFolderField
                            id={pathId}
                            device={selectedDevice}
                            value={path}
                            placeholder={PATH_PLACEHOLDERS[kind]}
                            pickerDescription='Choisissez le dossier qui recevra les archives de sauvegarde. Il sera créé s’il n’existe pas.'
                            onChange={setPath}
                        />
                    ) : (
                        <TextInput
                            id={pathId}
                            value={path}
                            maxLength={512}
                            placeholder={PATH_PLACEHOLDERS[kind]}
                            onChange={(e) => setPath(e.target.value)}
                        />
                    )}
                    <span className={styles.fieldHint}>{PATH_HINTS[kind]}</span>
                </div>

                {kind === 's3' && (
                    <>
                        <label className={styles.field}>
                            <span className={styles.fieldLabel}>Adresse du service</span>
                            <TextInput
                                value={endpoint}
                                maxLength={255}
                                placeholder='https://s3.exemple.fr'
                                onChange={(e) => setEndpoint(e.target.value)}
                            />
                        </label>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Bucket</span>
                                <TextInput
                                    value={bucket}
                                    maxLength={128}
                                    placeholder='sauvegardes'
                                    onChange={(e) => setBucket(e.target.value)}
                                />
                            </label>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Région</span>
                                <TextInput
                                    value={region}
                                    maxLength={64}
                                    placeholder='garage'
                                    onChange={(e) => setRegion(e.target.value)}
                                />
                                <span className={styles.fieldHint}>Vide = us-east-1.</span>
                            </label>
                        </div>
                        <div className={styles.fieldRow}>
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Clé d’accès</span>
                                <TextInput
                                    value={accessKeyId}
                                    maxLength={255}
                                    onChange={(e) => setAccessKeyId(e.target.value)}
                                />
                            </label>
                            {secretField('Clé secrète')}
                        </div>
                        <Switch
                            checked={pathStyle}
                            onChange={setPathStyle}
                            label='Adressage par chemin'
                            hint='Activé pour Garage et MinIO (https://hôte/bucket/clé). À désactiver pour AWS S3.'
                        />
                    </>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}
