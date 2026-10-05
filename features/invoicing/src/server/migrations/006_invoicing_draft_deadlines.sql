-- Un brouillon porte toujours sa date limite : valid_until pour un devis,
-- due_on pour une facture ou un avoir. Ceux qui n'en ont pas la reçoivent
-- comme un brouillon neuf, aujourd'hui plus le délai du client, sinon celui de
-- l'espace, sinon les 30 jours du réglage par défaut.
--
-- Rejouable : seules les dates encore NULL sont touchées.

UPDATE ft_invoicing_docs d
LEFT JOIN ft_invoicing_settings s ON s.workspace_id = d.workspace_id
SET d.valid_until = DATE_ADD(CURDATE(), INTERVAL COALESCE(s.quote_validity_days, 30) DAY)
WHERE d.status = 'draft' AND d.kind = 'quote' AND d.valid_until IS NULL;

UPDATE ft_invoicing_docs d
LEFT JOIN ft_invoicing_settings s ON s.workspace_id = d.workspace_id
LEFT JOIN ft_invoicing_clients c ON c.id = d.client_id AND c.workspace_id = d.workspace_id
SET d.due_on = DATE_ADD(CURDATE(), INTERVAL COALESCE(c.payment_terms_days, s.payment_terms_days, 30) DAY)
WHERE d.status = 'draft' AND d.kind <> 'quote' AND d.due_on IS NULL;
