import React from 'react';

import { Dialog } from '@/Components/Dialog';

import type { ReactNode } from 'react';

/**
 * Imperative dialog layer over the shared <Dialog/> UI: a feature mounts a
 * <Popup id=… /> once, other code drives it with `OpenPopup(id, input)` /
 * `ClosePopup(id, result)`; `OpenPopup` resolves with what `ClosePopup` passes.
 *
 * Une pile par identifiant, pas une case : deux montages d'un même `id`
 * coexistent (une feature gardée vivante par `FeatureKeepAlive`, et un second
 * montage à la demande). Le dernier monté répond, et son démontage rend la
 * main au précédent.
 */
interface PopupEntry {
    setInputData: (data: unknown) => void;
    setOpened: React.Dispatch<React.SetStateAction<boolean>>;
    callback?: (data: unknown) => void;
}

const PopupEvents: Record<string, PopupEntry[]> = {};

function topEntry(id: string): PopupEntry | undefined {
    const stack = PopupEvents[id];
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

function OpenPopup<T = object>(id: string, inputData: unknown = null): Promise<T | null> {
    const entry = topEntry(id);
    if (entry) {
        return new Promise((resolve) => {
            entry.setInputData(inputData);
            entry.setOpened(true);
            entry.callback = (data) => {
                resolve(data as T);
            };
        });
    }
    return Promise.resolve(null);
}

function ClosePopup(id: string, data: unknown = null) {
    const entry = topEntry(id);
    if (entry) {
        entry.setInputData(null);
        entry.setOpened(false);
        if (entry.callback) {
            entry.callback(data);
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
    /** Hold the password-encryption DEK alive while open (see Dialog's `holdSecrecy`). */
    holdSecrecy?: boolean;
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
    tall,
    holdSecrecy
}: PopupProps<TInput>): React.JSX.Element {
    const [opened, setOpened] = React.useState(false);

    React.useEffect(() => {
        const entry: PopupEntry = {
            setInputData: (data) => {
                onInputChange?.(data as TInput);
            },
            setOpened,
            callback: () => {}
        };
        (PopupEvents[id] ??= []).push(entry);

        return () => {
            const stack = PopupEvents[id];
            if (!stack) return;
            const index = stack.indexOf(entry);
            if (index !== -1) stack.splice(index, 1);
            if (stack.length === 0) delete PopupEvents[id];
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
            holdSecrecy={holdSecrecy}
        >
            {children}
        </Dialog>
    );
}

export { OpenPopup, ClosePopup };
export default Popup;
