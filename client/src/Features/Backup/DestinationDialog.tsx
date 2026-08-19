import { useEffect, useState } from 'react';
import type { BackupDestination, BackupDestinationKind } from 'deveye-types';

import { Button, DeviceFolderPicker, Dialog, SelectInput, Switch, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { useDevices } from '@/stores/devices';
import { backupError, DESTINATION_LABELS } from './format';
import styles from './style.module.css';

interface DestinationDialogProps {
    open: boolean;
    /** `null` = création. */
    destination: BackupDestination | null;
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Déclarer ou modifier une destination.
 *
 * **Un seul formulaire pour les trois genres**, dont les champs apparaissent
 * selon le genre choisi. Trois dialogues auraient obligé à choisir avant de
 * savoir ce que chacun demande, et un formulaire de plus par genre à venir.
 *
 * Le genre n'est pas modifiable après coup : changer un dossier local en bucket
 * S3 ne conserve rien de ce qui précède, et les archives déjà écrites resteraient
 * pointées par des exécutions devenues introuvables. Créer une seconde
 * destination est plus honnête, et laisse l'ancienne se vider par rétention.
 */
export function DestinationDialog({ open, destination, onClose, onSaved }: DestinationDialogProps) {
    const { devices } = useDevices();

    const [kind, setKind] = useState<BackupDestinationKind>('local');
    const [name, setName] = useState('');
    const [deviceId, setDeviceId] = useState('');
    const [path, setPath] = useState('');
    const [endpoint, setEndpoint] = useState('');
    const [region, setRegion] = useState('');
    const [bucket, setBucket] = useState('');
    const [accessKeyId, setAccessKeyId] = useState('');
    const [secret, setSecret] = useState('');
    const [pathStyle, setPathStyle] = useState(true);
    const [encrypt, setEncrypt] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setError(null);
        setSecret('');
        if (destination) {
            setKind(destination.kind);
            setName(destination.name);
            setDeviceId(destination.deviceId ?? '');
            setPath(destination.path);
            setEndpoint(destination.endpoint ?? '');
            setRegion(destination.region ?? '');
            setBucket(destination.bucket ?? '');
            setAccessKeyId(destination.accessKeyId ?? '');
            setPathStyle(destination.pathStyle);
            setEncrypt(destination.encrypt);
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
        setPathStyle(true);
        setEncrypt(true);
        setPickerOpen(false);
    }, [open, destination]);

    // Le chiffrement suit le genre tant qu'on n'y a pas touché à la main : un
    // dossier local vit sous la même garde que le serveur, un bucket distant
    // non. C'est le défaut le plus sûr sans être le plus pénible.
    useEffect(() => {
        if (destination) return;
        setEncrypt(kind !== 'local');
    }, [kind, destination]);

    const selectedDevice = devices.find((d) => d.id === deviceId) ?? null;

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const body = {
                name: name.trim(),
                deviceId: kind === 'device' ? deviceId || null : null,
                path: path.trim(),
                endpoint: kind === 's3' ? endpoint.trim() : null,
                region: kind === 's3' ? region.trim() || 'us-east-1' : null,
                bucket: kind === 's3' ? bucket.trim() : null,
                accessKeyId: kind === 's3' ? accessKeyId.trim() : null,
                pathStyle,
                encrypt
            };
            if (destination) {
                await ws.send('backup.destinationUpdate', {
                    destinationId: destination.id,
                    ...body,
                    // Champ vide = secret inchangé. Le serveur ne l'a jamais
                    // rendu, on ne peut donc pas le renvoyer à l'identique.
                    ...(secret.trim() ? { secret: secret.trim() } : {})
                });
            } else {
                await ws.send('backup.destinationAdd', { kind, ...body, secret: secret.trim() || null });
            }
            onSaved();
            onClose();
        } catch (e) {
            setError(backupError(e, 'Impossible d’enregistrer cette destination.'));
        } finally {
            setBusy(false);
        }
    };

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
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Type</span>
                        <SelectInput value={kind} onChange={(e) => setKind(e.target.value as BackupDestinationKind)}>
                            {(Object.keys(DESTINATION_LABELS) as BackupDestinationKind[]).map((k) => (
                                <option key={k} value={k}>
                                    {DESTINATION_LABELS[k]}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.fieldHint}>
                            {kind === 'local'
                                ? 'Sur le disque du serveur DevEye. Simple, mais la copie meurt avec la machine qu’elle sauvegarde.'
                                : kind === 'device'
                                  ? 'Sur une machine où tourne un agent — un Raspberry Pi, un NAS. Rien à installer de plus.'
                                  : 'Garage, MinIO, Scaleway, Backblaze, AWS. Le seul type qui sorte les archives du réseau local.'}
                        </span>
                    </label>
                )}

                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Nom</span>
                    <TextInput
                        data-autofocus=''
                        value={name}
                        maxLength={120}
                        placeholder={kind === 's3' ? 'Garage du Raspberry' : 'Disque de sauvegarde'}
                        onChange={(e) => setName(e.target.value)}
                    />
                </label>

                {kind === 'device' && (
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Machine</span>
                        <SelectInput value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                            <option value=''>Choisir une machine…</option>
                            {devices.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}
                                    {d.online ? '' : ' (hors ligne)'}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.fieldHint}>
                            L’agent y écrit les archives. Une machine hors ligne au moment d’un passage fait échouer ce
                            passage-là, pas les suivants.
                        </span>
                    </label>
                )}

                <div className={styles.field}>
                    {/* Le bouton est **frère** du libellé, pas son enfant : dans
                        un `<label>`, un clic sur le bouton activerait aussi le
                        champ associé. Même découpage que le sélecteur de dossier
                        de CloudSync. */}
                    <div className={styles.pathRow}>
                        <label className={styles.pathLabel}>
                            <span className={styles.fieldLabel}>{kind === 's3' ? 'Préfixe' : 'Dossier'}</span>
                            {/* Le champ reste saisissable même avec le sélecteur :
                                coller un chemin qu'on connaît déjà ne doit pas
                                obliger à naviguer, et la machine peut être hors
                                ligne au moment où l'on déclare la destination. */}
                            <TextInput
                                value={path}
                                maxLength={512}
                                placeholder={
                                    kind === 'local' ? 'nuit' : kind === 'device' ? '/mnt/backup/deveye' : 'deveye/nuit'
                                }
                                onChange={(e) => setPath(e.target.value)}
                            />
                        </label>
                        {kind === 'device' && (
                            <Button
                                variant='secondary'
                                icon='folder'
                                type='button'
                                disabled={deviceId === ''}
                                title={deviceId === '' ? 'Choisissez d’abord une machine' : undefined}
                                onClick={() => setPickerOpen(true)}
                            >
                                Parcourir
                            </Button>
                        )}
                    </div>
                    <span className={styles.fieldHint}>
                        {kind === 'local'
                            ? 'Sous-dossier de la racine des sauvegardes du serveur. Laisser vide pour écrire à la racine.'
                            : kind === 'device'
                              ? 'Chemin absolu sur la machine. Il est créé s’il n’existe pas.'
                              : 'Préfixe des clés dans le bucket. Laisser vide pour écrire à la racine.'}
                    </span>
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
                            <label className={styles.field}>
                                <span className={styles.fieldLabel}>Clé secrète</span>
                                <TextInput
                                    type='password'
                                    enableShowHideButton
                                    value={secret}
                                    maxLength={512}
                                    placeholder={destination?.hasSecret ? '•••••••• (inchangée)' : ''}
                                    onChange={(e) => setSecret(e.target.value)}
                                />
                            </label>
                        </div>
                        <Switch
                            checked={pathStyle}
                            onChange={setPathStyle}
                            label='Adressage par chemin'
                            hint='Activé pour Garage et MinIO (https://hôte/bucket/clé). À désactiver pour AWS S3.'
                        />
                    </>
                )}

                <Switch
                    checked={encrypt}
                    onChange={setEncrypt}
                    label='Chiffrer les archives'
                    hint='Illisibles pour qui tient le disque d’en face. La clé est dérivée de CRYPT_KEY_A / CRYPT_KEY_B : sans ces deux variables, une archive chiffrée est irrécupérable.'
                />

                {error && <p className={styles.error}>{error}</p>}
            </div>

            {/* Empilé au-dessus du formulaire : il possède alors la couche de
                fermeture, donc Échap referme le sélecteur sans perdre la saisie
                derrière. Monté seulement quand une machine est choisie — il
                s'abonne aux métriques de l'appareil dès l'ouverture. */}
            {kind === 'device' && selectedDevice && (
                <DeviceFolderPicker
                    description='Choisis le dossier qui recevra les archives de sauvegarde. Il sera créé s’il n’existe pas.'
                    open={pickerOpen}
                    deviceId={selectedDevice.id}
                    deviceName={selectedDevice.name}
                    onClose={() => setPickerOpen(false)}
                    onPick={(picked) => {
                        setPath(picked);
                        setPickerOpen(false);
                    }}
                />
            )}
        </Dialog>
    );
}

export default DestinationDialog;
