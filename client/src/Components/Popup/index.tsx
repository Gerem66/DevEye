import React from 'react';

import styles from './style.module.css';

import type { HTMLAttributes } from 'react';

interface CardValueProps {
    children: React.JSX.Element | React.JSX.Element[];
    id: string;
    title?: string;
    style?: string;
}

const PopupEvents: Record<
    string,
    {
        setInputData: (data: unknown) => void;
        setOpened: React.Dispatch<React.SetStateAction<boolean>>;
        callback?: (data: unknown) => void;
    }
> = {};

function OpenPopup<T = object>(id: string, inputData: unknown = null): Promise<T | null> {
    if (PopupEvents[id]) {
        return new Promise((resolve) => {
            PopupEvents[id].setInputData(inputData);
            PopupEvents[id].setOpened(true);
            PopupEvents[id].callback = (data) => {
                resolve(data as T);
            };
        });
    }
    return Promise.resolve(null);
}

function ClosePopup(id: string, data: unknown = null) {
    if (PopupEvents[id]) {
        PopupEvents[id].setInputData(null);
        PopupEvents[id].setOpened(false);
        if (PopupEvents[id].callback) {
            PopupEvents[id].callback(data);
        }
    }
}

type PopupProps<TInput> = CardValueProps & {
    onInputChange?: ((input: TInput) => void) | null;
    onClosePopup?: ((id: string) => void) | null;
};

function Popup<TInput = unknown>({
    children,
    id,
    title = '',
    style = '',
    onInputChange = null,
    onClosePopup = null
}: PopupProps<TInput>): React.JSX.Element {
    const [opened, setOpened] = React.useState(false);

    React.useEffect(() => {
        PopupEvents[id] = {
            setInputData: (data) => {
                onInputChange?.(data as TInput);
            },
            setOpened,
            callback: () => {}
        };

        return () => {
            delete PopupEvents[id];
        };
    }, [id]);

    const styleCard: HTMLAttributes<HTMLDivElement>['style'] = {
        paddingTop: title ? '52px' : '12px'
    };

    const onBackgroundClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>) => {
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
