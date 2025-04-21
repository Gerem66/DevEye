import React from 'react';

import styles from './style.module.css';

interface RowProps {
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
    center?: boolean;
}

function Row({ children, className = '', style = {}, center = false }: RowProps): React.JSX.Element {
    return (
        <div
            className={`${styles.row} ${className}`}
            style={{
                justifyContent: center ? 'center' : 'unset',
                ...style
            }}
        >
            {children}
        </div>
    );
}

export default Row;
