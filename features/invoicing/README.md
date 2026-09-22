# Facturation

Les devis et les factures d'un espace, pour des prestations de services : un
carnet de clients, un devis qu'on fait accepter en ligne, sa conversion en
facture, le suivi de ce qui reste dû.

Ce document dit **pourquoi** la feature est faite ainsi. Le « quoi » est dans les
contrats (`src/contracts/`) et le « comment » dans le code, qui est commenté.

---

## Les cinq décisions qui portent tout le reste

### 1. Les montants sont des entiers de centimes, les quantités des millièmes

`BIGINT` en base, `number` entier sur le fil, jamais un flottant, jamais un
`DECIMAL`. La division par cent est la **dernière** étape, faite à l'affichage
seul. Un montant est toujours **positif** : le sens vient du type de pièce, pas
du signe, sans quoi « un avoir de -300 € » existerait à côté d'un avoir de
300 €, et chaque écran devrait se demander ce qu'il regarde.

Les quantités sont en millièmes d'unité (`1000` = une unité, `500` = une
demi-journée, `1333` = 1 h 20) : trois décimales suffisent à tout ce qu'une
prestation se compte, et aucune fraction décimale n'est exacte en binaire.

**Un seul endroit arrondit**, `src/contracts/money.ts`, et le SQL ne calcule
jamais un montant : il ne somme que des colonnes déjà arrondies là. C'est ce qui
permet au client de totaliser en direct et au serveur de figer le même total à
l'émission, sans deux implémentations à tenir d'accord.

La TVA se calcule **par taux sur la base agrégée**, jamais ligne par ligne :
c'est la pratique française, et c'est ce qui évite le centime d'écart entre le
récapitulatif imprimé et le total. La somme des tranches est donc égale au total
de TVA par construction, et un test le vérifie.

### 2. Les dates sont des jours, pas des instants

Colonnes `DATE`, chaînes `AAAA-MM-JJ`, comparables et triables telles quelles.
Une pièce appartient à un jour civil : un horodatage la ferait changer de mois
comptable selon le fuseau de qui la regarde. Le calcul passe par `Date.UTC` de
bout en bout, sans quoi additionner des jours sauterait une heure au changement
d'heure d'été.

« Aujourd'hui » n'est jamais `CURDATE()` : il est calculé dans le **fuseau de
l'espace** et passé en paramètre. Sans cela, une pièce émise depuis La Réunion
porterait la date de la veille tant que le serveur est en Europe.

### 3. L'élément de la feature est le client, pas le document

Un espace accumule des centaines de documents : en faire des éléments rendrait
l'écran des rôles illisible, et un élément est fait pour porter des réglages, ce
qu'un document n'a pas. Le client, lui, est la seule entité durable et nommable,
celle qu'un rôle a une raison de fermer, et un document hérite de la restriction
du sien.

Conséquence heureuse : le document n'étant pas un élément, la règle « pas de
bouton Modifier, tout passe par l'onglet Général » ne le lie pas, et son en-tête
s'édite directement dans la page tant qu'il est brouillon. C'est la seule
interface tenable pour une pièce qu'on est en train de rédiger.

### 4. Étage ouvert, texte libre chiffré, nombres en clair

Tout passe par `ctx.cipher()`, l'étage ouvert : les documents appartiennent à
l'**espace**, et tout membre d'un espace partagé doit pouvoir les lire sans
dépendre de la session de son propriétaire. La feature ne demande donc jamais de
mot de passe.

Ce qui est chiffré : identités, adresses, coordonnées bancaires, intitulés de
ligne, notes. Ce qui reste en clair : montants, taux, dates, statuts, numéros.
La raison n'est pas le confort : un reste dû et un encaissement du mois sont des
`SUM(...) GROUP BY`, et le chiffrement de DevEye est non déterministe. Rien de ce
sur quoi on agrège ne peut le traverser.

### 5. C'est le client qui répond, pas l'émetteur à sa place

Le lien public **naît avec l'émission**, et non d'un clic séparé : c'est par lui
que le document est remis, et le faire naître à la demande revenait à cacher le
canal principal derrière un geste. Il reste révocable.

La page qu'il ouvre porte les **deux** réponses, l'accord et le refus. N'offrir
que l'accord obligeait un client qui refuse à écrire un courriel, et l'émetteur
ne savait jamais où il en était. Noter la réponse soi-même reste possible, mais
c'est la voie de secours : elle est présentée comme telle, sous le lien.

Le **cadre « bon pour accord »** et la réponse en ligne ne paraissent jamais
ensemble. Le cadre ne sort que sur un devis qui attend encore (`awaitingAnswer`) :
derrière une réponse déjà donnée, il invitait à signer une seconde fois, à côté
de la ligne qui disait l'accord. Et sur la page publique, où les deux pourraient
coexister, chacun a son médium : le formulaire à l'écran, où l'on clique, le cadre
à l'impression, où l'on signe.

Une réponse en ligne bat le sujet live de la feature (`deps.live.changed`) : la
fiche ouverte chez l'émetteur se relit d'elle-même. **Jamais un brouillon**,
lui : sa vérité est à l'écran, et le relire écraserait ce qui est en train
d'être tapé.

---

## Limites connues, et assumées

- **Pas de pièce jointe PDF.** Le document part en HTML dans le corps du mail,
  avec un lien vers sa page, comme le font Stripe et Qonto ; le PDF s'obtient
  depuis l'app par le dialogue d'impression du navigateur. Une vraie pièce
  jointe demanderait un moteur de rendu navigateur côté serveur.
- **Pas de Factur-X ni de plateforme de dématérialisation.** La réforme
  française impose l'émission en données structurées aux TPE et PME à une date
  qui a déjà glissé deux fois ; le modèle de données est taillé pour cet export
  (SIREN et numéro de TVA des deux parties en champs propres, ventilation par
  taux reconstituable, identité de pièce immuable), mais rien ne le produit
  encore.
- **La réponse en ligne d'un devis** (accord ou refus) vaut un « bon pour accord »
  horodaté, pas une signature électronique qualifiée.
- **Le carnet de clients se trie en mémoire** : le nom est chiffré, et le
  chiffrement non déterministe interdit de trier en SQL. Le listage garde donc
  une borne dure. Au-delà de quelques milliers de clients, il faudrait une
  empreinte dérivée comme colonne de tri.
