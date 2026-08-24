import type { ContractAddress, SigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { PrivateStateId, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

/**
 * Minimal in-memory private state provider for the browser session.
 *
 * The organizer secret key lives here only — it is never rendered in the UI,
 * never logged, and never leaves the user's machine.
 */
export const inMemoryPrivateStateProvider = <PSI extends PrivateStateId, PS = unknown>(): PrivateStateProvider<
  PSI,
  PS
> => {
  let contractAddress: ContractAddress | null = null;
  const privateStates = new Map<PSI, PS>();
  const signingKeys = new Map<ContractAddress, SigningKey>();

  const requireContractAddress = (): ContractAddress => {
    if (contractAddress === null) throw new Error('Private state provider: setContractAddress() not called');
    return contractAddress;
  };

  return {
    setContractAddress(address: ContractAddress): void {
      contractAddress = address;
    },
    set(key: PSI, state: PS): Promise<void> {
      privateStates.set(key, state);
      return Promise.resolve();
    },
    get(key: PSI): Promise<PS | null> {
      return Promise.resolve(privateStates.get(key) ?? null);
    },
    remove(key: PSI): Promise<void> {
      privateStates.delete(key);
      return Promise.resolve();
    },
    clear(): Promise<void> {
      privateStates.clear();
      return Promise.resolve();
    },
    setSigningKey(address: ContractAddress, signingKey: SigningKey): Promise<void> {
      signingKeys.set(address, signingKey);
      return Promise.resolve();
    },
    getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
      return Promise.resolve(signingKeys.get(address) ?? null);
    },
    removeSigningKey(address: ContractAddress): Promise<void> {
      signingKeys.delete(address);
      return Promise.resolve();
    },
    clearSigningKeys(): Promise<void> {
      signingKeys.clear();
      return Promise.resolve();
    },
  } as PrivateStateProvider<PSI, PS>;
};
