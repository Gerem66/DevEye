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
 * @type {Record<string, { setInputData: React.Dispatch<React.SetStateAction<any | null>>, setOpened: React.Dispatch<React.SetStateAction<boolean>>, callback?: (data: any) => void }>}
 */
const PopupEvents = {};

/**
 * @template {Object} T
 * @param {string} id
 * @param {any} [inputData]
 * @returns {Promise<T | null>}
 */
function OpenPopup(id, inputData = null) {
    if (PopupEvents[id]) {
        return new Promise((resolve) => {
            PopupEvents[id].setInputData(inputData);
            PopupEvents[id].setOpened(true);
            PopupEvents[id].callback = (data) => {
                resolve(data);
            };
        });
    }
    return Promise.resolve(null);
}

/**
 * @param {string} id
 * @param {any} data
 */
function ClosePopup(id, data = null) {
    if (PopupEvents[id]) {
        PopupEvents[id].setInputData(null);
        PopupEvents[id].setOpened(false);
        if (PopupEvents[id].callback) {
            PopupEvents[id].callback(data);
        }
    }
}

/**
 * @param {CardValueProps & { onInputChange?: ((input: any) => void) | null, onClosePopup?: ((id: string) => void) | null }} props
 * @returns {React.JSX.Element}
 */
function Popup({ children, id, title = '', style = '', onInputChange = null, onClosePopup = null }) {
    const [opened, setOpened] = React.useState(false);

    React.useEffect(() => {
        PopupEvents[id] = {
            setInputData: (data) => {
                onInputChange?.(data);
            },
            setOpened,
            callback: () => {}
        };

        return () => {
            delete PopupEvents[id];
        };
    }, [id]);

    /** @type {DetailedHTMLProps['style']} */
    const styleCard = {
        paddingTop: title ? '52px' : '12px'
    };

    /** @param {React.MouseEvent<HTMLDivElement, MouseEvent>} event */
    const onBackgroundClick = (event) => {
        if (event.target === event.currentTarget) {
            if (onClosePopup === null) {
                ClosePopup(id);
            } else {
                onClosePopup(id);
            }
        }
    };

    return (
        <div className={`${styles.popup} ${opened ? styles.opened : ''}`} onClick={onBackgroundClick}>
            <div className={`${styles.card} bg-blue-dark ${style}`} style={styleCard} data-title={title}>
                {children}
            </div>
        </div>
    );
}

export { OpenPopup, ClosePopup };
export default Popup;
