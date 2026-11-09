import { useEffect, useState } from 'react';
import {
    Button,
    Checkbox,
    Dialog,
    Dropzone,
    ErrorNote,
    SegmentedControl,
    TextInput,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import { assetUrl } from './documents';
import { strokesPath, type SignatureData } from './elements';
import { HAND_FONT_FAMILY } from './fonts';
import type { Point } from './geometry';
import styles from './pdf.module.css';
import { importSignature } from './signatureImage';
import { PAD_STROKE, SignaturePad } from './SignaturePad';

type Mode = 'draw' | 'write' | 'import';

interface SignatureDialogProps {
    role: 'signature' | 'initials' | null;
    onClose: () => void;
    onPick: (data: SignatureData) => void;
}

/** Dessiner, écrire ou importer une signature (ou un paraphe). */
export function SignatureDialog({ role, onClose, onPick }: SignatureDialogProps) {
    const [mode, setMode] = useState<Mode>('draw');
    const [strokes, setStrokes] = useState<readonly (readonly Point[])[]>([]);
    const [text, setText] = useState('');
    const [imported, setImported] = useState<SignatureData | null>(null);
    const [removeWhite, setRemoveWhite] = useState(true);
    const [file, setFile] = useState<File | null>(null);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const open = role !== null;

    useEffect(() => {
        if (!open) return;
        setStrokes([]);
        setText('');
        setImported(null);
        setFile(null);
        setError(null);
    }, [open]);

    // Le détourage se rejoue quand on coche ou décoche.
    useEffect(() => {
        if (!file) return;
        let cancelled = false;
        importSignature(file, removeWhite)
            .then((data) => {
                if (!cancelled) setImported(data);
            })
            .catch((e: unknown) => {
                if (!cancelled)
                    setError({ message: e instanceof Error ? e.message : 'Cette image ne se lit pas.', code: null });
            });
        return () => {
            cancelled = true;
        };
    }, [file, removeWhite]);

    const ready = (): SignatureData | null => {
        switch (mode) {
            case 'draw': {
                const ink = strokesPath(strokes, PAD_STROKE);
                return ink
                    ? { kind: 'path', path: ink.path, width: ink.box.width, height: ink.box.height, stroke: PAD_STROKE }
                    : null;
            }
            case 'write':
                return text.trim() === '' ? null : { kind: 'text', text: text.trim() };
            case 'import':
                return imported;
        }
    };
    const data = ready();
    const submit = (): void => {
        if (data) onPick(data);
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={role === 'initials' ? 'Votre paraphe' : 'Votre signature'}
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={!data}>
                        Utiliser
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <SegmentedControl
                    value={mode}
                    options={[
                        { value: 'draw', label: 'Dessiner' },
                        { value: 'write', label: 'Écrire' },
                        { value: 'import', label: 'Importer' }
                    ]}
                    onChange={setMode}
                    fullWidth
                    aria-label='Façon de signer'
                />
                {mode === 'draw' && (
                    <>
                        <SignaturePad strokes={strokes} onChange={setStrokes} />
                        <div className={styles.sigRow}>
                            <span className={styles.note}>À la souris, au doigt ou au stylet.</span>
                            <Button variant='ghost' disabled={strokes.length === 0} onClick={() => setStrokes([])}>
                                Effacer
                            </Button>
                        </div>
                    </>
                )}
                {mode === 'write' && (
                    <>
                        <TextInput
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder={role === 'initials' ? 'Vos initiales' : 'Votre nom'}
                            autoFocus
                            aria-label={role === 'initials' ? 'Texte du paraphe' : 'Texte de la signature'}
                        />
                        <div className={styles.sigPreview} style={{ fontFamily: `'${HAND_FONT_FAMILY}', cursive` }}>
                            {text || (role === 'initials' ? 'A.B.' : 'Votre nom')}
                        </div>
                    </>
                )}
                {mode === 'import' && (
                    <>
                        {imported?.kind === 'image' ? (
                            <div className={styles.sigImported}>
                                <img src={assetUrl(imported.assetId)} alt='' className={styles.sigImportedImage} />
                            </div>
                        ) : (
                            <Dropzone
                                title='Déposez une image de votre signature'
                                hint='ou cliquez pour la choisir : une photo, un scan.'
                                accept='image/*'
                                onFiles={([picked]) => setFile(picked.file)}
                            />
                        )}
                        <div className={styles.sigRow}>
                            <Checkbox checked={removeWhite} onChange={setRemoveWhite}>
                                Retirer le fond blanc
                            </Checkbox>
                            {file && (
                                <Button
                                    variant='ghost'
                                    onClick={() => {
                                        setFile(null);
                                        setImported(null);
                                    }}
                                >
                                    Autre image
                                </Button>
                            )}
                        </div>
                    </>
                )}
                <ErrorNote note={error} inline onDismiss={() => setError(null)} />
            </div>
        </Dialog>
    );
}
