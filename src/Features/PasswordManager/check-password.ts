import { Unlock } from '@/Features/Utils/unlock';

import type { IFeature } from '@/Interfaces/IFeature';

export const CheckPassword: IFeature<'check-password'> = async ({ db, profile, data }) => {
    const { password, contextID } = data;

    const unlockStatus = await Unlock(db, profile, contextID, password);

    switch (unlockStatus) {
        case 'unlocked':
            return {
                status: 'unlocked'
            };
        case 'wrong-user':
        case 'wrong-password':
            return {
                status: 'wrong-user-or-password',
                message: 'Incorrect information'
            };
        case 'error':
        default:
            return {
                status: 'error',
                message: 'An error occurred'
            };
    }
};
