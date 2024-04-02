import styles from './style.module.css';

/**
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/** @param {{ password: PasswordType | null, onEdit?: (ID: number) => void, callback?: (ID: number) => void }} props */
function PasswordRow({ password, onEdit = () => {}, callback = () => {} }) {
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

    return (
        <tr data-id={`${password.ID}`}>
            <td>{password.service}</td>

            <td>{password.email}</td>

            <td className={styles['password-cell']}>
                <p>{password.password}</p>
                {password.password !== '**********' ? null : (
                    <i className='icon icon-eye-open' onClick={() => callback(password.ID)} />
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
                <i className='icon icon-other' onClick={() => onEdit(password.ID)} />
            </td>
        </tr>
    );
}

export default PasswordRow;
