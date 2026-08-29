import { z } from 'zod';

/**
 * Sentinelle interprète ce que Monitoring collecte : aucune sonde nouvelle,
 * hors les relevés de persistance et d'authentification. Aucun suivi de
 * l'activité des utilisateurs : des issues et des empreintes, jamais une
 * session ni un contenu. Trois notions : la ligne de base (observé), le
 * constat (jugé), l'autorisation (décidé par un humain, rangée à part pour
 * survivre à une reconstruction de la ligne de base).
 */

/** Quatre paliers, pas cinq : au-delà l'échelle cesse de trier. Seuil de notification : `SENTINEL_NOTIFY_FROM`. */
export const findingSeveritySchema = z.enum(['info', 'low', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

/**
 * La colonne SQL porte ce rang : `'critical' < 'low'` en ordre lexical, un
 * `ORDER BY` sur le nom trierait à l'envers.
 */
export const SEVERITY_RANK: Record<FindingSeverity, number> = {
    info: 1,
    low: 2,
    high: 3,
    critical: 4
};

export const SEVERITY_BY_RANK: Record<number, FindingSeverity> = {
    1: 'info',
    2: 'low',
    3: 'high',
    4: 'critical'
};

/** À partir de quelle gravité un constat part sur les canaux de l'espace. */
export const SENTINEL_NOTIFY_FROM: FindingSeverity = 'high';

/**
 * `open` : personne ne l'a regardé. `acknowledged` : jugé légitime, une
 * autorisation est écrite et la situation ne rouvrira plus. `resolved` : la
 * situation a cessé. Pas d'état « ignoré sans décision ».
 */
export const findingStateSchema = z.enum(['open', 'acknowledged', 'resolved']);
export type FindingState = z.infer<typeof findingStateSchema>;

/**
 * Les règles, figées. Ajouter une règle est un geste délibéré : son identifiant
 * entre ici, sa métadonnée dans `SENTINEL_RULES`, et le moteur refuse de
 * démarrer si les deux ne coïncident pas.
 */
export const sentinelRuleIdSchema = z.enum([
    // Dérive de la ligne de base, n'existent qu'après la fenêtre d'apprentissage.
    'process.new',
    'process.user_changed',
    'process.new_listener',
    'process.resource_anomaly',
    'process.vanished',
    'port.exposed',
    'port.unattributed',
    // Heuristiques d'instant, indépendantes de la ligne de base, actives tout de suite.
    'net.mining_pool',
    'net.shell_outbound',
    'net.connection_spike',
    'exec.suspicious_path',
    'exec.deleted_binary',
    'exec.masquerade',
    // Diff du manifeste de persistance.
    'persistence.added',
    'persistence.modified',
    'persistence.removed',
    // Issues d'authentification.
    'auth.bruteforce',
    'auth.success_after_failures',
    'auth.new_account',
    'auth.root_login',
    // Posture : un défaut de configuration est un constat comme un autre, ce qui
    // lui donne le même cycle de vie et le même chemin de notification.
    'posture.firewall_off',
    'posture.disk_unencrypted',
    'posture.sip_off',
    'posture.updates_stale',
    'posture.ssh_root_login',
    'posture.ssh_password_auth',
    'posture.no_mac',
    'posture.reboot_pending'
]);
export type SentinelRuleId = z.infer<typeof sentinelRuleIdSchema>;

/**
 * La sonde dont une règle dépend : sur un agent qui ne la renvoie pas,
 * l'interface dit « pas encore mesuré » plutôt qu'un vert.
 */
export const ruleProbeSchema = z.enum([
    /** Présent depuis toujours : instant métrique + liste de processus. */
    'snapshot',
    /** Présent depuis toujours : rapport horaire. */
    'report',
    /** Chemin d'exécutable et drapeau « binaire supprimé ». */
    'execPath',
    /** Sondes de posture étendues (sshd, MAC, reboot, MAJ de sécurité). */
    'posture',
    /** Manifeste des surfaces de persistance. */
    'integrity',
    /** Fenêtre d'issues d'authentification. */
    'auth'
]);
export type RuleProbe = z.infer<typeof ruleProbeSchema>;

export interface SentinelRuleMeta {
    /** Gravité par défaut. Le moteur peut la relever, jamais l'inventer. */
    severity: FindingSeverity;
    label: string;
    description: string;
    /** Vide n'est pas une option : un constat sans conduite à tenir ne sert personne. */
    remediation: string;
    probe: RuleProbe;
    /** Muette pendant l'apprentissage. */
    needsBaseline: boolean;
}

export const SENTINEL_RULES: Record<SentinelRuleId, SentinelRuleMeta> = {
    'process.new': {
        severity: 'low',
        label: 'Nouveau programme',
        description: "Un programme qui n'avait jamais été observé sur cette machine s'y exécute.",
        remediation:
            "Vérifiez son chemin et son compte. S'il vient d'une installation que vous avez faite, marquez-le légitime.",
        probe: 'snapshot',
        needsBaseline: true
    },
    'process.user_changed': {
        severity: 'high',
        label: 'Changement de compte',
        description: "Un programme connu s'exécute désormais sous un autre compte système.",
        remediation:
            "Un passage vers root est la forme d'une élévation de privilèges. Vérifiez qui a modifié le service.",
        probe: 'snapshot',
        needsBaseline: true
    },
    'process.new_listener': {
        severity: 'high',
        label: 'Nouvelle écoute réseau',
        description: "Un programme qui n'écoutait pas le réseau s'est mis à ouvrir un port.",
        remediation: 'Vérifiez le port et son adresse de bind. Fermez-le, ou marquez-le légitime.',
        probe: 'snapshot',
        needsBaseline: true
    },
    'process.resource_anomaly': {
        severity: 'low',
        label: 'Consommation anormale',
        description: 'Un programme consomme durablement bien au-delà de son habitude.',
        remediation:
            "C'est la forme d'un mineur détourné, mais aussi celle d'une fuite mémoire. Regardez l'instant épinglé.",
        probe: 'snapshot',
        needsBaseline: true
    },
    'process.vanished': {
        severity: 'low',
        label: 'Programme disparu',
        description: 'Un programme présent en continu depuis des jours a cessé de tourner.',
        remediation: "Si c'est un service, vérifiez qu'il n'a pas été arrêté par quelqu'un d'autre que vous.",
        probe: 'snapshot',
        needsBaseline: true
    },
    'port.exposed': {
        severity: 'high',
        label: 'Port exposé au monde',
        description: 'Un port vient de se lier à toutes les interfaces, et non à la seule boucle locale.',
        remediation: 'Restreignez le bind à 127.0.0.1 si le service est local, ou couvrez-le par le pare-feu.',
        probe: 'snapshot',
        needsBaseline: true
    },
    'port.unattributed': {
        severity: 'high',
        label: 'Écoute sans propriétaire',
        description: "Un port est en écoute sans qu'aucun processus n'ait pu lui être rattaché.",
        remediation:
            "L'agent est privilégié, il aurait donc dû trouver le propriétaire. Une écoute anonyme mérite un examen à la main.",
        probe: 'snapshot',
        needsBaseline: false
    },
    'net.mining_pool': {
        severity: 'high',
        label: 'Connexion vers un pool de minage',
        description: 'Une connexion établie vise un port typique des pools de minage.',
        remediation: "Identifiez le programme à l'origine de la connexion sur l'instant épinglé.",
        probe: 'snapshot',
        needsBaseline: false
    },
    'net.shell_outbound': {
        severity: 'critical',
        label: 'Interpréteur avec connexion sortante',
        description: 'Un shell ou un interpréteur maintient une connexion sortante établie.',
        remediation:
            "C'est la forme d'un shell inversé. Sauf script d'administration connu, coupez la connexion et examinez la machine.",
        probe: 'snapshot',
        needsBaseline: false
    },
    'net.connection_spike': {
        severity: 'low',
        label: 'Explosion des connexions',
        description: 'Le nombre de connexions établies dépasse très largement son habitude.',
        remediation: "Forme d'un balayage sortant ou d'une machine enrôlée. Regardez quel programme les porte.",
        probe: 'snapshot',
        needsBaseline: true
    },
    'exec.suspicious_path': {
        severity: 'critical',
        label: 'Exécution depuis un répertoire temporaire',
        description: "Un programme s'exécute depuis un répertoire où rien ne devrait être exécuté.",
        remediation:
            "/tmp, /dev/shm et /var/tmp sont les points de chute classiques d'un dropper. Récupérez le binaire avant de tuer le processus.",
        probe: 'execPath',
        needsBaseline: false
    },
    'exec.deleted_binary': {
        severity: 'critical',
        label: 'Binaire disparu du disque',
        description: "Un programme tourne alors que plus rien n'existe à l'emplacement de son exécutable.",
        remediation:
            "Un des indicateurs les plus francs d'un implant résident. Copiez /proc/<pid>/exe avant tout redémarrage. À ne pas confondre avec un binaire simplement remplacé par une mise à jour, que l'agent ne signale pas.",
        probe: 'execPath',
        needsBaseline: false
    },
    'exec.masquerade': {
        severity: 'critical',
        label: 'Nom usurpé',
        description: "Un programme porte un nom de tâche noyau alors qu'il a un vrai exécutable sur disque.",
        remediation: 'Un fil du noyau ne vient jamais du disque. Examinez le chemin.',
        probe: 'execPath',
        needsBaseline: false
    },
    'persistence.added': {
        severity: 'high',
        label: 'Nouvelle entrée de persistance',
        description: "Une entrée est apparue là où un programme s'installe pour survivre au redémarrage.",
        remediation: 'Lisez le fichier et vérifiez son origine. Marquez-le légitime si vous venez de le créer.',
        probe: 'integrity',
        needsBaseline: true
    },
    'persistence.modified': {
        severity: 'high',
        label: 'Entrée de persistance modifiée',
        description: "L'empreinte d'une entrée de persistance connue a changé.",
        remediation:
            "Comparez avec votre gestion de configuration. Un changement que vous n'avez pas fait est un signal.",
        probe: 'integrity',
        needsBaseline: true
    },
    'persistence.removed': {
        severity: 'low',
        label: 'Entrée de persistance supprimée',
        description: 'Une entrée de persistance connue a disparu.',
        remediation: "Souvent une désinstallation. Signalé parce qu'un effacement peut aussi couvrir des traces.",
        probe: 'integrity',
        needsBaseline: true
    },
    'auth.bruteforce': {
        severity: 'high',
        label: 'Tentatives répétées',
        description: "Une même adresse a échoué de nombreuses fois à s'authentifier.",
        remediation: "Bloquez l'adresse, et désactivez l'authentification par mot de passe si elle est encore ouverte.",
        probe: 'auth',
        needsBaseline: false
    },
    'auth.success_after_failures': {
        severity: 'critical',
        label: 'Réussite après échecs',
        description: "Une authentification a réussi depuis une adresse qui venait d'échouer plusieurs fois.",
        remediation: "Traitez la machine comme compromise jusqu'à preuve du contraire. Changez le secret concerné.",
        probe: 'auth',
        needsBaseline: false
    },
    'auth.new_account': {
        severity: 'critical',
        label: 'Compte créé',
        description: 'Un compte système a été créé.',
        remediation: "Une création de compte que vous n'avez pas faite est une prise de pied durable.",
        probe: 'auth',
        needsBaseline: false
    },
    'auth.root_login': {
        severity: 'high',
        label: 'Connexion root directe',
        description: 'Une session root a été ouverte directement, sans passer par un compte nominatif.',
        remediation: 'Interdisez la connexion root directe et passez par sudo, qui laisse une trace nominative.',
        probe: 'auth',
        needsBaseline: false
    },
    'posture.firewall_off': {
        severity: 'high',
        label: 'Pare-feu désactivé',
        description: "Le pare-feu de l'hôte est éteint.",
        remediation: 'Activez ufw, firewalld ou le pare-feu applicatif selon la plateforme.',
        probe: 'report',
        needsBaseline: false
    },
    'posture.disk_unencrypted': {
        severity: 'high',
        label: 'Disque non chiffré',
        description: "Le volume système n'est pas chiffré.",
        remediation: "Sur un poste mobile, c'est le seul rempart en cas de perte. LUKS ou FileVault.",
        probe: 'report',
        needsBaseline: false
    },
    'posture.sip_off': {
        severity: 'high',
        label: 'SIP désactivé',
        description: "La protection de l'intégrité du système est désactivée.",
        remediation: 'Réactivez SIP depuis la recovery, sauf besoin de développement explicite.',
        probe: 'report',
        needsBaseline: false
    },
    'posture.updates_stale': {
        severity: 'high',
        label: 'Mises à jour de sécurité en attente',
        description: 'Des correctifs de sécurité attendent depuis trop longtemps.',
        remediation:
            'Appliquez-les. Un correctif publié est aussi une carte offerte à qui sait lire un journal de version.',
        probe: 'posture',
        needsBaseline: false
    },
    'posture.ssh_root_login': {
        severity: 'high',
        label: 'SSH autorise root',
        description: 'Le serveur SSH accepte les connexions directes du compte root.',
        remediation: 'Passez PermitRootLogin à no, puis rechargez sshd.',
        probe: 'posture',
        needsBaseline: false
    },
    'posture.ssh_password_auth': {
        severity: 'high',
        label: 'SSH autorise les mots de passe',
        description: "Le serveur SSH accepte l'authentification par mot de passe.",
        remediation: 'Passez aux clés et mettez PasswordAuthentication à no. Un mot de passe se devine, pas une clé.',
        probe: 'posture',
        needsBaseline: false
    },
    'posture.no_mac': {
        severity: 'low',
        label: 'Aucun contrôle d’accès obligatoire',
        description: "Ni SELinux ni AppArmor n'est actif.",
        remediation:
            "Activez-en un si la distribution en fournit un : c'est ce qui limite les dégâts d'un service compromis.",
        probe: 'posture',
        needsBaseline: false
    },
    'posture.reboot_pending': {
        severity: 'low',
        label: 'Redémarrage requis',
        description: 'Un redémarrage est requis pour que des correctifs déjà installés prennent effet.',
        remediation: "Un noyau corrigé mais non redémarré n'est pas un noyau corrigé. Planifiez le redémarrage.",
        probe: 'posture',
        needsBaseline: false
    }
};

/** Les règles muettes tant que la ligne de base n'est pas constituée. */
export const BASELINE_RULES: SentinelRuleId[] = (Object.keys(SENTINEL_RULES) as SentinelRuleId[]).filter(
    (id) => SENTINEL_RULES[id].needsBaseline
);

/**
 * `process` : (nom, chemin). `listener` : port en écoute. `persistence` :
 * fichier d'une surface, avec empreinte. `account` : compte vu se connecter.
 */
export const baselineKindSchema = z.enum(['process', 'listener', 'persistence', 'account']);
export type BaselineKind = z.infer<typeof baselineKindSchema>;

/** Tous les champs facultatifs : un seul schéma pour quatre natures, le stockage est une colonne JSON unique. */
export const baselineAttrsSchema = z.object({
    /** Comptes système sous lesquels l'élément a été vu (dédupliqués, bornés). */
    users: z.array(z.string().max(64)).max(16).default([]),
    /** Ports que ce programme a été vu ouvrir. */
    listenPorts: z.array(z.number().int().min(0).max(65535)).max(64).default([]),
    /** Enveloppe de consommation : p95 observé, base de `process.resource_anomaly`. */
    cpuP95: z.number().nullable().default(null),
    memP95: z.number().int().nonnegative().nullable().default(null),
    /** Empreinte du fichier, pour les entrées `persistence`. */
    sha256: z.string().max(64).nullable().default(null),
    /** Surface de persistance d'origine (`cron`, `systemd`, `authorized_keys`…). */
    surface: z.string().max(48).nullable().default(null)
});
export type BaselineAttrs = z.infer<typeof baselineAttrsSchema>;

export const baselineEntrySchema = z.object({
    kind: baselineKindSchema,
    /** Clé stable de l'élément : `nginx|/usr/sbin/nginx`, `tcp/0.0.0.0:22`, `/etc/cron.d/x`. */
    key: z.string().max(512),
    /** Unix ms. */
    firstSeen: z.number().int().positive(),
    lastSeen: z.number().int().positive(),
    /** Nombre d'instants où l'élément a été vu. */
    samples: z.number().int().nonnegative(),
    attrs: baselineAttrsSchema,
    /** Vrai si une autorisation humaine couvre cet élément. */
    allowed: z.boolean().default(false)
});
export type BaselineEntry = z.infer<typeof baselineEntrySchema>;

/**
 * Des paires libellé/valeur mises en forme par le serveur : aucun rendu par
 * règle côté interface. Non requêtable ; `subject` porte la clé machine.
 */
export const evidenceItemSchema = z.object({
    label: z.string().max(64),
    value: z.string().max(512)
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const findingSchema = z.object({
    id: z.number().int().positive(),
    deviceId: z.string().max(36),
    /** Nom de l'appareil au moment de la lecture, pour éviter une jointure côté client. */
    deviceName: z.string().max(128),
    rule: sentinelRuleIdSchema,
    severity: findingSeveritySchema,
    state: findingStateSchema,
    /** Ce sur quoi porte le constat : un programme, un port, un chemin, une adresse. */
    subject: z.string().max(512),
    evidence: z.array(evidenceItemSchema).max(24),
    /**
     * L'instant épinglé qui porte la preuve, en unix ms. `null` pour les constats
     * qui ne naissent pas d'un instant (posture, persistance, authentification).
     */
    snapshotTs: z.number().int().positive().nullable(),
    firstSeen: z.number().int().positive(),
    lastSeen: z.number().int().positive(),
    occurrences: z.number().int().positive(),
    ackedBy: z.number().int().positive().nullable(),
    ackedAt: z.number().int().positive().nullable()
});
export type Finding = z.infer<typeof findingSchema>;

/** Portée d'un acquittement : cette machine, ou toute la flotte de l'espace. */
export const allowScopeSchema = z.enum(['device', 'fleet']);
export type AllowScope = z.infer<typeof allowScopeSchema>;

export const allowEntrySchema = z.object({
    id: z.number().int().positive(),
    /** `null` = toute la flotte de l'espace. */
    deviceId: z.string().max(36).nullable(),
    deviceName: z.string().max(128).nullable(),
    rule: sentinelRuleIdSchema,
    subject: z.string().max(512),
    reason: z.string().max(255).nullable(),
    createdBy: z.number().int().positive(),
    created: z.number().int().positive()
});
export type AllowEntry = z.infer<typeof allowEntrySchema>;

/**
 * `unknown` veut dire « la sonde n'a rien pu dire », jamais « tout va bien » :
 * un vert sur une sonde absente est une fausse assurance.
 */
export const postureStatusSchema = z.enum(['ok', 'fail', 'unknown', 'not_applicable']);
export type PostureStatus = z.infer<typeof postureStatusSchema>;

export const postureCheckSchema = z.object({
    rule: sentinelRuleIdSchema,
    status: postureStatusSchema,
    label: z.string().max(64),
    /** Détail mesuré, quand il y en a un : « 12 correctifs, le plus ancien depuis 34 j ». */
    detail: z.string().max(255).nullable().default(null)
});
export type PostureCheck = z.infer<typeof postureCheckSchema>;

export const devicePostureSchema = z.object({
    deviceId: z.string().max(36),
    deviceName: z.string().max(128),
    /** Sur 100, sur les seuls contrôles concluants : diluer `unknown` récompenserait une machine qui ne mesure rien. */
    score: z.number().int().min(0).max(100).nullable(),
    checks: z.array(postureCheckSchema).max(32)
});
export type DevicePosture = z.infer<typeof devicePostureSchema>;

/** Bornes de la fenêtre d'apprentissage, en jours. */
export const SENTINEL_LEARNING_DAYS_MIN = 1;
export const SENTINEL_LEARNING_DAYS_MAX = 90;
export const DEFAULT_SENTINEL_LEARNING_DAYS = 7;

/**
 * Bornes en minutes. Le défaut (`DEFAULT_SENTINEL_INTEGRITY_MINUTES`) vit dans
 * `@deveye/types/sdk` : l'app l'applique en composant la config d'un agent
 * sans contribution du module.
 */
export const SENTINEL_INTEGRITY_MINUTES_MIN = 15;
export const SENTINEL_INTEGRITY_MINUTES_MAX = 1440;

/** Combien de jours un constat résolu est conservé avant balayage. */
export const DEFAULT_SENTINEL_FINDING_RETENTION_DAYS = 180;

export const sentinelConfigSchema = z.object({
    enabled: z.boolean(),
    /**
     * Fin de la fenêtre d'apprentissage, en unix ms. `null` quand Sentinelle n'a
     * jamais été activée ; une date passée signifie « apprentissage terminé ».
     */
    learningUntil: z.number().int().positive().nullable(),
    integrityMinutes: z.number().int().min(SENTINEL_INTEGRITY_MINUTES_MIN).max(SENTINEL_INTEGRITY_MINUTES_MAX),
    authEvents: z.boolean(),
    /**
     * Un constat sérieux garde-t-il l'instant qui le porte ? Ces relevés
     * apparaissent dans l'historique de Monitoring et survivent à la rétention.
     */
    pinEvidence: z.boolean()
});
export type SentinelConfig = z.infer<typeof sentinelConfigSchema>;

/** Décompte des constats ouverts par gravité. */
export const severityCountsSchema = z.object({
    info: z.number().int().nonnegative(),
    low: z.number().int().nonnegative(),
    high: z.number().int().nonnegative(),
    critical: z.number().int().nonnegative()
});
export type SeverityCounts = z.infer<typeof severityCountsSchema>;

/** L'état d'une machine dans la vue de flotte. */
export const deviceSentinelStateSchema = z.object({
    deviceId: z.string().max(36),
    deviceName: z.string().max(128),
    enabled: z.boolean(),
    /** Vrai tant que la fenêtre d'apprentissage court. */
    learning: z.boolean(),
    learningUntil: z.number().int().positive().nullable(),
    open: severityCountsSchema,
    postureScore: z.number().int().min(0).max(100).nullable(),
    /** Sondes dont on a effectivement reçu de la donnée : ce qui n'est pas mesuré se dit. */
    probes: z.array(ruleProbeSchema).max(8),
    /** Dernier relevé de persistance reçu, unix ms. */
    lastIntegrityAt: z.number().int().positive().nullable(),
    /** Tels qu'enregistrés (défauts sans ligne), pour que le panneau de réglages parte de ce qui est réglé. */
    integrityMinutes: z.number().int().min(SENTINEL_INTEGRITY_MINUTES_MIN).max(SENTINEL_INTEGRITY_MINUTES_MAX),
    authEvents: z.boolean(),
    pinEvidence: z.boolean()
});
export type DeviceSentinelState = z.infer<typeof deviceSentinelStateSchema>;
