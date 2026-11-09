import { Button } from 'deveye-sdk-client';

import type { SavedSignature, SignatureRole } from '../contracts/signatures';
import styles from './pdf.module.css';
import { SavedPreview } from './SavedPreview';

/** Ce que la bibliothèque sait du compte et fait de ses signatures, quel que soit le rôle montré. */
export interface LibraryProps {
    /** Celles gardées sur le compte, `null` tant qu'on ne les a pas. */
    saved: readonly SavedSignature[] | null;
    /** Celle en main pour chaque rôle, quand elle vient du compte. */
    current: Record<SignatureRole, number | null>;
    onPick: (role: SignatureRole, saved: SavedSignature) => void;
    onRemove: (id: number) => void;
    /** Dessiner, écrire ou importer une nouvelle. */
    onNew: (role: SignatureRole) => void;
}

/** Les signatures (ou paraphes) gardées sur le compte : celle en main se voit, un clic en prend une autre. */
export function SignatureLibrary({
    role,
    saved,
    current,
    onPick,
    onRemove,
    onNew
}: LibraryProps & { role: SignatureRole }) {
    const mine = (saved ?? []).filter((s) => s.role === role);
    const initials = role === 'initials';
    return (
        <div className={styles.library}>
            {mine.length === 0 ? (
                <p className={styles.inspectorNote}>
                    {initials ? 'Aucun paraphe gardé sur votre compte.' : 'Aucune signature gardée sur votre compte.'}
                </p>
            ) : (
                <div
                    className={styles.savedList}
                    role='list'
                    aria-label={initials ? 'Paraphes gardés' : 'Signatures gardées'}
                >
                    {mine.map((s) => (
                        <div key={s.id} className={styles.savedCard} role='listitem'>
                            <button
                                type='button'
                                className={`${styles.savedPick} ${s.id === current[role] ? styles.savedPickActive : ''}`}
                                aria-pressed={s.id === current[role]}
                                title={initials ? 'Utiliser ce paraphe' : 'Utiliser cette signature'}
                                onClick={() => onPick(role, s)}
                            >
                                <SavedPreview saved={s} />
                            </button>
                            <button
                                type='button'
                                className={styles.savedRemove}
                                aria-label='Retirer du compte'
                                title='Retirer du compte'
                                onClick={() => onRemove(s.id)}
                            >
                                <span className='icon icon-x' aria-hidden='true' />
                            </button>
                        </div>
                    ))}
                </div>
            )}
            <Button variant='secondary' icon='add' onClick={() => onNew(role)}>
                {initials ? 'Nouveau paraphe' : 'Nouvelle signature'}
            </Button>
        </div>
    );
}
