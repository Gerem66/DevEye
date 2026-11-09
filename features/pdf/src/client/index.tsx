import type { FeatureClient } from '@deveye/types/sdk/client';

import Pdf from './Pdf';
import { PdfWidget } from './PdfWidget';

/** La vue reste montée une fois fermée : l'atelier se rouvre sur son document, rien n'est perdu par mégarde. */
export const clientEntry: FeatureClient = {
    Widget: PdfWidget,
    Full: Pdf
};
