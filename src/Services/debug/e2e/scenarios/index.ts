import { accountLifecycle } from './account';
import { sharedWorkspace } from './sharing';
import { twoFactor } from './twoFactor';

/** Les scénarios du socle, dans l'ordre où ils tournent : le cycle de compte d'abord. */
export const CORE_SCENARIOS = [accountLifecycle, sharedWorkspace, twoFactor] as const;
