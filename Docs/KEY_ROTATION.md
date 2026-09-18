# Changer la clé serveur (`CRYPT_KEY_A` / `CRYPT_KEY_B`)

> Écrit le 26 août 2026. À lire avant de toucher à ces deux variables : les
> changer sans la procédure ci-dessous rend illisible tout ce qu'elles
> emballent, et il n'y a aucun chemin de retour.

## Ce qu'est la clé serveur

Sa racine est `sha256("CRYPT_KEY_A:CRYPT_KEY_B")`, 32 octets dérivés au boot
(`src/Services/Encryption.ts`). Elle ne chiffre presque jamais de données :
elle **emballe des clés** (chiffrement par enveloppe, voir
[SECURITY_MODEL.md](./SECURITY_MODEL.md)). C'est ce qui rend une rotation
faisable en quelques secondes : il n'y a que des lignes de 32 octets à
ré-emballer, jamais des Go de contenu à re-chiffrer.

La racine ne scelle rien elle-même. Chaque usage a sa **sous-clé**
(`HKDF-SHA256(racine, sel 'deveye-seal', info = étiquette)`), et chaque blob
porte sa ligne en **contexte** (AAD de GCM, authentifié, pas stocké) : un blob
recopié dans une autre colonne, ou sur la ligne d'un autre compte, ne s'ouvre
pas. Format d'un blob scellé : base64 de `0x02 | iv(12) | tag(16) | chiffré`.
Les deux variables font au moins 32 caractères et diffèrent : le serveur
refuse de démarrer sinon.

## Ce qu'elle emballe, exhaustivement

La liste fait foi dans le code : `SEAL_TARGETS` (`src/Services/sealTargets.ts`),
que lisent la rotation, le re-scellement et le contrôle au boot. Un test vérifie
que chaque cible figure ici.

| Où                                                             | Étiquette           | Contexte                         | Quoi                                                                   |
| -------------------------------------------------------------- | ------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `user_secret_keys.dek_wrapped` (lignes `wrap_mode = 'server'`) | `user-dek`          | `user_secret_keys:dek:<id>`      | la DEK gardée d'un compte dont le chiffrement par mot de passe est OFF |
| `user_secret_keys.open_dek_wrapped`                            | `user-open-dek`     | `user_secret_keys:open_dek:<id>` | la DEK ouverte de chaque compte                                        |
| `workspace_secret_keys.dek_wrapped`                            | `workspace-dek`     | `workspace_secret_keys:dek:<id>` | la WDK de chaque espace partagé                                        |
| `user_2fa.secret_enc`                                          | `totp`              | `user_2fa:secret:<id>`           | le secret TOTP, scellé (pas une clé, mais lisible avant toute session) |
| `sync_meta.v` (`k = 'blob_key_wrapped'`)                       | `module:cloudsync`  | vide                             | la BMK de CloudSync, via `deps.keys.sealBytes`                         |
| `ft_mailserver_mailboxes.blob_key`                             | `module:mailserver` | vide                             | la clé des corps de chaque boîte                                       |
| `ft_mailserver_domain_keys.private_key`                        | `module:mailserver` | vide                             | les clés DKIM des domaines                                             |
| `ft_mailserver_tls.sealed`                                     | `module:mailserver` | vide                             | la clé du certificat des écouteurs                                     |
| tout module qui appelle `deps.keys.sealBytes`                  | `module:<son id>`   | celui qu'il passe, vide sinon    | son matériel de clé, là où il le range                                 |

Et une dérivation, sans stockage :

