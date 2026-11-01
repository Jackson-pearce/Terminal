import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionProvider } from './auth/SessionProvider';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);
