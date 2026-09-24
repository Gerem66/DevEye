import { useState, type ReactNode } from 'react';

import Button from '../Button';
import { DeviceFolderPicker } from '../DeviceFolderPicker';
import TextInput from '../TextInput';
import styles from './style.module.css';

export interface DeviceFolderFieldProps {
    /** La machine où l'on choisit ; sans elle, « Parcourir » reste grisé. */
    device: { id: string; name: string } | null;
    value: string;
    onChange: (path: string) => void;
    placeholder?: string;
    /** Pour un libellé posé par l'appelant (`<label htmlFor>`) ; sinon `aria-label`. */
    id?: string;
    'aria-label'?: string;
    /** À quoi servira le dossier, dit dans le sélecteur. */
    pickerDescription?: string;
    /** Le sélecteur propose de créer un dossier ; faux pour choisir ce qui existe déjà. */
    allowCreate?: boolean;
    disabled?: boolean;
    /** Un bouton de plus au bout de la rangée (« Attacher »). */
    action?: ReactNode;
}

/**
 * Un chemin sur une machine : saisi à la main (coller un chemin connu, une
 * machine hors ligne) ou choisi en parcourant ses dossiers. Le libellé reste
 * à l'appelant, hors d'un `<label>` qui envelopperait le bouton : un clic sur
 * « Parcourir » activerait aussi le champ.
 */
export function DeviceFolderField({
    device,
    value,
    onChange,
    placeholder,
    id,
    pickerDescription,
    allowCreate = true,
    disabled,
    action,
    ...aria
}: DeviceFolderFieldProps) {
    const [open, setOpen] = useState(false);
    return (
        <div className={styles.row}>
            <TextInput
                id={id}
                aria-label={aria['aria-label']}
                className={styles.input}
                value={value}
                maxLength={4096}
                placeholder={placeholder}
                disabled={disabled}
                spellCheck={false}
                onChange={(e) => onChange(e.target.value)}
            />
            <Button
                variant='secondary'
                icon='folder'
                type='button'
                disabled={disabled || !device}
                title={device ? undefined : 'Choisissez d’abord une machine'}
                onClick={() => setOpen(true)}
            >
                Parcourir
            </Button>
            {action}
            {/* Monté seulement avec une machine : il s'abonne à ses métriques dès l'ouverture. */}
            {device && (
                <DeviceFolderPicker
                    open={open}
                    deviceId={device.id}
                    deviceName={device.name}
                    description={pickerDescription}
                    allowCreate={allowCreate}
                    onClose={() => setOpen(false)}
                    onPick={(path) => {
                        onChange(path);
                        setOpen(false);
                    }}
                />
            )}
        </div>
    );
}

export default DeviceFolderField;
