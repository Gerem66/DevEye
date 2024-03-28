import styles from './style.module.css';

/**
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/** @param {{ password: PasswordType }} props */
function PasswordRow({ password }) {
    return (
        <tr data-id={`${password.ID}`}>
            <td>{password.service}</td>

            <td>{password.email}</td>

            <td className={styles['password-cell']}>
                <p>{password.password}</p>
                {password.password !== '**********' ? null : (
                    <i className='icon icon-eye-open' />
                )}
            </td>

            {password.status === 'active' ? (
                <td className={styles['cell-active']}>Actif</td>
            ) : password.status === 'inactive' ? (
                <td className={styles['cell-inactive']}>Inactif</td>
            ) : (
                <td className={styles['cell-none']}>Aucun</td>
            )}

            <td>
                <i className='icon icon-other' />
            </td>
        </tr>
    );
}

export default PasswordRow;
