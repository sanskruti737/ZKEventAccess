import React from 'react';
import { useMidnight } from './hooks/useMidnight';
import { Layout } from './components/Layout';
import { WalletConnect } from './components/WalletConnect';
import { CircuitCall } from './components/CircuitCall';

const App: React.FC = () => {
  const wallet = useMidnight();

  React.useEffect(() => {
    wallet.autoConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Layout network="preprod">
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