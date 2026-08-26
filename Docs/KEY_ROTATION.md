# Changer la clé serveur (`CRYPT_KEY_A` / `CRYPT_KEY_B`)

> Écrit le 26 août 2026. À lire avant de toucher à ces deux variables : les
> changer sans la procédure ci-dessous rend illisible tout ce qu'elles
> emballent, et il n'y a aucun chemin de retour.

## Ce qu'est la clé serveur

`serverKey = sha256("CRYPT_KEY_A:CRYPT_KEY_B")`, 32 octets dérivés au boot
(`src/Services/Encryption.ts`). Elle ne chiffre presque jamais de données :
elle **emballe des clés** (chiffrement par enveloppe, voir
[SECURITY_MODEL.md](./SECURITY_MODEL.md)). C'est ce qui rend une rotation
faisable en quelques secondes : il n'y a que des lignes de 32 octets à
ré-emballer, jamais des Go de contenu à re-chiffrer.

## Ce qu'elle emballe, exhaustivement

| Où | Quoi | Écrit par |
|---|---|---|
| `user_secret_keys.dek_wrapped` (lignes `wrap_mode = 'server'`) | la DEK gardée d'un compte dont le chiffrement par mot de passe est OFF | `SecretKeyService.ensureRow`, `wrapWithServer` |
| `user_secret_keys.open_dek_wrapped` | la DEK ouverte de chaque compte | `SecretKeyService.resolveOpenDek` |
| `workspace_secret_keys.dek_wrapped` | la WDK de chaque espace partagé | `SecretKeyService.createWorkspaceDek` |
| `user_2fa.secret_enc` | le secret TOTP, scellé (pas une clé, mais lisible avant toute session) | `features/twofa` |
| `sync_meta` (`k = 'blob_key_wrapped'`) | la BMK de CloudSync, via `deps.keys.sealBytes` | module CloudSync |
| tout module qui appelle `deps.keys.sealBytes` | son matériel de clé, là où il le range | le module |

Et une dérivation, sans stockage :

| Quoi | Comment |
|---|---|
| `BAK`, la clé des archives de sauvegarde | `HKDF(serverKey, 'deveye-backup')`, `src/backup/crypto.ts` |

**Ce qui n'en dépend pas** : tout le contenu des features (sous DEK ou WDK),
les blobs CloudSync (sous BMK), les DEK emballées par mot de passe
(`wrap_mode = 'password'`, ces lignes-là ne bougent pas), les secrets JWT, le
`DEVICE_TOKEN_SECRET`, les jetons OAuth : autant de variables à part, sans lien.

## Ce qui se passe si on change les variables sans rien faire

Au boot suivant, chaque `openRaw` échoue : plus aucune DEK serveur ni DEK
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
(CloudSync : `sync_meta`). L'outil connaît celui de CloudSync ; un nouveau
module devra ajouter sa ligne dans `scripts/rotate-server-key.ts`, il n'y a pas
de découverte automatique.
