import type { ZodType } from 'zod';

import type { SdkFeatureDefinition } from '@deveye/types/sdk/server';

import {
    mailAccountAddFeature,
    mailAccountCountFeature,
    mailAccountDeleteFeature,
    mailAccountListFeature,
    mailAccountReorderFeature,
    mailAccountSetEnabledFeature,
    mailAccountSetProfileFeature,
    mailAccountTestConnectionFeature,
    mailAccountUpdateFeature,
    mailOAuthStartFeature
} from './accounts';
import {
    mailFolderBackfillFeature,
    mailFolderListFeature,
    mailFolderReorderFeature,
    mailFolderResetFeature,
    mailFolderSyncFeature
} from './folders';
import {
    mailAttachmentDownloadFeature,
    mailAttachmentScanFeature,
    mailMessageDeleteFeature,
    mailMessageGetFeature,
    mailMessageListFeature,
    mailMessageMoveFeature,
    mailMessageSearchFeature,
    mailMessageSetFlagsFeature,
    mailSendFeature
} from './messages';
import type { MailRepo } from './repo';
import { mailGetSettingsFeature, mailSetSettingsFeature } from './settings';

/**
 * Les commandes du module, dans le même ordre que `mailCommands` du contrat,
 * pour que les deux listes se comparent.
 */
export const mailHandlers: readonly SdkFeatureDefinition<MailRepo, string, ZodType, ZodType>[] = [
    mailAccountListFeature,
    mailAccountCountFeature,
    mailAccountAddFeature,
    mailAccountUpdateFeature,
    mailAccountSetProfileFeature,
    mailAccountDeleteFeature,
    mailAccountReorderFeature,
    mailAccountSetEnabledFeature,
    mailAccountTestConnectionFeature,
    mailOAuthStartFeature,
    mailFolderListFeature,
    mailFolderReorderFeature,
    mailFolderSyncFeature,
    mailFolderBackfillFeature,
    mailFolderResetFeature,
    mailMessageListFeature,
    mailMessageSearchFeature,
    mailMessageGetFeature,
    mailMessageSetFlagsFeature,
    mailMessageMoveFeature,
    mailMessageDeleteFeature,
    mailAttachmentDownloadFeature,
    mailAttachmentScanFeature,
    mailSendFeature,
    mailGetSettingsFeature,
    mailSetSettingsFeature
];
