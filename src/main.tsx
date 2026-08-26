import React from 'react';
import ReactDOM from 'react-dom/client';
import './globals';
import '@midnight-ntwrk/dapp-connector-api';
import { setNetworkId, type NetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import App from './App';

window.addEventListener('error', (e) => {
  console.error('[GLOBAL ERROR]', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason);
});

const networkId = import.meta.env.VITE_NETWORK_ID as NetworkId;
setNetworkId(networkId);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
