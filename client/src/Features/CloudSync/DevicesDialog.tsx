import { useState } from 'react';
import type { CloudSyncShare } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import DeviceFolderPicker from './DeviceFolderPicker';
import { useAttachableDevices, useShareDevices } from './useShareDevices';
import styles from './style.module.css';

interface DevicesDialogProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    onChanged: () => void;
}

/** Gestion des appareils d'un partage : attacher, pause/reprise, détacher. */
export default function DevicesDialog({ open, share, onClose, onChanged }: DevicesDialogProps) {
    // Nom et présence pris sur le vif : figés dans `share`, ils ne suivaient ni
    // un renommage ni un retour en ligne avant un rechargement de la page.
    const attachedDevices = useShareDevices(share);
    const attachable = useAttachableDevices(share);
    const [deviceId, setDeviceId] = useState('');
    const [localPath, setLocalPath] = useState('');
    const [pickerOpen, setPickerOpen] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const pickedDevice = attachable.find((d) => d.id === deviceId);

    const run = async (action: () => Promise<unknown>) => {
        setError(null);
        try {
            await action();
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Action impossible.');
        }
    };

    const attach = () =>
        run(async () => {
            await ws.send('cloudSync.attachDevice', { shareId: share.id, deviceId, localPath });
            setDeviceId('');
            setLocalPath('');
        });

    return (
        <>
            <Dialog open={open} onClose={onClose} title={`Appareils — ${share.name}`} width={560}>
                <div className={styles.formCol}>
                    <div className={styles.rows}>
                        {attachedDevices.map((d) => (
                            <div key={d.deviceId} className={styles.row}>
                                <span className={`icon icon-server`} />
                                <div className={styles.rowMain}>
                                    <span className={styles.rowTitle}>
                                        {d.deviceName}
                                        {!d.online && ' (hors ligne)'}
                                        {d.status === 'paused' && ' — en pause'}
                                    </span>
                                    <span className={styles.rowSub}>{d.localPath}</span>
                                </div>
                                <div className={styles.rowActions}>
                                    <Button
                                        variant='ghost'
                                        icon={d.status === 'paused' ? 'play' : 'pause'}
                                        title={d.status === 'paused' ? 'Reprendre' : 'Mettre en pause'}
                                        onClick={() =>
                                            void run(() =>
                                                ws.send(
                                                    d.status === 'paused'
                                                        ? 'cloudSync.resumeDevice'
                                                        : 'cloudSync.pauseDevice',
                                                    { shareId: share.id, deviceId: d.deviceId }
                                                )
                                            )
                                        }
                                    />
                                    <Button
                                        variant='ghost'
                                        icon='x'
                                        title='Détacher (les fichiers locaux restent)'
                                        onClick={() =>
                                            void run(() =>
                                                ws.send('cloudSync.detachDevice', {
                                                    shareId: share.id,
                                                    deviceId: d.deviceId
                                                })
                                            )
                                        }
                                    />
                                </div>
                            </div>
                        ))}
                        {attachedDevices.length === 0 && (
                            <div className={styles.mutedNote}>Aucun appareil attaché pour l’instant.</div>
                        )}
                    </div>

                    <label className={styles.field}>
                        Attacher un appareil
                        <SelectInput
                            value={deviceId}
                            onChange={(e) => {
                                setDeviceId(e.target.value);
                                setLocalPath('');
                            }}
                        >
                            <option value=''>— Choisir (en ligne uniquement) —</option>
                            {attachable.map((d) => (
                                <option key={d.id} value={d.id}>
                                    {d.name}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    {pickedDevice && (
                        <div className={styles.formRow}>
                            <label className={styles.field}>
                                Dossier local
                                <TextInput
                                    placeholder='/home/user/Cloud'
                                    value={localPath}
                                    onChange={(e) => setLocalPath(e.target.value)}
                                />
                            </label>
                            <Button variant='secondary' icon='folder' onClick={() => setPickerOpen(true)}>
                                Parcourir
                            </Button>
                            <Button disabled={localPath.trim() === ''} onClick={() => void attach()}>
                                Attacher
                            </Button>
                        </div>
                    )}
                    {error && <div className={styles.mutedNote}>{error}</div>}
                </div>
            </Dialog>
            {pickedDevice && (
                <DeviceFolderPicker
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
