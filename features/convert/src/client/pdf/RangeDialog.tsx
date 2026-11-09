import { useEffect, useState } from 'react';
import { Button, Dialog, TextInput } from 'deveye-sdk-client';

import styles from './pdf.module.css';
import { parseRanges } from './ranges';

interface RangeDialogProps {
    open: boolean;
    count: number;
    onClose: () => void;
    /** Les indices (base 0) choisis, dans l'ordre écrit. */
    onPick: (indices: number[]) => void;
}

/** Sélectionner des pages par leurs numéros : « 1-3, 7, 10- ». */
export function RangeDialog({ open, count, onClose, onPick }: RangeDialogProps) {
    const [text, setText] = useState('');
    useEffect(() => {
        if (open) setText('');
    }, [open]);
    const indices = text.trim() === '' ? null : parseRanges(text, count);
    const invalid = text.trim() !== '' && indices === null;
    const submit = (): void => {
        if (!indices) return;
        onPick(indices);
        onClose();
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Sélectionner des pages'
            width={440}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={!indices}>
                        Sélectionner
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <p className={styles.note}>
                    Des numéros séparés par des virgules, des plages avec un tiret : « 1-3, 7, 10- » prend les pages 1 à
                    3, la 7, puis de la 10 à la fin. Le document compte {count} page{count > 1 ? 's' : ''}.
                </p>
                <TextInput
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder='1-3, 7, 10-'
                    autoFocus
                    aria-label='Pages à sélectionner'
                    error={invalid ? 'illisible' : undefined}
                />
                {invalid && (
                    <p className={styles.fieldError} role='alert'>
                        Ces numéros ne se lisent pas, ou dépassent le document.
                    </p>
                )}
            </div>
        </Dialog>
    );
}
