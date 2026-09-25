import React from 'react';
import { useMidnight } from './hooks/useMidnight';
import { Layout } from './components/Layout';
import { WalletConnect } from './components/WalletConnect';
import { CircuitCall } from './components/CircuitCall';

const networkId = import.meta.env.VITE_NETWORK_ID || 'preprod';

const App: React.FC = () => {
  const wallet = useMidnight();

  React.useEffect(() => {
    wallet.autoConnect();
  }, [wallet.autoConnect]);

  return (
    <Layout network={networkId}>
      <WalletConnect
        status={wallet.status}
        address={wallet.address}
        walletName={wallet.walletName}
        error={wallet.error}
        onConnect={() => void wallet.connect()}
        onDisconnect={wallet.disconnect}
      />

      <CircuitCall connected={wallet.status === 'connected'} getBundle={wallet.getBundle} />
    </Layout>
  );
};

export default App;
