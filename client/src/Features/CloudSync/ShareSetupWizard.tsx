import { useState } from 'react';

import { ws } from '@/api/ws';
import { Button, DeviceFolderPicker, Dialog, SelectInput, TextInput } from '@/Components';
import { useDevices } from '@/stores/devices';
import styles from './style.module.css';

interface ShareSetupWizardProps {
    open: boolean;
    onClose: () => void;
    /** Appelé après création (et attache éventuelle) réussie. */
    onCreated: () => void;
}

/**
 * Création d'un partage : un nom, puis un premier appareil et son dossier local
 * (facultatif — attachable plus tard).
 *
 * Le dossier de stockage n'est PAS demandé. Le faire saisir revenait à demander
 * de deviner l'arborescence interne du serveur — et menait à créer le partage
 * sur une couche éphémère de conteneur, invisible depuis l'hôte et effacée au
 * redéploiement. Le serveur le dérive du nom, sous sa racine persistante.
 */
export default function ShareSetupWizard({ open, onClose, onCreated }: ShareSetupWizardProps) {
    const { devices } = useDevices();
    const [name, setName] = useState('');
    const [deviceId, setDeviceId] = useState('');
    const [localPath, setLocalPath] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const onlineDevices = devices.filter((d) => d.online);
    const pickedDevice = onlineDevices.find((d) => d.id === deviceId);

    const create = async () => {
        if (busy || name.trim() === '') return;
        setBusy(true);
        setError(null);
        try {
            const { share } = await ws.send('cloudSync.createShare', {
                name: name.trim()
            });
            if (deviceId !== '' && localPath !== '') {
                await ws.send('cloudSync.attachDevice', { shareId: share.id, deviceId, localPath });
            }
            setName('');
            setDeviceId('');
            setLocalPath('');
            onCreated();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Création impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title='Nouveau dossier cloud'
                description='Le serveur stocke les contenus chiffrés ; chaque appareil garde un miroir local.'
                width={560}
                onSubmit={create}
                footer={
                    <>
                        <Button variant='secondary' onClick={onClose}>
                            Annuler
                        </Button>
                        <Button disabled={busy || name.trim() === ''} onClick={create}>
                            Créer le partage
                        </Button>
                    </>
                }
            >
                <div className={styles.formCol}>
                    <label className={styles.field}>
                        Nom du partage
                        <TextInput placeholder='Ex. Documents' value={name} onChange={(e) => setName(e.target.value)} />
                    </label>
                    <div className={styles.formCol}>
                        <label className={styles.field}>
                            Premier appareil (facultatif)
                            <SelectInput
                                value={deviceId}
                                onChange={(e) => {
                                    setDeviceId(e.target.value);
                                    setLocalPath('');
                                }}
                            >
                                <option value=''>— Plus tard —</option>
                                {onlineDevices.map((d) => (
                                    <option key={d.id} value={d.id}>
                                        {d.name}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>
                        {pickedDevice && (
                            <div className={styles.formRow}>
                                <label className={styles.field}>
                                    Dossier local sur l’appareil
                                    <TextInput
                                        placeholder='/home/user/Cloud'
                                        value={localPath}
                                        onChange={(e) => setLocalPath(e.target.value)}
                                    />
                                </label>
                                <Button variant='secondary' icon='folder' onClick={() => setPickerOpen(true)}>
                                    Parcourir
                                </Button>
                            </div>
                        )}
                    </div>
                    {error && <div className={styles.mutedNote}>{error}</div>}
                </div>
            </Dialog>
            {pickedDevice && (
                <DeviceFolderPicker
                    description='Choisis le dossier local à synchroniser avec le cloud.'
                    open={pickerOpen}
                    deviceId={pickedDevice.id}
                    deviceName={pickedDevice.name}
                    onClose={() => setPickerOpen(false)}
                    onPick={(path) => {
                        setLocalPath(path);
                        setPickerOpen(false);
                    }}
                />
            )}
        </>
    );
}
