import { useEffect, useRef, useState } from 'react';
import styles from './style.module.css';

import { copyText, useLiveOutline } from 'deveye-sdk-client';
import type { PasswordEntry, PasswordEntryMasked } from '../contracts/domain';

type RowPassword = PasswordEntry | PasswordEntryMasked;

interface PasswordRowProps {
    password: RowPassword | null;
    onEdit?: (id: number) => void;
    onReveal?: (id: number) => void;
    onMask?: (id: number) => void;
    /** Fetch + copy the clear password without revealing it. Returns success. */
    onCopyPassword?: (id: number) => Promise<boolean>;
}

const REVEAL_DURATION_MS = 15_000;

/**
 * Copy-to-clipboard icon with "copied" feedback. Either copies `value` locally,
 * or delegates to `onCopy` (which performs the copy itself and returns whether
 * it succeeded, used to copy a still-masked password fetched on demand).
 */
function CopyButton({
    value,
    onCopy,
    className,
    title = 'Copier'
}: {
    value?: string;
    onCopy?: () => Promise<boolean>;
    className?: string;
    title?: string;
}) {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const flashCopied = () => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 2000);
    };

    const copy = () => {
        if (onCopy) {
            void onCopy().then((ok) => {
                if (ok) flashCopied();
            });
            return;
        }
        void copyText(value ?? '').then((ok) => {
            // Clipboard refused (denied permission): no-op.
            if (ok) flashCopied();
        });
    };

    useEffect(
        () => () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        },
        []
    );

    return (
        <i
            className={`icon ${copied ? 'icon-square-check' : 'icon-copy'} ${className ?? ''}`}
            onClick={copy}
            title={copied ? 'Copié !' : title}
        />
    );
}

function PasswordRow({
    password,
    onEdit = () => {},
    onReveal = () => {},
    onMask = () => {},
    onCopyPassword
}: PasswordRowProps) {
    const id = password?.id ?? null;
    // Quelqu'un consulte cette entrée : sa couleur sur la ligne.
    const outline = useLiveOutline('l1', id === null ? null : String(id));
    const isRevealed = password !== null && password.password !== '';
    // A masked entry whose stored password is empty: show an empty cell rather
    // than fake dots + reveal/copy controls that would yield nothing. Only the
    // masked variant carries `hasPassword`; a revealed entry is never "empty".
    const isEmptyPassword =
        password !== null && password.password === '' && 'hasPassword' in password && !password.hasPassword;

    // Auto-hide a revealed password after the timeout. The timer is keyed on the
    // revealed state so it starts when the clear value actually appears (not when
    // the reveal request is fired) and resets cleanly on unmount or re-mask.
    useEffect(() => {
        if (!isRevealed || id === null) return;
        const timer = setTimeout(() => onMask(id), REVEAL_DURATION_MS);
        return () => clearTimeout(timer);
    }, [isRevealed, id, onMask]);

    if (password === null) {
        return (
            <tr data-id={`${Math.random()}`} style={{ height: 48 }}>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
            </tr>
        );
    }

    const handleReveal = () => onReveal(password.id);

    return (
        <tr data-id={`${password.id}`} {...outline}>
            <td>{password.service}</td>

            <td>
                <div className={styles['cell-flex']}>
                    <span className={styles['cell-text']}>{password.email}</span>
                    {password.email && <CopyButton value={password.email} className={styles['cell-icon']} />}
                </div>
            </td>

            <td>
                {isEmptyPassword ? (
                    <div className={styles['cell-flex']} />
                ) : (
                    <div className={styles['cell-flex']}>
                        <span className={styles['cell-text']}>{isRevealed ? password.password : '••••••••'}</span>
                        {isRevealed ? (
                            <CopyButton
                                value={password.password}
                                className={styles['cell-icon']}
                                title='Copier le mot de passe'
                            />
                        ) : (
                            <>
                                <i
                                    className={`icon icon-eye-open ${styles['cell-icon']}`}
                                    onClick={handleReveal}
                                    title='Afficher'
                                />
                                {onCopyPassword && (
                                    <CopyButton
                                        onCopy={() => onCopyPassword(password.id)}
                                        className={styles['cell-icon']}
                                        title='Copier sans afficher'
                                    />
                                )}
                            </>
                        )}
                    </div>
                )}
            </td>

            {password.status === 'active' ? (
                <td className={styles['cell-active']}>Actif</td>
            ) : password.status === 'inactive' ? (
                <td className={styles['cell-inactive']}>Inactif</td>
            ) : (
                <td className={styles['cell-none']}>Aucun</td>
            )}

            <td className={styles['edit-cell']}>
                <i className='icon icon-other' onClick={() => onEdit(password.id)} />
            </td>
        </tr>
    );
}

export default PasswordRow;
export type { RowPassword };
