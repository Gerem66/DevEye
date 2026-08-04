import { createRoot } from 'react-dom/client';

import App from './App.js';
import { suppressNativeDrags } from './nativeDrag';
import { preloadIcons } from './Styles/preloadIcons';

// Before anything renders: a stray drag on a link, an image or a text selection
// can freeze the whole page, and no drag must be able to start unnoticed.
suppressNativeDrags();

const container = document.getElementById('root');
const root = createRoot(container ?? document.body);
root.render(<App />);

// Warm the icon cache up front so no icon (notably the WS-reconnect overlay's)
// ever has to be fetched at the moment it's first shown.
preloadIcons();
