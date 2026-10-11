import styles from './CodeInput.module.css';

export const CODE_LENGTH = 6;
/** `XXXX-XXXX-XXXX-XXXX`, le format des codes de secours de la 2FA. */
export const RECOVERY_CODE_LENGTH = 19;

export interface CodeInputProps {
    value: string;
    onChange: (value: string) => void;
    /** Six chiffres saisis : l'envoi n'attend pas de clic. Jamais pour un code de secours. */
    onComplete?: (value: string) => void;
    /** Un code de secours plutôt que six chiffres. */
    recovery?: boolean;
    autoFocus?: boolean;
    disabled?: boolean;
    'aria-label'?: string;
}

/**
 * Le champ d'un code à usage unique : six chiffres d'une application
 * d'authentification, d'un e-mail ou d'un SMS, ou un code de secours.
 */
export function CodeInput({
    value,
    onChange,
    onComplete,
    recovery = false,
    autoFocus,
    disabled,
    ...rest
}: CodeInputProps) {
    return (
        <input
            type='text'
            inputMode={recovery ? 'text' : 'numeric'}
            autoComplete='one-time-code'
            pattern={recovery ? undefined : '[0-9]*'}
            maxLength={recovery ? RECOVERY_CODE_LENGTH : CODE_LENGTH}
            className={recovery ? `${styles.input} ${styles.recovery}` : styles.input}
            value={value}
            placeholder={recovery ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
            autoFocus={autoFocus}
            disabled={disabled}
            aria-label={rest['aria-label'] ?? (recovery ? 'Code de secours' : 'Code à 6 chiffres')}
            onChange={(e) => {
                const next = recovery
                    ? e.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9-]/g, '')
                          .slice(0, RECOVERY_CODE_LENGTH)
                    : e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
                onChange(next);
                if (!recovery && next.length === CODE_LENGTH) onComplete?.(next);
            }}
        />
    );
}
