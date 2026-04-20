import React from 'react';
import ReactDOM from 'react-dom/client';
// @wterm/react stylesheet is imported at point-of-use in Terminal.tsx.
// xterm.js CSS dropped with the REMEDIATION pivot.
import './index.css';
import { App } from './App';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
