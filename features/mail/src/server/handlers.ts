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
    mailAccountSetRemoteImagesFeature,
    mailAccountTestConnectionFeature,
    mailAccountUpdateFeature,
    mailOAuthProvidersFeature,
    mailOAuthFinishFeature,
    mailOAuthStartFeature
} from './accounts';
import {
    mailFolderBackfillFeature,
    mailFolderCreateFeature,
    mailFolderDeleteFeature,
    mailFolderListFeature,
    mailFolderPrefetchFeature,
    mailFolderRenameFeature,
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
    mailMessageSetFlagsManyFeature,
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
    mailAccountSetRemoteImagesFeature,
    mailAccountTestConnectionFeature,
    mailOAuthProvidersFeature,
    mailOAuthStartFeature,
    mailOAuthFinishFeature(),
    mailFolderListFeature,
    mailFolderCreateFeature,
    mailFolderRenameFeature,
    mailFolderDeleteFeature,
    mailFolderReorderFeature,
    mailFolderSyncFeature,
    mailFolderPrefetchFeature,
    mailFolderBackfillFeature,
    mailFolderResetFeature,
    mailMessageListFeature,
    mailMessageSearchFeature,
    mailMessageGetFeature,
    mailMessageSetFlagsFeature,
    mailMessageSetFlagsManyFeature,
    mailMessageMoveFeature,
    mailMessageDeleteFeature,
    mailAttachmentDownloadFeature,
    mailAttachmentScanFeature,
    mailSendFeature,
    mailGetSettingsFeature,
    mailSetSettingsFeature
];
