import { useRef, useState, type DragEvent } from 'react';

import { Picto } from './icons';
import styles from './style.module.css';

interface DropzoneProps {
    onFile: (file: File) => void;
    /** La phrase principale : ce qu'on attend ici. */
    title: string;
    hint?: string;
    /** Les extensions proposées par le sélecteur du système (`.mp4,.mov`). Le dépôt, lui, accepte tout. */
    accept?: string;
    compact?: boolean;
}

/**
 * Le dépôt d'un fichier. Un vrai bouton : le clavier et les lecteurs d'écran
 * ouvrent le sélecteur du système, le glisser-déposer n'est qu'un raccourci.
 */
export function Dropzone({ onFile, title, hint, accept, compact }: DropzoneProps) {
    const input = useRef<HTMLInputElement>(null);
    const [over, setOver] = useState(false);

    const onDrop = (event: DragEvent): void => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files[0];
        if (file) onFile(file);
    };

    return (
        <>
            <button
                type='button'
                className={`${styles.dropzone} ${over ? styles.dropzoneOver : ''} ${compact ? styles.dropzoneCompact : ''}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => {
                    e.preventDefault();
                    setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
            >
                <Picto id='upload' size={compact ? 22 : 32} />
                <span className={styles.dropzoneTitle}>{title}</span>
                {hint && <span className={styles.dropzoneHint}>{hint}</span>}
            </button>
            <input
                ref={input}
                type='file'
                hidden
                accept={accept}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) onFile(file);
                    e.target.value = '';
                }}
            />
        </>
    );
}
