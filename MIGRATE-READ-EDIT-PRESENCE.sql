-- Run ONCE in the existing Cloudflare D1 database: always-yours-chat
-- This adds message editing snapshots, read receipts, and online presence.

CREATE TABLE IF NOT EXISTS message_edits (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  edited_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_edits_room_message
ON message_edits (room_id, message_id);

CREATE TABLE IF NOT EXISTS message_reads (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  reader TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id, reader)
);

CREATE INDEX IF NOT EXISTS idx_message_reads_room_read
ON message_reads (room_id, message_id, read_at);

CREATE TABLE IF NOT EXISTS presence (
  room_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  is_online INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_name)
);

CREATE INDEX IF NOT EXISTS idx_presence_last_seen
ON presence (last_seen);
