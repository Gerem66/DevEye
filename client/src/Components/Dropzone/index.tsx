import { useState, type DragEvent } from 'react';

import { filesOfDrop, pickFiles, type PickedFile } from '@/upload';
import styles from './Dropzone.module.css';

/**
 * Fait de n'importe quel élément une cible de dépôt : `over` pendant le survol,
 * `props` à étaler sur l'élément. Les dossiers déposés sont lus en entier.
 */
export function useFileDrop(onFiles: (files: PickedFile[]) => void, disabled = false) {
    const [over, setOver] = useState(false);
    const props = {
        onDragOver: (event: DragEvent) => {
            if (disabled || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setOver(true);
        },
        onDragLeave: (event: DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (event: DragEvent) => {
            if (disabled || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setOver(false);
            void filesOfDrop(event.dataTransfer).then((files) => {
                if (files.length > 0) onFiles(files);
            });
        }
    };
    return { over, props };
}

interface DropzoneProps {
    onFiles: (files: PickedFile[]) => void;
    /** La phrase principale : ce qu'on attend ici. */
    title: string;
    hint?: string;
    /** Les extensions proposées par le sélecteur du système (`.mp4,.mov`). Le dépôt, lui, accepte tout. */
    accept?: string;
    /** Plusieurs fichiers, et des dossiers entiers par dépôt. Sinon, le premier fichier seulement. */
    multiple?: boolean;
    disabled?: boolean;
    className?: string;
}

/**
 * Le dépôt de fichiers. Un vrai bouton : le clavier et les lecteurs d'écran
 * ouvrent le sélecteur du système, le glisser-déposer n'est qu'un raccourci.
 */
export function Dropzone({ onFiles, title, hint, accept, multiple, disabled, className }: DropzoneProps) {
    const deliver = (files: PickedFile[]) => {
        const kept = multiple ? files : files.slice(0, 1);
        if (kept.length > 0) onFiles(kept);
    };
    const { over, props } = useFileDrop(deliver, disabled);
    return (
        <button
            type='button'
            disabled={disabled}
            className={`${styles.dropzone} ${over ? styles.over : ''} ${className ?? ''}`}
            onClick={() => void pickFiles({ multiple, accept }).then(deliver)}
            {...props}
        >
            <span className='icon icon-upload' aria-hidden />
            <span className={styles.title}>{title}</span>
            {hint && <span className={styles.hint}>{hint}</span>}
        </button>
    );
}
