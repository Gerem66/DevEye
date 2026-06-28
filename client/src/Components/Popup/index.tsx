import React from 'react';

import { Dialog } from '@/Components/Dialog';

import type { ReactNode } from 'react';

/**
 * Imperative dialog layer over the shared <Dialog/> UI.
 *
 * A feature mounts a <Popup id=… /> wrapping its form once; other code then
 * drives it with `OpenPopup(id, input)` / `ClosePopup(id, result)`. `OpenPopup`
 * returns a promise that resolves with whatever `ClosePopup` passes, which keeps
 * request/response flows (unlock, add/edit password…) linear and readable.
 */
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

interface PopupProps<TInput> {
    children: ReactNode;
    id: string;
    title?: string;
    width?: number;
    /** Optional top-right action (e.g. an "i" button); placed left of the ×. */
    headerAction?: ReactNode;
    /** Receives the `inputData` passed to OpenPopup whenever the popup opens. */
    onInputChange?: ((input: TInput) => void) | null;
    /** Overrides the default close (which resolves OpenPopup with null). */
    onClosePopup?: ((id: string) => void) | null;
    /** Primary action — pressing Enter triggers it (see Dialog's `onSubmit`). */
    onSubmit?: () => void;
    /** Autofocus the first field on open (see Dialog's `autoFocus`). Defaults true. */
    autoFocus?: boolean;
    /** Unsaved changes present — guard the close (see Dialog's `dirty`). Needs `onSave`. */
    dirty?: boolean;
    /** Save action used by the unsaved-changes prompt (see Dialog's `onSave`). */
    onSave?: () => void;
    /** Fixed viewport-tall layout with a scrollable body (see Dialog's `tall`). */
    tall?: boolean;
}

function Popup<TInput = unknown>({
    children,
    id,
    title = '',
    width,
    headerAction,
    onInputChange = null,
    onClosePopup = null,
    onSubmit,
    autoFocus,
    dirty,
    onSave,
    tall
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

    const handleClose = () => {
        if (onClosePopup === null) ClosePopup(id);
        else onClosePopup(id);
    };

    return (
        <Dialog
            open={opened}
            onClose={handleClose}
            title={title}
            width={width}
            headerAction={headerAction}
            onSubmit={onSubmit}
            autoFocus={autoFocus}
            dirty={dirty}
            onSave={onSave}
            tall={tall}
        >
            {children}
        </Dialog>
    );
}

export { OpenPopup, ClosePopup };
export default Popup;
