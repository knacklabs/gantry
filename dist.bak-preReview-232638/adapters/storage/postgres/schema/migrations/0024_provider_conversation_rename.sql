-- Provider/conversation terminology cutover.
--
-- Historical migrations are immutable. Existing local databases may have
-- already applied the channel-named tables and columns; fresh databases apply
-- those historical migrations first and then this single forward rename.

DO $$
BEGIN
  IF to_regclass('channel_providers') IS NOT NULL
     AND to_regclass('providers') IS NULL THEN
    ALTER TABLE channel_providers RENAME TO providers;
  END IF;

  IF to_regclass('channel_installations') IS NOT NULL
     AND to_regclass('provider_connections') IS NULL THEN
    ALTER TABLE channel_installations RENAME TO provider_connections;
  END IF;

  IF to_regclass('channel_conversations') IS NOT NULL
     AND to_regclass('conversations') IS NULL THEN
    ALTER TABLE channel_conversations RENAME TO conversations;
  END IF;

  IF to_regclass('agent_channel_bindings') IS NOT NULL
     AND to_regclass('agent_conversation_bindings') IS NULL THEN
    ALTER TABLE agent_channel_bindings RENAME TO agent_conversation_bindings;
  END IF;

  IF to_regclass('channel_control_approvers') IS NOT NULL
     AND to_regclass('conversation_approvers') IS NULL THEN
    ALTER TABLE channel_control_approvers RENAME TO conversation_approvers;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_aliases'
      AND column_name = 'channel_installation_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_aliases'
      AND column_name = 'provider_connection_id'
  ) THEN
    ALTER TABLE user_aliases
      RENAME COLUMN channel_installation_id TO provider_connection_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'conversations'
      AND column_name = 'channel_installation_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'conversations'
      AND column_name = 'provider_connection_id'
  ) THEN
    ALTER TABLE conversations
      RENAME COLUMN channel_installation_id TO provider_connection_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_conversation_bindings'
      AND column_name = 'channel_installation_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'agent_conversation_bindings'
      AND column_name = 'provider_connection_id'
  ) THEN
    ALTER TABLE agent_conversation_bindings
      RENAME COLUMN channel_installation_id TO provider_connection_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'messages'
      AND column_name = 'channel_provider'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'messages'
      AND column_name = 'provider'
  ) THEN
    ALTER TABLE messages RENAME COLUMN channel_provider TO provider;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'messages'
      AND column_name = 'channel_installation_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'messages'
      AND column_name = 'provider_connection_id'
  ) THEN
    ALTER TABLE messages
      RENAME COLUMN channel_installation_id TO provider_connection_id;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('idx_channel_installations_provider') IS NOT NULL
     AND to_regclass('idx_provider_connections_provider') IS NULL THEN
    ALTER INDEX idx_channel_installations_provider
      RENAME TO idx_provider_connections_provider;
  END IF;

  IF to_regclass('idx_channel_conversations_installation') IS NOT NULL
     AND to_regclass('idx_conversations_provider_connection') IS NULL THEN
    ALTER INDEX idx_channel_conversations_installation
      RENAME TO idx_conversations_provider_connection;
  END IF;

  IF to_regclass('idx_agent_channel_bindings_conversation') IS NOT NULL
     AND to_regclass('idx_agent_conversation_bindings_conversation') IS NULL THEN
    ALTER INDEX idx_agent_channel_bindings_conversation
      RENAME TO idx_agent_conversation_bindings_conversation;
  END IF;

  IF to_regclass('idx_agent_channel_bindings_agent_conversation') IS NOT NULL
     AND to_regclass('idx_agent_conversation_bindings_agent_conversation') IS NULL THEN
    ALTER INDEX idx_agent_channel_bindings_agent_conversation
      RENAME TO idx_agent_conversation_bindings_agent_conversation;
  END IF;

  IF to_regclass('idx_channel_control_approvers_conversation') IS NOT NULL
     AND to_regclass('idx_conversation_approvers_conversation') IS NULL THEN
    ALTER INDEX idx_channel_control_approvers_conversation
      RENAME TO idx_conversation_approvers_conversation;
  END IF;

  IF to_regclass('uniq_channel_control_approvers_user') IS NOT NULL
     AND to_regclass('uniq_conversation_approvers_user') IS NULL THEN
    ALTER INDEX uniq_channel_control_approvers_user
      RENAME TO uniq_conversation_approvers_user;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_conversations_providerconnection;
CREATE INDEX IF NOT EXISTS idx_conversations_provider_connection
  ON conversations(provider_connection_id);
