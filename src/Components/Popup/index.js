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

/**
 * @type {Record<string, { setOpened: React.Dispatch<React.SetStateAction<boolean>>, callback?: () => void }>}
 */
const PopupEvents = {};

/**
 * @param {string} id
 * @param {() => void} [callback]
 */
function OpenPopup(id, callback = () => {}) {
    if (PopupEvents[id]) {
        PopupEvents[id].setOpened(true);
        PopupEvents[id].callback = callback;
    }
}

/** @param {string} id */
function ClosePopup(id) {
    if (PopupEvents[id]) {
        PopupEvents[id].setOpened(false);
        if (PopupEvents[id].callback) {
            PopupEvents[id].callback();
        }
    }
}

/**
 * @param {CardValueProps} props
 * @returns {React.JSX.Element}
 */
function Popup({ children, id, title = '', style = '' }) {
    const [ opened, setOpened ] = React.useState(false);

    React.useEffect(() => {
        PopupEvents[id] = {
            setOpened,
            callback: () => {}
        }

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
            ClosePopup(id);
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
