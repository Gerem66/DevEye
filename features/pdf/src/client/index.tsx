import type { FeatureClient } from '@deveye/types/sdk/client';

import Pdf from './Pdf';
import { PdfWidget } from './PdfWidget';

export const clientEntry: FeatureClient = {
    Widget: PdfWidget,
    Full: Pdf,
    // Un document en cours vit en mémoire : une vue démontée tard garderait pdf.js et ses octets.
    cacheDurationMinutes: 0
};
