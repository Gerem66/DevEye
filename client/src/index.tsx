// En tout premier : l'enregistrement des modules installés, avant App donc avant
// le catalogue, qui se fige en s'évaluant.
import '@/sdk/modules';

import { createRoot } from 'react-dom/client';

import App from './App.js';
import ErrorBoundary from './Components/ErrorBoundary';
import { installErrorTrace } from './diagnostics/trace';
import { suppressNativeDrags } from './nativeDrag';

// Before anything renders: a stray drag on a link, an image or a text selection
// can freeze the whole page.
suppressNativeDrags();

// Avant le premier rendu aussi : une erreur qui survient au montage doit se
// retrouver dans un signalement, pas seulement dans la console de celui qui
// pense à l'ouvrir.
installErrorTrace();

const container = document.getElementById('root');
const root = createRoot(container ?? document.body);
root.render(
    <ErrorBoundary variant='page'>
        <App />
    </ErrorBoundary>
);
