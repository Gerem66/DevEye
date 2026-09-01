// En tout premier : l'enregistrement des modules installés, avant App donc avant
// le catalogue, qui se fige en s'évaluant.
import '@/sdk/modules';

import { createRoot } from 'react-dom/client';

import App from './App.js';
import { suppressNativeDrags } from './nativeDrag';

// Before anything renders: a stray drag on a link, an image or a text selection
// can freeze the whole page.
suppressNativeDrags();

const container = document.getElementById('root');
const root = createRoot(container ?? document.body);
root.render(<App />);
