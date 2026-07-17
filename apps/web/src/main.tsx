import '@fontsource-variable/spline-sans/wght.css';
import '@fontsource-variable/spline-sans-mono/wght.css';
import { createRoot } from 'react-dom/client';

import { App } from './app/app';
import { discoverRuntimeConnection } from './lib/api/runtime-connection';
import './styles.css';

async function mountApp() {
  const connection = await discoverRuntimeConnection();
  createRoot(document.getElementById('root')!).render(
    <App connection={connection} />,
  );
}

void mountApp();
