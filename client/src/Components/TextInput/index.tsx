import React from 'react';

import styles from './style.module.css';

import type { InputHTMLAttributes, DetailedHTMLProps } from 'react';

type CustomHTMLProps = DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>;
type TextInputProps = CustomHTMLProps & { enableShowHideButton?: boolean; error?: string };

const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>((props, ref) => {
    const [hidden, setHidden] = React.useState(true);

    const { enableShowHideButton, className, type, value, error, ...rest } = props;
    const classes = `${styles.input} ${className || ''} ${error ? styles['input-error'] : ''}`;

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
        </div>
    );
});

TextInput.displayName = 'TextInput';

export default TextInput;
