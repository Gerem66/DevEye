import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').InputHTMLAttributes<HTMLInputElement>} InputHTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<InputHTMLAttributes, HTMLInputElement>} DetailedHTMLProps
 */

/**
 * @typedef {DetailedHTMLProps} TextInputProps
 */

/**
 * @type {React.ForwardRefExoticComponent<TextInputProps & { enableShowHideButton?: boolean, error?: string }>}
 */
const TextInput = React.forwardRef((props, ref) => {
    const [ hidden, setHidden ] = React.useState(true);

    const { enableShowHideButton, className, type, value, error, ...rest } = props;
    const classes = `${styles.input} ${className || ''} ${error ? styles['input-error'] : ''}`;

    React.useEffect(() => {
        if (type === 'password' && value === '' && !hidden) {
            setHidden(true);
        }
    }, [ value ]);

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
        </div>
    );
});

export default TextInput;
