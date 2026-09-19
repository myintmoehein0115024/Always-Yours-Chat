-- Run this ONCE in D1 Console for the existing always-yours-chat database.
ALTER TABLE messages ADD COLUMN media_key TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_room_expires_created ON messages (room_id, expires_at, created_at);