| Quoi                                     | Comment                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAK`, la clé des archives de sauvegarde | `HKDF(racine, 'deveye-backup')`, `features/backup/src/server/crypto.ts`, refaite sans DevEye par `scripts/restore-backup.mjs`                                                                                                                                                                                                                                   |
| la clé des codes de secours 2FA          | `HKDF(racine, 'deveye-backup-codes')`, `src/Services/Totp.ts` : les codes sont rangés en HMAC sous cette clé. Changer la clé serveur les invalide tous : chaque compte régénère les siens (la 2FA elle-même reste active, son secret est re-scellé)                                                                                                             |
| le sel des visiteurs d'Audience          | `HKDF(serverKey, 'audience', 'visitor-salt')`, `features/audience/src/server/service.ts` : entre dans chaque condensé de visiteur (`visitor_ref`). Changer la clé serveur change donc les condensés une fois : un visiteur persistant est compté « nouveau » une fois, les condensés anonymes tournaient déjà chaque jour. Rien à re-sceller, rien n'est stocké |

**Ce qui n'en dépend pas** : tout le contenu des features (sous DEK ou WDK),
les blobs CloudSync (sous BMK), les DEK emballées par mot de passe
(`wrap_mode = 'password'`, ces lignes-là ne bougent pas), les secrets JWT, le
`DEVICE_TOKEN_SECRET`, les jetons OAuth : autant de variables à part, sans lien.

## Ce qui se passe si on change les variables sans rien faire

Au boot suivant, chaque `openFor` échoue : plus aucune DEK serveur ni DEK
ouverte ne se déballe (tout le contenu ouvert devient illisible, le coffre des
comptes sans mot de passe aussi), plus aucune WDK (tous les espaces partagés),
le TOTP ne se vérifie plus, CloudSync refuse de démarrer (« impossible de
dé-wrapper la clé des blobs »), et les archives de sauvegarde existantes ne se
restaurent plus qu'avec les anciennes valeurs. Rien n'est détruit en base, mais
rien ne se lit.

## La procédure

Un outil fait le travail : `npm run rotate:server-key`. Il lit les anciennes
clés dans l'environnement courant (`CRYPT_KEY_A/B`), les nouvelles dans
`NEW_CRYPT_KEY_A` / `NEW_CRYPT_KEY_B`, ré-emballe chaque ligne du tableau
ci-dessus dans **une seule transaction**, et relit chaque blob sous la nouvelle
clé avant de valider. Dry-run par défaut : il compte, vérifie que tout s'ouvre
sous l'ancienne clé, et n'écrit rien.

1. **Générer les nouvelles clés** (deux chaînes aléatoires, comme à
   l'installation : `openssl rand -hex 32` chacune). Les ranger là où vivent
   les actuelles, **sans effacer les anciennes** : voir l'étape 6.
2. **Sauvegarde de la base** avant tout (la feature Sauvegardes, ou un dump).
   Cette archive est scellée sous l'ancienne `BAK` : elle se restaure avec les
   anciennes clés, c'est normal.
3. **Arrêter le serveur.** Les ré-emballages ont lieu à l'écriture (première
   utilisation d'une DEK, création d'un espace, configuration de la 2FA) : un
   serveur vivant pourrait écrire sous l'ancienne clé pendant la conversion.
4. **Dry-run** avec l'environnement de prod (dans le conteneur, ou avec
   `--env-file`) :
    ```bash
    NEW_CRYPT_KEY_A=… NEW_CRYPT_KEY_B=… npm run rotate:server-key
    ```
    Attendu : chaque ligne « à ré-emballer », zéro « illisible ». Un blob
    illisible sous l'ancienne clé signifie que l'environnement courant n'est pas
    celui qui a écrit la base : on s'arrête là.
5. **Exécution** : la même commande avec `-- --yes`. Tout ou rien : une seule
   ligne qui ne se relit pas sous la nouvelle clé annule la transaction.
6. **Basculer l'environnement** (Dokploy › Environment, ou `.env`) sur les
   nouvelles valeurs, puis redémarrer. Vérifier : un login (avec 2FA si elle
   est active), le coffre d'un compte sans mot de passe, un espace partagé,
   la tuile CloudSync, et **une sauvegarde puis sa restauration à blanc**
   (`scripts/restore-backup.mjs`).
7. **Les archives d'avant** restent sous l'ancienne `BAK` pour toujours.
   Garder les anciennes clés, datées, à côté des nouvelles, tant qu'une de ces
   archives a de la valeur ; `restore-backup.mjs --env <ancien .env>` les lit.
   Les re-sceller sous la nouvelle clé (restaurer puis re-sauvegarder) est
   possible mais rarement utile : une archive vieillit, une clé se garde.

## Passer une base au format 2 (une fois)

Une base écrite avant les sous-clés a ses blobs scellés nus, sous la racine,
sans contexte. Le serveur le détecte au boot (`src/Services/sealFormat.ts`) et
**refuse de démarrer** en nommant les colonnes concernées : il ne saurait pas
les ouvrir, et l'échec surgirait sinon au premier déverrouillage. Le passage
est un script et non une migration de boot, parce qu'il lui faut la clé serveur
et une transaction annulable.

1. Sauvegarde de la base, serveur arrêté (il l'est déjà : il refuse de démarrer).
2. Dry-run, avec l'environnement de prod (dans le conteneur) :
    ```bash
    npm run reseal:server-key
    ```
    Attendu : chaque ligne « à re-sceller » ou « déjà au format 2 », zéro
    « illisible ».
3. Exécution : `npm run reseal:server-key -- --yes`. Une seule transaction,
   chaque blob relu avant validation. Rejouable sans risque.
4. Redémarrer. Les codes de secours 2FA, eux, ont été effacés par la migration
   114 (leur ancien condensé n'était pas convertible) : chaque compte en
   régénère depuis Sécurité.

Une installation neuve n'a rien à convertir.

## Quand la faire

Quand les clés ont fuité, ou changent de main. Pas de rotation périodique :
elle n'apporte rien tant que les clés sont sûres, et chaque rotation ajoute
une génération d'archives à garder lisible.

## Ce que ça n'est pas

Pas une rotation « à chaud » : il n'y a pas d'identifiant de clé sur les blobs
emballés, donc pas de période où deux clés seraient acceptées. Le serveur
arrêté et la transaction unique rendent cela inutile : la bascule dure le temps
d'un redémarrage.

Pas non plus une rotation des DEK ou des WDK : celles-ci ne changent jamais
(les changer voudrait dire re-chiffrer le contenu), et c'est le principe de
l'enveloppe. La clé serveur est la seule couche prévue pour tourner.

## Un module et sa clé

Un module qui scelle du matériel par `deps.keys.sealBytes` le range où il veut
(CloudSync : `sync_meta`). Il est scellé sous la sous-clé du module
(`module:<id>`) : le blob d'un module ne s'ouvre ni chez un autre ni comme une
clé de l'app. Un nouveau module ajoute sa ligne à `SEAL_TARGETS`
(`src/Services/sealTargets.ts`), avec le contexte qu'il passe à `sealBytes` : il
n'y a pas de découverte automatique, et une colonne oubliée deviendrait
illisible à la première rotation.
