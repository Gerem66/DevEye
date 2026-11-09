import { useEffect, useState } from 'react';
import { Button, Dialog, TextInput } from 'deveye-sdk-client';

import styles from './pdf.module.css';

/** Un fichier qui attend son mot de passe ; `resolve(null)` : on le laisse de côté. */
export interface PasswordRequest {
    file: File;
    incorrect: boolean;
    resolve: (password: string | null) => void;
}

interface PasswordDialogProps {
    request: PasswordRequest | null;
    onDone: () => void;
}

export function PasswordDialog({ request, onDone }: PasswordDialogProps) {
    const [value, setValue] = useState('');
    useEffect(() => setValue(''), [request]);

    const answer = (password: string | null): void => {
        request?.resolve(password);
        onDone();
    };
    const submit = (): void => {
        if (value !== '') answer(value);
    };

    return (
        <Dialog
            open={request !== null}
            onClose={() => answer(null)}
            title='PDF protégé'
            width={440}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={() => answer(null)}>
                        Laisser ce fichier de côté
                    </Button>
                    <Button onClick={submit} disabled={value === ''}>
                        Ouvrir
                    </Button>
                </>
            }
        >
            {request && (
                <div className={styles.form}>
                    <p className={styles.note}>
                        « {request.file.name} » demande un mot de passe pour s’ouvrir. Il ne quitte pas cet appareil.
                    </p>
                    <TextInput
                        type='password'
                        value={value}
                        onChange={(e) => setValue(e.target.value)}
                        autoFocus
                        autoComplete='off'
                        aria-label='Mot de passe du PDF'
                        enableShowHideButton
                        error={request.incorrect && value === '' ? 'refusé' : undefined}
                    />
                    {request.incorrect && value === '' && (
                        <p className={styles.fieldError} role='alert'>
                            Ce mot de passe ne convient pas.
                        </p>
                    )}
                </div>
            )}
        </Dialog>
    );
}
