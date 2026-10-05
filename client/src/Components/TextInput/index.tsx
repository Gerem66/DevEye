import React from 'react';

import styles from './style.module.css';

import type { InputHTMLAttributes, DetailedHTMLProps } from 'react';

type CustomHTMLProps = DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>;
type TextInputProps = CustomHTMLProps & {
    enableShowHideButton?: boolean;
    error?: string;
    /** Une croix « Effacer » dans le champ tant qu'il a une valeur. */
    onClear?: () => void;
};

/** Les champs dont le navigateur de bureau dessine déjà sa propre croix, mais pas le mobile. */
const NATIVE_CLEAR_ON_DESKTOP = new Set(['date', 'datetime-local', 'time', 'month', 'week']);

const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>((props, ref) => {
    const [hidden, setHidden] = React.useState(true);

    const { enableShowHideButton, className, type, value, error, onClear, ...rest } = props;
    const clearable =
        onClear !== undefined && !rest.disabled && !rest.readOnly && value !== undefined && String(value) !== '';
    const touchOnly = type !== undefined && NATIVE_CLEAR_ON_DESKTOP.has(type);
    const classes = `${styles.input} ${enableShowHideButton ? styles['input-with-btn'] : ''} ${
        clearable ? (touchOnly ? styles['input-with-clear-touch'] : styles['input-with-clear']) : ''
    } ${className || ''} ${error ? styles['input-error'] : ''}`;

    React.useEffect(() => {
        if (type === 'password' && value === '' && !hidden) {
            setHidden(true);
        }
    }, [value]);

    return (
        <div className={styles['input-container']}>
            <input
                ref={ref}
                type={type === 'password' ? (hidden ? 'password' : 'text') : type}
                className={classes}
                value={value}
                {...rest}
            />
            {!enableShowHideButton ? null : (
                <i
                    className={`icon ${hidden ? 'icon-eye-open' : 'icon-eye-close'} ${styles['input-show-hide-btn']}`}
                    onClick={() => setHidden(!hidden)}
                />
            )}
            {clearable && (
                <button
                    type='button'
                    className={`${styles['input-clear-btn']} ${touchOnly ? styles['input-clear-touch'] : ''}`}
                    aria-label='Effacer'
                    title='Effacer'
                    onClick={onClear}
                >
                    <span className='icon icon-x' aria-hidden='true' />
                </button>
            )}
        </div>
    );
});

TextInput.displayName = 'TextInput';

export default TextInput;
