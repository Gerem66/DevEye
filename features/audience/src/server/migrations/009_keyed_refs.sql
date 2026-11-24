-- Les condenses du module passent sous cle (keys.ref) : 32 caracteres au lieu
-- de 16. L'etape de donnees 001-keyed-refs recalcule ensuite chaque ligne.
--
-- Rejouable : une colonne garde le type qu'on lui redonne.
ALTER TABLE audience_sites MODIFY name_ref CHAR(32) NOT NULL;
ALTER TABLE audience_funnels MODIFY name_ref CHAR(32) NOT NULL;
ALTER TABLE audience_funnel_steps MODIFY label_ref CHAR(32) NOT NULL;
ALTER TABLE audience_labels MODIFY label_ref CHAR(32) NOT NULL;
ALTER TABLE ft_audience_forms MODIFY name_ref CHAR(32) NOT NULL;
ALTER TABLE ft_audience_form_labels MODIFY label_ref CHAR(32) NOT NULL;
