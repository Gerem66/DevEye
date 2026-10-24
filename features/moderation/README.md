# Modération automatique (`x-moderation`)

Les listes de ce qui est interdit sur l'instance, et ce qu'elles ont arrêté.
Une **règle** interdit soit une **empreinte** (le SHA-256 d'un contenu), soit
un **motif de nom** (`*.torrent`, `keygen?.exe`). Les fonctionnalités qui
gardent des fichiers consultent ces règles à chaque arrivée par le provider
`MODERATION_PROVIDER` de `@deveye/types` : Hébergement à l'envoi et au
renommage, CloudSync avant chaque montée et chaque descente. Sans le module,
rien n'est consulté et ces fonctionnalités font comme avant.

Un module de service : ni carte, ni entrée de compte, ni ligne dans l'écran
des rôles (`accountOnly` avec des `adminTabs` seuls). Il vit dans la popup
« Modération », ouvert aux modérateurs comme aux administrateurs, en deux
onglets : **Règles** et **Détections**.

Documents voisins : [Docs/FEATURE_SDK.md](../../Docs/FEATURE_SDK.md) (les
providers, l'administration d'une fonctionnalité),
[Docs/EXTERNAL_SERVICES.md](../../Docs/EXTERNAL_SERVICES.md) (la liste
externe), [Docs/ACCOUNT_EXPORT.md](../../Docs/ACCOUNT_EXPORT.md).

## Le modèle

Une règle porte :

- son genre, `fingerprint` ou `name`, et son motif : une empreinte en
  hexadécimal minuscule, unique par genre, ou un motif de nom à jokers sur le
  nom entier, casse ignorée ;
- un **motif d'interdiction** au vocabulaire des signalements (`illegal`,
  `copyright`, `malware`, `privacy`, `minors`, `other`) et un **libellé**, ce
  que lit la personne arrêtée ;
- sa **portée** : `public`, les seules pages ouvertes à tous (un dossier
  d'Hébergement), ou `everywhere`, aussi ce qu'un compte garde pour lui et ses
  appareils (un partage CloudSync) ;
- sa **source** : `manual` (posée par un modérateur, une ou cent d'un coup),
  `takedown` (les empreintes d'un dossier retiré par la modération
  d'Hébergement) ou `feed` (la liste externe) ;
- combien de fois elle a arrêté un fichier, et quand pour la dernière fois.

Une **détection** est un fichier qu'une règle a arrêté quelque part : la
fonctionnalité, l'élément qui portait le fichier et son nom (scellés par la clé
du serveur), l'empreinte et la taille, l'espace et le compte d'origine. La même
règle sur le même fichier au même endroit (un appareil qui réessaie à chaque
synchronisation) tient sur une ligne, dont `count` dit le nombre d'essais. Un
modérateur lit le contenu d'une détection sans savoir d'où elle vient : l'espace
et le compte ne sortent que vers un administrateur. Les détections se gardent
un an.

## Le provider

```ts
const moderation = deps.providers.get<ModerationProvider>(MODERATION_PROVIDER);
const hit = await moderation?.check({
    sha256, // le SHA-256 du clair, ou null si le serveur ne peut pas le calculer
    name, // le nom du fichier, sans ses dossiers
    exposure: 'public', // ou 'private'
    origin: { feature: 'x-hosting', workspaceId, userId, context: packName }
});
```

`check` rend `null` quand rien ne correspond, sinon la règle (`ruleId`, `kind`,
`reason`, `label`) après avoir journalisé la détection. L'appelant décide du
sort du fichier : Hébergement le **retient** (jamais servi, visible de son
propriétaire comme « retenu pour vérification ») et ouvre un signalement
automatique que le modérateur libère ou retire ; CloudSync le **refuse** (rien
n'est stocké, le fichier reste sur l'appareil) et l'écrit au Journal du
partage. Une empreinte se cherche en base à chaque consultation (une lecture
sur index) ; les motifs de nom, quelques dizaines au plus, sont compilés en
mémoire et relus à chaque changement, ou toutes les minutes.

`ban({ fingerprints, reason, label, by })` interdit des empreintes à partir de
maintenant (source `takedown`) : ce qu'Hébergement appelle quand un modérateur
retire un dossier en cochant « Interdire ces fichiers à l'avenir ». Rien de déjà
en place n'est réexaminé : une règle n'arrête que ce qui arrive après elle.

Un partage CloudSync chiffré de bout en bout n'a pas d'empreinte lisible par le
serveur (`sha256: null`) : seuls les motifs de nom le regardent.

## La liste externe

`MODERATION_FEED_URL` nomme une liste d'empreintes SHA-256 (une par ligne, les
lignes en `#` ignorées, une ligne de CSV livre la première empreinte qu'elle
contient), relue toutes les heures par `safeFetchText` (adresse publique
seulement) et versée dans les règles en source `feed`, motif `malware`, portée
`everywhere`. `MODERATION_FEED_AUTH_KEY`, si la liste en attend une, part dans
l'en-tête `Auth-Key`. L'onglet Règles résume ces empreintes sans les lister, et
la page Services externes porte la carte « Liste d'empreintes externe » (état,
source, nombre, dernière relecture, dernière erreur ; « Revérifier » relit la
liste). Sans adresse, la carte est inactive et les empreintes viennent de la
saisie, des retraits et des imports.

Les exports de MalwareBazaar (abuse.ch) ont cette forme et exigent une clé ;
leurs conditions réservent un usage commercial à leur offre payante : à vérifier
avant de les brancher sur une instance qui vend des abonnements.

## Les commandes

Toutes en `access: { scope: 'account', moderation: true }` :
`x-moderation.rules` (les règles hors liste externe, et l'état de celle-ci),
`rulesAdd` (des règles d'un même genre, un motif par ligne, qui partagent
motif, libellé et portée : une liste d'empreintes collée passe telle quelle,
ce qui n'en est pas une est ignoré, un motif de nom invalide refuse tout
l'ajout en nommant sa ligne ; un libellé vide prend celui du motif),
`ruleRemove` et `hits` (les dernières détections). Chaque changement de règle
est audité en `warning`.

## Tables

`ft_moderation_rules`, `ft_moderation_hits` (contenu scellé, déclaré dans
`sealed` : une rotation de la clé serveur le ré-emballe) et
`ft_moderation_meta` (l'état de la liste externe). L'export des données d'un
compte écrit ses détections (`detections.json`) ; les règles sont celles du
service.

## Vérifier

Dans `DevEye/` : `npm run ci:features` (lint, format, types, tests des modules
in-repo). Les tests couvrent les motifs de nom, la lecture d'une liste
d'empreintes, le provider (empreinte, portée, dédoublonnage, interdiction) et
les commandes. Le scénario de bout en bout « Poser et retirer des règles »
tourne depuis la page Tests et débogage.
