import { CounterAPI, type CounterLedgerState } from '../midnight/counter-api';
import type { ProvidersBundle } from '../midnight/providers';
import { NETWORK_ID } from '../midnight/providers';

export const CONTRACT_ADDRESS: string = import.meta.env.VITE_CONTRACT_ADDRESS as string;

export type { CounterLedgerState } from '../midnight/counter-api';

/** Joins the deployed ZKEventAccess contract using an active wallet bundle. */
export const joinContract = (bundle: ProvidersBundle): Promise<CounterAPI> =>
  CounterAPI.join(bundle.providers, CONTRACT_ADDRESS);

/** Maps a circuit mutation name to its on-chain effect for status messages. */
export const describeEffect = (name: 'increment' | 'read'): string =>
  name === 'increment'
    ? 'Issued one access credential'
    : 'Verified current credential count';

export { NETWORK_ID };