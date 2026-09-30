import { useEffect, useState } from 'react';
import type { DeviceRelayOption } from '@deveye/types/sdk';

import { humanizeError } from '@/api/useResource';
import { useDevices } from '@/devicesProvider';
import SelectInput from '../SelectInput';
import styles from './style.module.css';

/**
 * Les appareils qu'on peut choisir pour joindre un service par leur agent, et
 * pourquoi pas les autres. La liste vient du serveur (`load`, la commande du
 * module), qui seul connaît les droits et les agents ; tant qu'il n'est pas
 * lu, ou en lecture seule (`load` à `null`), les noms de l'espace suffisent à
 * montrer celui qui est choisi.
 */
export function useDeviceRelayOptions(load: (() => Promise<readonly DeviceRelayOption[]>) | null): {
    devices: readonly DeviceRelayOption[];
    error: string | null;
} {
    const workspace = useDevices();
    const [loaded, setLoaded] = useState<readonly DeviceRelayOption[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (!load) return;
        let live = true;
        load().then(
            (devices) => {
                if (live) setLoaded(devices);
            },
            (e) => {
                if (live) setError(humanizeError(e, 'La liste des appareils n’a pas pu être chargée.'));
            }
        );
        return () => {
            live = false;
        };
    }, [load]);
    return {
        devices: loaded ?? workspace.devices.map((d) => ({ id: d.id, name: d.name, online: d.online, blocked: null })),
        error
    };
}

export interface DeviceRelayFieldProps {
    /** L'appareil choisi ; vide tant qu'aucun ne l'est. */
    value: string;
    onChange: (deviceId: string) => void;
    /** La commande du module qui liste les appareils ; `null` en lecture seule. */
    load: (() => Promise<readonly DeviceRelayOption[]>) | null;
    disabled?: boolean;
    /** Pour un libellé posé par l'appelant (`<label htmlFor>`) ; sinon `aria-label`. */
    id?: string;
    'aria-label'?: string;
}

/**
 * Le choix de l'appareil par lequel joindre un service : un appareil qu'on ne
 * peut pas choisir reste listé, grisé, et la raison s'affiche dessous. Le
 * libellé et l'aide restent à l'appelant, qui sait ce que l'appareil verra.
 */
export function DeviceRelayField({ value, onChange, load, disabled, id, ...aria }: DeviceRelayFieldProps) {
    const { devices, error } = useDeviceRelayOptions(disabled ? null : load);
    const blocked = devices.filter((d) => d.blocked !== null);

    return (
        <>
            <SelectInput
                id={id}
                aria-label={aria['aria-label']}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value)}
            >
                <option value=''>Choisir un appareil…</option>
                {devices.map((d) => (
                    <option key={d.id} value={d.id} disabled={d.blocked !== null && d.id !== value}>
                        {d.name}
                        {d.online ? '' : ' (hors ligne)'}
                    </option>
                ))}
            </SelectInput>
            {error && <span className={styles.note}>{error}</span>}
            {blocked.map((d) => (
                <span key={d.id} className={styles.note}>
                    « {d.name} » : {d.blocked}
                </span>
            ))}
        </>
    );
}
