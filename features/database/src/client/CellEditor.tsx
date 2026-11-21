import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import {
    Button,
    Checkbox,
    CopyButton,
    errorNote,
    ErrorNote,
    useDismissLayer,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import styles from './style.module.css';

const WIDTH = 420;
const MARGIN = 8;
/** En deçà de cette place sous la cellule, l'éditeur s'ouvre vers le haut. */
const ROOM = 280;
/** Lignes du champ : assez pour lire, la poignée donne le reste. */
const MAX_ROWS = 12;

interface CellEditorProps {
    /** La boîte de la cellule à l'écran : l'éditeur s'ouvre dessus. */
    anchor: DOMRect;
    column: string;
    type: string | null;
    value: string | null;
    nullable: boolean;
    /** Pourquoi la valeur ne se modifie pas ici ; `null` = modifiable. */
    locked: string | null;
    /** Écrit la valeur ; l'appelant referme l'éditeur sur un succès, un échec remonte ici. */
    onSave: (value: string | null) => Promise<void>;
    onClose: () => void;
}

/** Sur la cellule, vers le bas ; vers le haut quand la place manque dessous. */
function placeOf(anchor: DOMRect): CSSProperties {
    const width = Math.min(Math.max(anchor.width, WIDTH), window.innerWidth - 2 * MARGIN);
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - anchor.top;
    return below < ROOM && anchor.bottom > below
        ? { left, width, bottom: window.innerHeight - anchor.bottom, maxHeight: anchor.bottom - MARGIN }
        : { left, width, top: anchor.top, maxHeight: below - MARGIN };
}

/**
 * La valeur entière d'une cellule, posée sur elle : à lire, à copier, à
 * modifier. En portail vers `body`, au-dessus d'un voile qui garde le clic :
 * refermer l'éditeur n'actionne rien dessous. Une saisie en cours ne se perd
 * pas d'un clic à côté : seuls « Annuler » et Échap la jettent.
 */
export function CellEditor({ anchor, column, type, value, nullable, locked, onSave, onClose }: CellEditorProps) {
    const [text, setText] = useState(value ?? '');
    const [isNull, setIsNull] = useState(value === null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [place] = useState(() => placeOf(anchor));
    const field = useRef<HTMLTextAreaElement>(null);

    useDismissLayer(true, onClose);

    // Sélectionnée : la copier ne demande qu'un raccourci.
    useEffect(() => {
        field.current?.focus();
        field.current?.select();
    }, []);

    const next = isNull ? null : text;
    const dirty = next !== value;

    const save = async () => {
        if (busy || locked !== null || !dirty) return;
        setBusy(true);
        setError(null);
        try {
            await onSave(next);
        } catch (e) {
            // Le message du moteur passe tel quel : « doublon », « clé
            // étrangère absente » sont des réponses utiles.
            setError(errorNote(e, 'L’écriture a échoué.'));
            setBusy(false);
        }
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
        event.preventDefault();
        void save();
    };

    const lines = text.split('\n').length + Math.floor(text.length / 48);

    return createPortal(
        <>
            <div
                className={styles.cellShield}
                onClick={(event) => {
                    event.stopPropagation();
                    if (!dirty) onClose();
                }}
            />
            <div className={styles.cellEditor} role='dialog' aria-label={`Valeur de ${column}`} style={place}>
                <div className={styles.cellEditorHead}>
                    <span className={styles.label}>
                        {column}
                        {type && <span className={styles.columnType}>{type}</span>}
                    </span>
                    {value !== null && <CopyButton value={value} label='Copier la valeur' />}
                </div>

                <textarea
                    ref={field}
                    className={`${styles.sqlField} ${styles.cellField}`}
                    rows={Math.min(MAX_ROWS, Math.max(2, lines))}
                    value={isNull ? '' : text}
                    placeholder={isNull ? 'NULL' : ''}
                    readOnly={locked !== null}
                    spellCheck={false}
                    aria-label={`Valeur de ${column}`}
                    onChange={(event) => {
                        setText(event.target.value);
                        setIsNull(false);
                    }}
                    onKeyDown={onKeyDown}
                />

                <span className={styles.hint}>{locked ?? 'Entrée enregistre, Maj+Entrée passe à la ligne.'}</span>

                <ErrorNote note={error} inline />

                <div className={styles.cellEditorFoot}>
                    {locked === null && nullable && (
                        <Checkbox checked={isNull} onChange={setIsNull} className={styles.footerLead}>
                            <span className={styles.hint}>NULL</span>
                        </Checkbox>
                    )}
                    {locked === null ? (
                        <>
                            <Button variant='secondary' onClick={onClose} disabled={busy}>
                                Annuler
                            </Button>
                            <Button onClick={() => void save()} disabled={busy || !dirty}>
                                {busy ? 'Écriture…' : 'Enregistrer'}
                            </Button>
                        </>
                    ) : (
                        <Button variant='secondary' onClick={onClose}>
                            Fermer
                        </Button>
                    )}
                </div>
            </div>
        </>,
        document.body
    );
}

export default CellEditor;
