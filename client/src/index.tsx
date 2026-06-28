import { createRoot } from 'react-dom/client';

import App from './App.js';
import { preloadIcons } from './Styles/preloadIcons';

const container = document.getElementById('root');
const root = createRoot(container ?? document.body);
root.render(<App />);

// Warm the icon cache up front so no icon (notably the WS-reconnect overlay's)
// ever has to be fetched at the moment it's first shown.
preloadIcons();
