-- La facturation d'un espace : l'émetteur, ses clients, ses documents, leurs
-- lignes, leurs règlements et les acomptes qu'ils déduisent.
--
-- Ce qui est en clair l'est parce qu'on agrège, trie ou filtre dessus : les
-- montants, les taux, les quantités, les dates, les statuts, les numéros. Ce
-- qui est scellé (étage ouvert, `ctx.cipher()`) est du texte libre : identités,
-- adresses, coordonnées bancaires, intitulés, notes.
--
-- Les montants sont des entiers de centimes (BIGINT, jamais DECIMAL ni FLOAT)
-- et toujours positifs : le sens vient du type de document, jamais du signe.
-- Les dates sont des DATE (jours civils), projetées par DATE_FORMAT à la
-- lecture, et aucun SELECT étoile ne touche ces tables.
--
-- Deux régimes de vie dans les mêmes colonnes : BROUILLON (le numéro, la date
-- d'émission, les totaux et les instantanés sont NULL, tout se recalcule) et
-- ÉMIS (tout est renseigné, et plus rien ne bouge jamais). Le NULL dit « pas
-- encore figé ».

-- Les réglages de l'espace : l'émetteur et ses valeurs par défaut. Une ligne
-- par espace, créée au premier enregistrement. Aucune lecture ne l'écrit : les
-- valeurs par défaut vivent en TypeScript.
CREATE TABLE IF NOT EXISTS ft_invoicing_settings (
    workspace_id        INT         NOT NULL,
    -- Code ISO 4217. Une seule devise par espace : le multidevise exigerait un
    -- taux de change daté par document.
    currency            CHAR(3)     NOT NULL DEFAULT 'EUR',
    -- Le fuseau où « aujourd'hui » se décide, nom IANA. Sans lui, une pièce
    -- émise depuis La Réunion porterait la date de la veille tant que le
    -- serveur est en Europe.
    time_zone           VARCHAR(64) NOT NULL DEFAULT 'Europe/Paris',
    -- 'standard' (assujetti) ou 'exempt' (franchise en base, article 293 B du
    -- CGI). En clair : il décide si une ligne peut porter un taux non nul.
    vat_regime          VARCHAR(10) NOT NULL DEFAULT 'standard',
    -- Taux d'une ligne neuve, en points de base (2000 vaut 20 pour cent).
    default_vat_bp      INT         NOT NULL DEFAULT 2000,
    -- Délai de règlement par défaut, en jours à compter de l'émission.
    payment_terms_days  INT         NOT NULL DEFAULT 30,
    -- Durée de validité par défaut d'un devis, en jours.
    quote_validity_days INT         NOT NULL DEFAULT 30,
    -- Préfixes de numéro par type, tels qu'ils paraissent sur le document.
    quote_prefix        VARCHAR(8)  NOT NULL DEFAULT 'D',
    invoice_prefix      VARCHAR(8)  NOT NULL DEFAULT 'F',
    credit_prefix       VARCHAR(8)  NOT NULL DEFAULT 'A',
    -- 'yearly' : la séquence repart à 1 chaque année civile, et seq_year porte
    -- l'année. 'never' : une seule séquence continue, seq_year vaut alors 0.
    number_reset        VARCHAR(8)  NOT NULL DEFAULT 'yearly',
    -- Le premier numéro d'une séquence vide. Reprendre un historique facturé
    -- ailleurs commence à 43 sans avoir à inventer 42 documents.
    number_start        INT         NOT NULL DEFAULT 1,
    -- Combien de chiffres le numéro porte, zéros compris (4 donne F2026-0007).
    number_pad          TINYINT     NOT NULL DEFAULT 4,
    -- Le compte mail de l'espace qui expédie les documents, NULL si aucun.
    mail_sender_id      INT         NULL,
    -- { legalName, tradeName, legalForm, capital, address, postalCode, city,
    --   country, siret, vatNumber, rcs, rcsCity, email, phone, website, iban,
    --   bic, insurer, insuranceScope, lateFeeText, recoveryFeeText,
    --   discountText, exemptionText, paymentTerms, footer, signatureText,
    --   logo }, scellé.
    content             MEDIUMTEXT  NOT NULL,
    updated             BIGINT      NOT NULL,
    PRIMARY KEY (workspace_id),
    CONSTRAINT fk_ft_invoicing_settings_ws FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les clients réutilisables. Ce sont les ÉLÉMENTS du module : un rôle peut en
-- fermer un, et un document hérite de la restriction du sien.
--
-- Le nom est scellé, donc le tri par nom se fait après descellement : aucune
-- recherche textuelle en SQL, comme le journal des Finances.
CREATE TABLE IF NOT EXISTS ft_invoicing_clients (
    id                 INT         NOT NULL AUTO_INCREMENT,
    workspace_id       INT         NOT NULL,
    -- 'company' ou 'person' : décide les mentions attendues (SIRET et numéro de
    -- TVA pour une société).
    kind               VARCHAR(8)  NOT NULL DEFAULT 'company',
    -- Valeurs propres au client, NULL = celles de l'espace.
    payment_terms_days INT         NULL,
    default_vat_bp     INT         NULL,
    -- Mis de côté : sort des sélecteurs sans rien perdre. C'est le geste
    -- réversible que la suppression n'est pas.
    archived           TINYINT     NOT NULL DEFAULT 0,
    created            BIGINT      NOT NULL,
    updated            BIGINT      NOT NULL,
    -- { name, contactName, email, phone, address, postalCode, city, country,
    --   siret, vatNumber, note }, scellé.
    content            MEDIUMTEXT  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ft_invoicing_clients_ws (workspace_id, archived, id),
    CONSTRAINT fk_ft_invoicing_clients_ws FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Un document : devis, facture ou avoir. Trois types dans une table parce
-- qu'ils partagent tout (un client, des lignes, des totaux, un numéro) et que
-- la conversion d'un devis en facture serait sinon une recopie entre deux
-- schémas.
CREATE TABLE IF NOT EXISTS ft_invoicing_docs (
    id               INT         NOT NULL AUTO_INCREMENT,
    workspace_id     INT         NOT NULL,
    -- Le client vivant. NULL quand il a été retiré : le document émis garde son
    -- instantané, il ne dépend plus de lui.
    client_id        INT         NULL,
    -- 'quote', 'invoice' ou 'credit'.
    kind             VARCHAR(8)  NOT NULL,
    -- Le devis dont une facture est née, ou la facture qu'un avoir corrige.
    parent_doc_id    INT         NULL,
    -- Devis : 'draft', 'sent', 'accepted', 'declined'. Facture : 'draft',
    -- 'issued', 'cancelled'. Avoir : 'draft', 'issued'. « En retard », « payée »
    -- et « expiré » n'en sont pas : ce sont des fonctions des dates, des sommes
    -- et du jour courant, et un statut stocké pour cela divergerait le lendemain.
    status           VARCHAR(10) NOT NULL DEFAULT 'draft',
    -- L'année de la séquence (0 quand la numérotation ne se remet pas à zéro) et
    -- le rang dans cette séquence. Attribués à l'émission, jamais réattribués.
    seq_year         SMALLINT    NULL,
    number           INT         NULL,
    -- Le numéro tel qu'il est écrit sur le document : les préfixes des réglages
    -- peuvent changer, un document émis ne change pas.
    number_label     VARCHAR(32) NULL,
    -- Jours civils. issued_on est la date d'émission, due_on l'échéance de
    -- règlement, valid_until la fin de validité d'un devis, performed_on la date
    -- de la prestation, qui est une mention distincte et obligatoire.
    issued_on        DATE        NULL,
    due_on           DATE        NULL,
    valid_until      DATE        NULL,
    performed_on     DATE        NULL,
    -- Figés à la création : un document ne change ni de devise ni de régime,
    -- même si l'espace en change après.
    currency         CHAR(3)     NOT NULL DEFAULT 'EUR',
    vat_regime       VARCHAR(10) NOT NULL DEFAULT 'standard',
    -- Totaux en centimes, figés à l'émission. NULL en brouillon, qui les
    -- recalcule depuis ses lignes.
    total_net        BIGINT      NULL,
    total_vat        BIGINT      NULL,
    total_gross      BIGINT      NULL,
    -- Le jeton de la page publique, aléatoire et révocable. Ce n'est pas un
    -- ticket de session : celui-là expire en secondes et ne peut pas voyager
    -- dans un courriel.
    public_token     VARCHAR(64) NULL,
    -- L'acceptation en ligne d'un devis, et les envois.
    accepted_at      BIGINT      NULL,
    sent_at          BIGINT      NULL,
    reminded_at      BIGINT      NULL,
    -- L'émetteur et le client tels qu'ils étaient à l'émission, scellés. Un
    -- document émis doit montrer éternellement ce qu'il montrait, y compris une
    -- adresse dont le client a depuis déménagé. NULL en brouillon, qui lit les
    -- lignes vivantes. Le logo n'y est pas : le recopier pèserait quelques
    -- centaines de kilo-octets par document.
    issuer_snapshot  MEDIUMTEXT  NULL,
    client_snapshot  MEDIUMTEXT  NULL,
    -- { subject, intro, notes, terms, purchaseOrder, acceptance }, scellé.
    content          MEDIUMTEXT  NOT NULL,
    created_by       INT         NOT NULL,
    issued_by        INT         NULL,
    created          BIGINT      NOT NULL,
    updated          BIGINT      NOT NULL,
    PRIMARY KEY (id),
    -- Le juge de la numérotation. MySQL admet plusieurs NULL dans un index
    -- unique, donc tous les brouillons coexistent, et deux émissions simultanées
    -- ne peuvent pas porter le même rang : la seconde est refusée et reprend.
    UNIQUE KEY uniq_ft_invoicing_docs_number (workspace_id, kind, seq_year, number),
    UNIQUE KEY uniq_ft_invoicing_docs_token (public_token),
    KEY idx_ft_invoicing_docs_ws (workspace_id, kind, status, issued_on),
    KEY idx_ft_invoicing_docs_due (workspace_id, kind, status, due_on),
    KEY idx_ft_invoicing_docs_client (client_id, issued_on),
    KEY idx_ft_invoicing_docs_parent (parent_doc_id, kind, status),
    CONSTRAINT fk_ft_invoicing_docs_ws FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id) ON DELETE CASCADE,
    -- Le client s'en va, le document reste : il a été émis. Il perd son
    -- rattachement, pas son instantané.
    CONSTRAINT fk_ft_invoicing_docs_client FOREIGN KEY (client_id)
        REFERENCES ft_invoicing_clients (id) ON DELETE SET NULL,
    CONSTRAINT fk_ft_invoicing_docs_parent FOREIGN KEY (parent_doc_id)
        REFERENCES ft_invoicing_docs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les lignes d'un document. workspace_id est dénormalisé : le dépôt filtre
-- l'espace dans CHAQUE requête, y compris celles qui ne joignent pas le
-- document. La cascade, elle, passe par le document : un seul chemin.
--
-- La part de TVA n'est pas stockée par ligne : elle se calcule par taux sur la
-- base agrégée, sans quoi les arrondis de ligne s'accumuleraient et le total ne
-- retomberait pas sur le récapitulatif imprimé.
CREATE TABLE IF NOT EXISTS ft_invoicing_lines (
    id             INT         NOT NULL AUTO_INCREMENT,
    doc_id         INT         NOT NULL,
    workspace_id   INT         NOT NULL,
    sort_order     INT         NOT NULL DEFAULT 0,
    -- 'service', 'product' ou 'text'. Une ligne 'text' est un commentaire
    -- intercalaire : elle ne pèse sur aucun total.
    kind           VARCHAR(8)  NOT NULL DEFAULT 'service',
    -- La quantité en MILLIÈMES d'unité : 500 vaut une demi-journée, 1333 vaut
    -- 1 h 20. Un entier, parce qu'aucune fraction décimale n'est exacte en
    -- binaire.
    quantity_milli BIGINT      NOT NULL DEFAULT 1000,
    -- 'hour', 'day', 'unit', 'month' ou 'fixed' : ce que la quantité compte.
    unit           VARCHAR(8)  NOT NULL DEFAULT 'unit',
    -- Prix unitaire hors taxe, en centimes, toujours positif.
    unit_price     BIGINT      NOT NULL DEFAULT 0,
    -- Le taux applicable, en points de base. Mention légale de la ligne, donc
    -- stocké même quand il vaut zéro (franchise en base, exonération).
    vat_bp         INT         NOT NULL DEFAULT 0,
    -- Le hors taxe de la ligne, arrondi UNE fois par le serveur et figé à
    -- l'émission. NULL en brouillon.
    net_amount     BIGINT      NULL,
    -- { label, description }, scellé.
    content        MEDIUMTEXT  NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ft_invoicing_lines_doc (doc_id, sort_order, id),
    KEY idx_ft_invoicing_lines_ws (workspace_id),
    -- Le récapitulatif par taux d'un document émis, servi par l'index.
    KEY idx_ft_invoicing_lines_vat (doc_id, vat_bp),
    CONSTRAINT fk_ft_invoicing_lines_doc FOREIGN KEY (doc_id)
        REFERENCES ft_invoicing_docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Les règlements reçus sur une facture. De la saisie, pas une pièce légale :
-- cela se corrige et se retire, contrairement à la facture.
CREATE TABLE IF NOT EXISTS ft_invoicing_payments (
    id           INT         NOT NULL AUTO_INCREMENT,
    doc_id       INT         NOT NULL,
    workspace_id INT         NOT NULL,
    -- Le jour civil de l'encaissement : c'est lui qui date la trésorerie, pas la
    -- date de la facture.
    paid_on      DATE        NOT NULL,
    -- Toujours positif. Un remboursement n'est pas un règlement négatif, c'est
    -- un avoir.
    amount       BIGINT      NOT NULL,
    -- 'transfer', 'card', 'cash', 'check' ou 'other'.
    method       VARCHAR(10) NOT NULL DEFAULT 'transfer',
    -- { reference, note }, scellé.
    content      TEXT        NOT NULL,
    created      BIGINT      NOT NULL,
    PRIMARY KEY (id),
    KEY idx_ft_invoicing_payments_doc (doc_id, paid_on),
    -- L'encaissement d'une période, servi par l'index.
    KEY idx_ft_invoicing_payments_ws (workspace_id, paid_on),
    CONSTRAINT fk_ft_invoicing_payments_doc FOREIGN KEY (doc_id)
        REFERENCES ft_invoicing_docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- L'acompte déjà facturé qu'une facture de solde déduit. Une table plutôt
-- qu'une colonne parce qu'un chantier peut porter deux acomptes, et une ligne de
-- déduction négative aurait rompu la règle « un montant est toujours positif ».
CREATE TABLE IF NOT EXISTS ft_invoicing_deductions (
    id               INT    NOT NULL AUTO_INCREMENT,
    doc_id           INT    NOT NULL,
    workspace_id     INT    NOT NULL,
    deducted_doc_id  INT    NOT NULL,
    amount           BIGINT NOT NULL,
    created          BIGINT NOT NULL,
    PRIMARY KEY (id),
    -- Un acompte ne se déduit qu'une fois du même solde.
    UNIQUE KEY uniq_ft_invoicing_deductions_pair (doc_id, deducted_doc_id),
    KEY idx_ft_invoicing_deductions_src (deducted_doc_id),
    KEY idx_ft_invoicing_deductions_ws (workspace_id),
    CONSTRAINT fk_ft_invoicing_deductions_doc FOREIGN KEY (doc_id)
        REFERENCES ft_invoicing_docs (id) ON DELETE CASCADE,
    CONSTRAINT fk_ft_invoicing_deductions_src FOREIGN KEY (deducted_doc_id)
        REFERENCES ft_invoicing_docs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
