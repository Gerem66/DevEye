import type {
    BackupCodeRow,
    DeviceRow,
    ItemRoleGrantRow,
    ItemShareRow,
    MetricRow,
    NotificationChannelRow,
    NotificationRouteRow,
    PresenceRow,
    RemoteInstanceRow,
    TwoFactorRow,
    UserRow,
    UserSecretKeyRow,
    WorkspaceMemberRow,
    WorkspaceRoleRow,
    WorkspaceRow
} from '@deveye/types';

import type { FeatureDomainRow } from './repos/featureDomains';
import type { FeatureKvRow } from './repos/featureKv';
import type { FeedbackJoinRow } from './repos/feedback';
import type { LogJoinRow } from './repos/logs';
import type { PendingSignupRow } from './repos/pendingSignups';
import type { ProcessSampleRow } from './repos/processSamples';
import type { RefreshTokenRow } from './repos/refreshTokens';
import type { WorkspaceSecretKeyRow } from './repos/workspaceSecretKeys';
import type { Tables } from './schema.generated';

/**
 * Les types de lignes des dépôts, confrontés au schéma réel. `Queryable.query<T>`
 * croit `T` sur parole : sans ceci, une colonne renommée dans une migration ne
 * casse qu'à l'exécution. Rien ici ne s'exécute, `tsc` fait tout.
 *
 * Une ligne de jointure se confronte à l'intersection des tables qu'elle lit,
 * les alias calculés par la requête déclarés à part.
 */

/**
 * La colonne `Col` tient-elle dans ce que la ligne en croit, `Field` ?
 * Exactement (un ENUM, une nullabilité), ou par son genre quand le code
 * resserre une colonne libre : un `varchar` lu comme une union de littéraux,
 * un `tinyint` lu comme `0 | 1`. Une colonne JSON, que le pilote rend décodée
 * ou non, passe sur son seul nom. Distribue sur l'union de `Col`, ce qui fait
 * qu'un `null` de la base doit avoir sa place dans `Field`.
 */
type Fits<Col, Field> = unknown extends Col
    ? true
    : Col extends Field
      ? true
      : string extends Col
        ? NonNullable<Field> extends string
            ? true
            : false
        : number extends Col
          ? NonNullable<Field> extends number
              ? true
              : false
          : false;

/**
 * Les colonnes de `Row` absentes de `Table`, ou d'un type que la base ne rend
 * pas : `never` quand tout concorde.
 */
type Mismatches<Row, Table> = {
    [K in keyof Row]-?: K extends keyof Table ? ([Fits<Table[K], Row[K]>] extends [true] ? never : K) : K;
}[keyof Row];

/** `true` quand `Row` tient dans `Table`, sinon le nom des colonnes fautives. */
type RowOf<Row, Table> = [Mismatches<Row, Table>] extends [never] ? true : Mismatches<Row, Table>;

type Expect<T extends true> = T;

export type SchemaChecks = [
    Expect<RowOf<UserRow, Tables['users']>>,
    Expect<RowOf<WorkspaceRow, Tables['workspaces']>>,
    Expect<RowOf<WorkspaceMemberRow, Tables['workspace_members']>>,
    Expect<RowOf<WorkspaceRoleRow, Tables['workspace_roles']>>,
    Expect<RowOf<WorkspaceSecretKeyRow, Tables['workspace_secret_keys']>>,
    Expect<RowOf<UserSecretKeyRow, Tables['user_secret_keys']>>,
    Expect<RowOf<TwoFactorRow, Tables['user_2fa']>>,
    Expect<RowOf<BackupCodeRow, Tables['user_2fa_backup_codes']>>,
    Expect<RowOf<RefreshTokenRow, Tables['refresh_tokens']>>,
    Expect<RowOf<RemoteInstanceRow, Tables['remote_instances']>>,
    Expect<RowOf<PendingSignupRow, Tables['pending_signups']>>,
    Expect<RowOf<DeviceRow, Tables['devices']>>,
    Expect<RowOf<MetricRow, Tables['device_metrics']>>,
    Expect<RowOf<ProcessSampleRow, Tables['device_process_samples']>>,
    Expect<RowOf<PresenceRow, Tables['device_presence']>>,
    Expect<RowOf<FeatureKvRow, Tables['feature_kv']>>,
    Expect<RowOf<FeatureDomainRow, Tables['feature_domains']>>,
    Expect<RowOf<ItemShareRow, Tables['item_shares']>>,
    Expect<RowOf<ItemRoleGrantRow, Tables['item_role_grants']>>,
    Expect<RowOf<NotificationChannelRow, Tables['notification_channels']>>,
    Expect<RowOf<NotificationRouteRow, Tables['notification_routes']>>,
    Expect<RowOf<LogJoinRow, Tables['logs'] & Pick<Tables['users'], 'username'>>>,
    Expect<
        RowOf<
            FeedbackJoinRow,
            Tables['feedback'] &
                Pick<Tables['users'], 'username'> & {
                    /** `h.username`, par une jointure externe sur le compte qui a traité. */
                    handled_by_name: Tables['users']['username'] | null;
                }
        >
    >
];
