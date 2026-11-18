BEGIN;
ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS provider_message_id text;
ALTER TABLE communication_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_communication_messages_provider_status ON communication_messages(school_id,provider,status,created_at);
COMMIT;
