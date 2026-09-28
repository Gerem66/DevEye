const ADMIN_VIEW_PREFIX = 'admin:';

/** L'identifiant de vue de la page système d'un module (`manifest.adminEntry`). */
export const adminViewId = (featureId: string): string => `${ADMIN_VIEW_PREFIX}${featureId}`;

/** Le module derrière une page système, ou `null` pour une autre vue. */
export const adminViewFeature = (viewId: string): string | null =>
    viewId.startsWith(ADMIN_VIEW_PREFIX) ? viewId.slice(ADMIN_VIEW_PREFIX.length) : null;
