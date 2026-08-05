import '@fontsource-variable/spline-sans/wght.css';
import '@fontsource-variable/spline-sans-mono/wght.css';
import { createRoot } from 'react-dom/client';

import { App } from './app/app';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
