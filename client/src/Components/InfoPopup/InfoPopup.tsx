import { type ReactNode, useState } from 'react';

import Popup, { OpenPopup } from '@/Components/Popup';

import styles from './InfoPopup.module.css';

export const INFO_POPUP = 'popup-info';

/** Default dialog width, matching the Security info modals. */
const DEFAULT_WIDTH = 500;

/** Payload for {@link openInfo}: a heading and the explanatory body. */
export interface InfoPopupInput {
    title: string;
    body: ReactNode;
    /** Dialog width in px (defaults to {@link DEFAULT_WIDTH}). */
    width?: number;
}

/**
 * Open the shared info dialog (see {@link InfoPopup}). Use for every "i" /
 * "comment ça marche ?" explainer so the behavior is consistent app-wide.
 */
export function openInfo(input: InfoPopupInput): Promise<unknown> {
    return OpenPopup(INFO_POPUP, input);
}

/**
 * The single info dialog, mounted once near the app root, outside any feature
 * popup: its own backdrop closes it, never a popup underneath.
 */
export default function InfoPopup() {
    const [data, setData] = useState<InfoPopupInput>({ title: '', body: null });

    return (
        <Popup<InfoPopupInput>
            id={INFO_POPUP}
            title={data.title}
            width={data.width ?? DEFAULT_WIDTH}
            onInputChange={(input) => input && setData(input)}
        >
            <div className={styles.infoContent}>{data.body}</div>
        </Popup>
    );
}
