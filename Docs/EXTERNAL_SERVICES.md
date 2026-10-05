# Services externes

La page admin Services externes (menu du compte, administrateur global) montre
chaque dépendance externe de l'instance : son état, ses chiffres utiles et ce
qu'elle coûte. Les services qu'un espace règle lui-même (son webhook Discord,
son instance Dokploy, ses clés OSINT) n'y figurent pas : ils sont ceux de ses
membres.

## Ce que la page lit

Une commande, `admin.externalServices` (`src/features/admin/externalServices.ts`),
rend les cartes et les places simultanées de ce serveur. Les cartes viennent de
`Services/externalServices` :

- les sondes de l'hôte (`host.ts`) ;
- puis le `FeatureServer.externalServices` de chaque module installé
  ([FEATURE_SDK.md](./FEATURE_SDK.md#les-services-externes)).

Tout se mesure en parallèle, chaque lecture bornée à 8 s : un service qui ne
répond pas devient une carte « En panne » sans retenir les autres. La mesure
sert 5 minutes ; « Revérifier » la refait, caches des modules compris.

Une carte a un état parmi quatre : Opérationnel, Dégradé, En panne, Inactif
(non configuré sur cette instance, voulu ou pas encore).

## Les sondes de l'hôte

| Carte                      | Configuration                           | Ce qui est vérifié                                                                                                                                  |
| -------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stockage objet (S3)        | `STORAGE_S3_*`                          | un aller-retour sur un objet témoin ; l'espace occupé de tout le bucket (ce qui est facturé), sur une jauge de 50 Tio, le premier palier d'OVHcloud |
| Envoi des mails du serveur | `SMTP_*`                                | la poignée de main SMTP, identifiants compris                                                                                                       |
| Versions de l'agent        | `AGENT_DOWNLOAD_TOKEN`, `AGENT_REPO`    | l'issue de la synchronisation au démarrage                                                                                                          |
| Domaines des clients       | `DOMAIN_PROXY_TOKEN`                    | la dernière lecture de la liste par Traefik                                                                                                         |
| Page d'état                | `STATUS_PAGE_URL`, `STATUS_PROBE_TOKEN` | la dernière sonde de la page d'état                                                                                                                 |

L'espace occupé se mesure en listant tout le bucket, une requête par millier
d'objets : une mesure par heure au plus, et la page n'attend pas plus de 5 s
une mesure en cours. Le coût estimé multiplie cet espace par
`STORAGE_S3_PRICE_PER_GB` (€ HT par Go et par mois) ; sans elle, la page le dit
plutôt que d'inventer un tarif. Au-delà de 50 Tio, le Go coûte moins cher chez
OVHcloud et l'estimation est majorée.

## Les cartes des modules

| Module                  | Carte             | Ce qui est vérifié                                                                                                                                                                                                              |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Facturation des comptes | Stripe            | la clé principale (argent réel ou test) et la clé de test, par la lecture des tarifs de Pro ; les offres sur mesure proposées ; les abonnements payants en cours, et tous ceux qui ont payé un jour ; le dernier événement reçu |
| Météo                   | Open-Meteo        | inactif sans `OPEN_METEO_API_KEY` (palier gratuit, non commercial) ; sinon un appel minimal avec la clé                                                                                                                         |
| Mail                    | Google, Microsoft | les identifiants OAuth de l'application, par un jeton de rafraîchissement inventé ; les boîtes reliées et les comptes qui les ont reliées                                                                                       |
| Finances                | Enable Banking    | l'application de l'instance (nom, environnement, active) ; les connexions bancaires, et celles en échec                                                                                                                         |

Les modules gardent leur mesure 10 minutes : un appel de plus compterait dans
un quota d'API, et compter les abonnements payés relit toutes les factures
payées de Stripe.

## Les places

Sous les cartes, les places simultanées de ce serveur (abonnés et comptes
gratuits : connectés, plafond, en attente), réglées dans Accès et maintenance
([MAINTENANCE.md](./MAINTENANCE.md)). Aucun plafond ne borne le nombre
d'abonnements.
