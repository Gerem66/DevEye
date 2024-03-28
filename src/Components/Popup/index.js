import React from 'react';

import styles from './style.module.css';

/**
 * @typedef {import('react').HTMLAttributes<HTMLDivElement>} HTMLAttributes
 * @typedef {import('react').DetailedHTMLProps<HTMLAttributes, HTMLDivElement>} DetailedHTMLProps
 * 
 * @typedef {object} CardValueProps
 * @property {React.JSX.Element|React.JSX.Element[]} children
 * @property {string} id
 * @property {string} [title]
 * @property {string} [style]
 */

/** @type {Record<string, React.Dispatch<React.SetStateAction<boolean>>>} */
const PopupEvents = {};

/** @param {string} id */
function OpenPopup(id) {
    if (PopupEvents[id]) {
        PopupEvents[id](true);
    }
}

/** @param {string} id */
function ClosePopup(id) {
    if (PopupEvents[id]) {
        PopupEvents[id](false);
    }
}

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function Popup({ children, id, title = '', style = '' }) {
    const [ opened, setOpened ] = React.useState(false);

    React.useEffect(() => {
        PopupEvents[id] = setOpened;

        return () => {
            delete PopupEvents[id];
        };
    }, [id]);

    /** @type {DetailedHTMLProps['style']} */
    const styleCard = {
        paddingTop: !!title ? '52px' : '12px'
    };

    /** @param {React.MouseEvent<HTMLDivElement, MouseEvent>} event */
    const onBackgroundClick = (event) => {
        if (event.target === event.currentTarget) {
            setOpened(false);
        }
    };

    return (
        <div
            className={`${styles.popup} ${opened ? styles.opened : ''}`}
            onClick={onBackgroundClick}
        >
            <div
                className={`${styles.card} bg-blue-dark ${style}`}
                style={styleCard}
                data-title={title}
            >
                {children}
            </div>
        </div>
    );
}

export { OpenPopup, ClosePopup };
export default Popup;
