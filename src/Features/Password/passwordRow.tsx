import styles from './style.module.css';

import type { PasswordEntry, PasswordEntryMasked } from 'deveye-types';

type RowPassword = PasswordEntry | PasswordEntryMasked;

interface PasswordRowProps {
    password: RowPassword | null;
    onEdit?: (id: number) => void;
    callback?: (id: number) => void;
}

function PasswordRow({ password, onEdit = () => {}, callback = () => {} }: PasswordRowProps) {
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

    const isMasked = password.password === '';

    return (
        <tr data-id={`${password.id}`}>
            <td>{password.service}</td>

            <td>{password.email}</td>

            <td className={styles['password-cell']}>
                <p>{isMasked ? '••••••••' : password.password}</p>
                {isMasked ? <i className='icon icon-eye-open' onClick={() => callback(password.id)} /> : null}
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
