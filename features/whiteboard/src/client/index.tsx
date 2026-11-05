import type { FeatureClient } from '@deveye/types/sdk/client';

import Whiteboard from './Whiteboard';
import WhiteboardWidget from './WhiteboardWidget';

/**
 * Démontée à la fermeture : la séance se quitte, et un canevas gardé dans le
 * support caché se mesurerait à zéro au retour.
 */
export const clientEntry: FeatureClient = {
    Widget: WhiteboardWidget,
    Full: Whiteboard,
    cacheDurationMinutes: 0
};
