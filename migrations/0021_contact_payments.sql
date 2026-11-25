-- Pagos por cliente, en el historial del contacto. Solo aditivo: tabla nueva e índices.
-- Sin DROP, DELETE, UPDATE ni RENAME.

CREATE TABLE IF NOT EXISTS contact_payments (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (currency IN ('ARS', 'USD')),
  occurred_at TEXT NOT NULL,
  concept TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contact_payments_user_contact
  ON contact_payments(user_id, contact_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_payments_user_date
  ON contact_payments(user_id, occurred_at DESC);
