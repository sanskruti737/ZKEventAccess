import type { ContractAddress, SigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { PrivateStateId, PrivateStateProvider } from '@midnight-ntwrk/midnight-js-types';

/**
 * IndexedDB-backed private state provider.
 *
 * This is a persistent drop-in for the old in-memory provider, and it is the
 * ledger SDK's private-state seam: `deployContract` / `findDeployedContract` /
 * `call` read and write the contract's private state (and the organizer secret
 * key witness at `ZK_EVENT_ACCESS_PRIVATE_STATE_ID`) exclusively through this
 * `PrivateStateProvider`. Persistence lives in IndexedDB only — never
 * localStorage or sessionStorage — and is scoped per wallet account via the
 * wallet's shielded address, so two wallets on the same browser can never read
 * each other's organizer secret.
 *
 * Values are stored with the browser structured clone algorithm, so the
 * `ZKEventAccessPrivateState` object (`{ organizerSecretKey: Uint8Array }`) round-trips
 * without any lossy serialization.
 */
const DB_NAME = 'zkeventaccess.privateState';
const DB_VERSION = 1;
const PRIVATE_STATES_STORE = 'privateStates';
const SIGNING_KEYS_STORE = 'signingKeys';

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PRIVATE_STATES_STORE)) {
        db.createObjectStore(PRIVATE_STATES_STORE);
      }
      if (!db.objectStoreNames.contains(SIGNING_KEYS_STORE)) {
        db.createObjectStore(SIGNING_KEYS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('IndexedDB open blocked by another connection'));
    };
  });
  return dbPromise;
};

const withTransaction = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = run(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
  });
};

/**
 * Creates a persistent, account-scoped private state provider backed by
 * IndexedDB.
 *
 * @param accountScope Stable per-wallet identifier (the shielded address). All
 * keys are namespaced under it so different wallets are fully isolated.
 */
export const indexedDbPrivateStateProvider = <PSI extends PrivateStateId, PS = unknown>(
  accountScope: string,
): PrivateStateProvider<PSI, PS> => {
  const scope = `account:${accountScope}:`;
  const scopePrivateKey = (key: PSI): string => `${scope}private:${String(key)}`;
  const scopeAddress = (address: ContractAddress): string => `${scope}signing:${String(address)}`;

  return {
    setContractAddress(_address: ContractAddress): void {
      // This provider is purely key-value; the SDK's per-contract scoping is
      // expressed through the private state ID and contract address keys, so
      // there is no further state to bind here.
    },
    async set(key: PSI, state: PS): Promise<void> {
      await withTransaction(PRIVATE_STATES_STORE, 'readwrite', (store) =>
        store.put(state, scopePrivateKey(key)),
      );
    },
    async get(key: PSI): Promise<PS | null> {
      const value = await withTransaction(PRIVATE_STATES_STORE, 'readonly', (store) =>
        store.get(scopePrivateKey(key)),
      );
      return (value ?? null) as PS | null;
    },
    async remove(key: PSI): Promise<void> {
      await withTransaction(PRIVATE_STATES_STORE, 'readwrite', (store) =>
        store.delete(scopePrivateKey(key)),
      );
    },
    async clear(): Promise<void> {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PRIVATE_STATES_STORE, 'readwrite');
        const store = tx.objectStore(PRIVATE_STATES_STORE);
        const allKeys = store.getAllKeys();
        allKeys.onsuccess = () => {
          for (const raw of allKeys.result) {
            const k = String(raw);
            if (k.startsWith(scope)) store.delete(k);
          }
        };
        allKeys.onerror = () => reject(allKeys.error);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    },
    async setSigningKey(address: ContractAddress, signingKey: SigningKey): Promise<void> {
      await withTransaction(SIGNING_KEYS_STORE, 'readwrite', (store) =>
        store.put(signingKey, scopeAddress(address)),
      );
    },
    async getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
      const value = await withTransaction(SIGNING_KEYS_STORE, 'readonly', (store) =>
        store.get(scopeAddress(address)),
      );
      return (value ?? null) as SigningKey | null;
    },
    async removeSigningKey(address: ContractAddress): Promise<void> {
      await withTransaction(SIGNING_KEYS_STORE, 'readwrite', (store) =>
        store.delete(scopeAddress(address)),
      );
    },
    async clearSigningKeys(): Promise<void> {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(SIGNING_KEYS_STORE, 'readwrite');
        const store = tx.objectStore(SIGNING_KEYS_STORE);
        const allKeys = store.getAllKeys();
        allKeys.onsuccess = () => {
          for (const raw of allKeys.result) {
            const k = String(raw);
            if (k.startsWith(scope)) store.delete(k);
          }
        };
        allKeys.onerror = () => reject(allKeys.error);
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    },
  } as PrivateStateProvider<PSI, PS>;
};