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

import { SIGNATURES_MAX, type SavedSignature } from '../../contracts/signatures';
import { assetUrl } from './documents';
import { strokesPath, type SignatureData } from './elements';
import { HAND_FONT_FAMILY } from './fonts';
import type { Point } from './geometry';
import styles from './pdf.module.css';
import { fromStored, storedImageUrl } from './savedSignatures';
import { importSignature } from './signatureImage';
import { PAD_STROKE, SignaturePad } from './SignaturePad';

type Mode = 'draw' | 'write' | 'import';

interface SignatureDialogProps {
    role: 'signature' | 'initials' | null;
    /** Celles gardées sur le compte, `null` tant qu'on ne les a pas. */
    saved: readonly SavedSignature[] | null;
    onClose: () => void;
    /** `keep` : la garder sur le compte pour la prochaine fois. */
    onPick: (data: SignatureData, keep: boolean) => void;
    onRemoveSaved: (id: number) => void;
}

/** Une signature gardée, telle que la liste la montre. */
function SavedPreview({ saved }: { saved: SavedSignature }) {
    const { data } = saved;
    switch (data.kind) {
        case 'path':
            return (
                <svg className={styles.savedSvg} viewBox={`0 0 ${data.width} ${data.height}`}>
                    <path
                        d={data.path}
                        fill='none'
                        stroke='currentColor'
                        strokeWidth={data.stroke}
                        strokeLinecap='round'
                        strokeLinejoin='round'
                    />
                </svg>
            );
        case 'text':
            return (
                <span className={styles.savedText} style={{ fontFamily: `'${HAND_FONT_FAMILY}', cursive` }}>
                    {data.text}
                </span>
            );
        case 'image':
            return <img className={styles.savedImage} src={storedImageUrl(data)} alt='' />;
    }
}

/** Dessiner, écrire ou importer une signature (ou un paraphe). */
export function SignatureDialog({ role, saved, onClose, onPick, onRemoveSaved }: SignatureDialogProps) {
    const [mode, setMode] = useState<Mode>('draw');
    const [keep, setKeep] = useState(true);
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
    const mine = (saved ?? []).filter((s) => s.role === role);
    const full = (saved?.length ?? 0) >= SIGNATURES_MAX;
    const submit = (): void => {
        if (data) onPick(data, keep && !full);
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
                {mine.length > 0 && (
                    <div className={styles.savedList} role='list' aria-label='Signatures gardées'>
                        {mine.map((s) => (
                            <div key={s.id} className={styles.savedCard} role='listitem'>
                                <button
                                    type='button'
                                    className={styles.savedPick}
                                    title='Utiliser celle-ci'
                                    onClick={() => onPick(fromStored(s.data), false)}
                                >
                                    <SavedPreview saved={s} />
                                </button>
                                <button
                                    type='button'
                                    className={styles.savedRemove}
                                    aria-label='Retirer cette signature gardée'
                                    title='Retirer du compte'
                                    onClick={() => onRemoveSaved(s.id)}
                                >
                                    <span className='icon icon-x' aria-hidden='true' />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                {mine.length > 0 && <p className={styles.note}>Ou faites-en une nouvelle :</p>}
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
                <Checkbox checked={keep && !full} onChange={setKeep} disabled={full}>
                    {full
                        ? `Garder sur mon compte : vous en gardez déjà ${SIGNATURES_MAX}, retirez-en une d’abord`
                        : 'Garder sur mon compte, chiffrée, pour la prochaine fois'}
                </Checkbox>
                <ErrorNote note={error} inline onDismiss={() => setError(null)} />
            </div>
        </Dialog>
    );
}
