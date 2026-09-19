import { createRoot } from 'react-dom/client';

import '@fontsource-variable/dm-sans';
import '@fontsource-variable/schibsted-grotesk';
import '@fontsource/dm-mono/300.css';
import '@fontsource/dm-mono/400.css';
import '@fontsource/dm-mono/500.css';

import { App } from './app/app';
import { CriticalErrorBoundary } from './app/critical-error-boundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <CriticalErrorBoundary>
    <App />
  </CriticalErrorBoundary>,
);
