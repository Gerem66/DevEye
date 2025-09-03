import { Unlock } from '@/Features/Utils/unlock';

import type { IFeature } from '@/Interfaces/IFeature';

export const CheckPassword: IFeature<'check-password'> = async ({ db, profile, data }) => {
    const { password, contextID } = data;

    const unlockStatus = await Unlock(db, profile, contextID, password);
    if (unlockStatus === 'error') {
        return {
            status: 1,
            message: 'Une erreur est survenue'
        };
    }
    if (unlockStatus !== 'unlocked') {
        return {
            status: 2,
            message: 'Mot de passe incorrect'
        };
    }

    return {
        status: 0,
        message: null
    };
};
