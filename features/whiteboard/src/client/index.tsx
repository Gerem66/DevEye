import { WHITEBOARD_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import BoardGeneralPanel from './BoardGeneralPanel';
import { clientProvider } from './provider';
import Whiteboard from './Whiteboard';
import WhiteboardWidget from './WhiteboardWidget';

/**
 * Démontée à la fermeture : la séance se quitte, et un canevas gardé dans le
 * support caché se mesurerait à zéro au retour.
 */
export const clientEntry: FeatureClient = {
    Widget: WhiteboardWidget,
    Full: Whiteboard,
    cacheDurationMinutes: 0,
    settingsPanels: { general: BoardGeneralPanel },
    providers: { [WHITEBOARD_CLIENT_PROVIDER]: clientProvider }
};
