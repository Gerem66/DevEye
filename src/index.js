import { createRoot } from 'react-dom/client';

import App from './App.js';

const container = document.getElementById('root');
const root = createRoot(container ?? document.body);
root.render(<App />);
