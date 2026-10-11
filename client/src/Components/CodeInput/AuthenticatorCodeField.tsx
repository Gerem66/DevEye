import { CodeInput, CODE_LENGTH, RECOVERY_CODE_LENGTH } from './CodeInput';
import styles from './CodeInput.module.css';

export interface AuthenticatorCodeFieldProps {
    value: string;
    onChange: (value: string) => void;
    /** Le code de l'application est complet : l'envoi part sans clic. */
    onComplete?: (value: string) => void;
    /** Un code de secours plutôt que celui de l'application. */
    recovery: boolean;
    onRecoveryChange: (recovery: boolean) => void;
    error?: string | null;
    disabled?: boolean;
    autoFocus?: boolean;
}

/** Le code est-il complet pour le mode choisi ? */
export function authenticatorCodeReady(value: string, recovery: boolean): boolean {
    return value.length === (recovery ? RECOVERY_CODE_LENGTH : CODE_LENGTH);
}

/**
 * Le code d'une application d'authentification, ou à défaut l'un des codes de
 * secours : partout où l'application est demandée, le téléphone perdu ne doit
 * pas fermer la porte.
 */
export function AuthenticatorCodeField({
    value,
    onChange,
    onComplete,
    recovery,
    onRecoveryChange,
    error,
    disabled,
    autoFocus
}: AuthenticatorCodeFieldProps) {
    return (
        <div className={styles.field}>
            <CodeInput
                key={recovery ? 'recovery' : 'app'}
                value={value}
                recovery={recovery}
                autoFocus={autoFocus}
                disabled={disabled}
                onChange={onChange}
                onComplete={onComplete}
            />
            {error && (
                <div className={styles.error} role='alert'>
                    {error}
                </div>
            )}
            <button
                type='button'
                className={styles.switch}
                disabled={disabled}
                onClick={() => {
                    onChange('');
                    onRecoveryChange(!recovery);
                }}
            >
                {recovery ? 'Utiliser le code de l’application' : 'Utiliser un code de secours'}
            </button>
        </div>
    );
}
