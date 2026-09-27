# L'export des données d'un compte

Profil → « Vos données » → « Exporter mes données » : tout ce que le compte
possède sur ce serveur, dans un `.zip` (portabilité et droit d'accès du RGPD).
La même carte porte la suppression du compte, dont la popup propose d'exporter
d'abord.

## Deux temps, rien sur disque

1. **`user.exportPreview`** (sans mot de passe) mesure les parties lourdes que
   les modules déclarent (`files`), pour que la popup dise ce que pèsera
   l'archive. Une partie `optional` (les fichiers CloudSync) peut être laissée
   de côté ; à 0 octet, le choix n'est même pas proposé.
2. **`user.exportPrepare({ password, leaveOut })`** vérifie le mot de passe
   (même compteur d'essais que la suppression), refuse si un module qui exporte
   est en maintenance complète (l'archive le manquerait), puis **prête la DEK
   gardée** du compte à cet export seul et rend un lien valable 5 minutes, à
   usage unique.
3. **`GET /api/account/export?token=`** (`src/Services/accountExport/route.ts`)
   écrit l'archive pendant qu'elle part. Rien ne passe par un fichier
   temporaire : ni le disque du serveur ni un proxy (`X-Accel-Buffering: no`)
   ne voient le clair.

Le lien ne vaut que **par le cookie de la session qui l'a demandé** : ni un
jeton porteur, ni une autre session du même compte. Il est consommé à la
première requête, même refusée. Pas de `HEAD` (il brûlerait le jeton sans rien
servir), pas de journal de requête (le jeton est dans l'URL). Un export à la
fois par compte, trois sur tout le serveur. Un navigateur qui ne lit plus rien
pendant 10 minutes arrête l'export ; un compte supprimé ou une session révoquée
aussi, entre deux fonctionnalités.

À la fin : l'audit `user.exportDone` (ou `user.exportAborted`) et un e-mail au
compte, « vos données ont été exportées » : l'archive porte le coffre, son
titulaire doit savoir qu'elle existe.

La clé prêtée est décrite dans [SECURITY_MODEL.md](./SECURITY_MODEL.md#la-dek-prêtée-à-une-exportation).

## L'archive

```
Compte/compte.json          profil, réglages, sessions, espaces dont il n'est que membre
Compte/avatar.<ext>
Compte/journal.json         son journal d'activité
Compte/retours.json         ses retours envoyés
Compte/<Feature>/           ce qu'un module garde par compte (scope: 'account')
Espaces/<Nom>/espace.json   réglages, rôles, membres, canaux (sans adresse), domaines
Espaces/<Nom>/logo.<ext>
Espaces/<Nom>/<Feature>/    preferences.json, puis les tables et fichiers du module
LISEZMOI.txt                pour qui l'ouvre sans connaître DevEye
export.json                 le même rapport, pour un programme
```

JSON en UTF-8, dates ISO 8601, une longue table en tableau écrit ligne à ligne.
Le courrier hébergé est en `.eml`, les fichiers (CloudSync, sauvegardes
locales, images) tels quels. **Tout est en clair**, étage gardé compris : le
titulaire a donné son mot de passe pour ça, et la popup le prévient.

Portée : l'espace personnel et les espaces partagés que le compte **possède**.
Ceux dont il n'est que membre sont nommés dans `compte.json`, pas exportés :
leurs données sont à leur propriétaire.

Une fonctionnalité qui échoue est notée dans le rapport et les autres
continuent ; une cellule qu'aucune clé n'ouvre est laissée vide et comptée.
Seuls une erreur d'écriture, un téléchargement interrompu ou une clé retirée
arrêtent tout.

## Ce qui ne sort jamais

Ce qui ouvre un service ou protège le compte : hachés de mot de passe, secret
2FA et codes de secours, clés enveloppées, jetons de session et d'appareil,
identifiants d'intégration (clés d'API, mots de passe d'un service tiers, clés
DKIM), jetons de page publique et de domaine, adresses secrètes (webhook,
calendrier privé). Ni ce qui se reconstruit (un cache, un historique importé),
ni un corpus commun à tous les comptes (CVE, taux de change). Chaque exclusion
porte sa raison, lue par le titulaire dans `LISEZMOI.txt`.

## Chaque table a un sort

- Les tables du cœur : `CORE_EXPORT_TABLES` (`src/Services/accountExport/coverage.ts`),
  écrites par l'hôte (`run.ts`) ou tues avec leur raison.
- Celles d'un module : `server.accountExport.tables`, la déclaration du module
  (le contrat est dans `@deveye/types`, `sdk/accountExport.ts` ; le guide du
  développeur tiers dans `DevEye-Feature-Template/docs/13-account-export.md`).
  Écrite par l'hôte (`where`, clé de pagination, colonnes `sealed`, `json`,
  `dates`, `omit`), par les crochets du module (`'custom'`), ou tue
  (`{ skip: raison }`).

**Au boot**, après les migrations, `assertExportCoverage` confronte les
déclarations au schéma réel. Une table ou une colonne inconnue, une table
déclarée deux fois, une colonne `*_enc` ni ouverte ni tue, une colonne à allure
de secret (`secret`, `token`, `passw`, `_hash`, `private_key`, `credential`,
`wrapped`) ni tue ni gardée par `keep` : le serveur ne démarre pas. Une table
**sans sort** ne fait qu'avertir au journal : ce peut être celle d'un module
désinstallé sans son `uninstall.sql`. Le smoke de la CI (`npm run ci:smoke`),
sur une base neuve, la refuse : une migration qui crée une table sans lui
donner de sort ne passe pas.

`npx tsx scripts/export-coverage.ts` fait le même relevé contre la base du
`.env` (ou `DB_DATABASE`).

## Ajouter une table

Dans la même livraison que sa migration : son sort dans la déclaration du
module (ou dans `CORE_EXPORT_TABLES` pour une table du cœur). En cas de doute,
la règle : ce que le compte a créé sort ; ce qui ouvre un accès ne sort pas.
