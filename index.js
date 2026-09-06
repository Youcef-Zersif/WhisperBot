const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlags,
  PermissionsBitField
} = require('discord.js');

const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const path = require('path');
const http = require('http');

dotenv.config();

// =====================================================
// CONFIG
// =====================================================

if (!process.env.TOKEN) {
  console.error(
    '❌ TOKEN environment variable is missing.'
  );
  process.exit(1);
}

const PORT = Number(
  process.env.PORT || 3000
);

const DATABASE_PATH =
  path.join(
    __dirname,
    'whispers.db'
  );

const PURPLE = 0x6C2BD9;

const MAX_MESSAGE_LENGTH = 2000;
const MAX_PARAGRAPHS = 3;

const PANEL_MARKER =
  'VEGAS_WHISPERS_PERMANENT_PANEL';

const BANNER_URL =
  'https://cdn.discordapp.com/attachments/1545825179895074946/1545861012815614022/file_0000000038dc8210b6ae006f111c6e65.webp';

const PSEUDOS = {
  shadow: 'Shadow',
  admirer: 'Secret Admirer',
  friendly: 'Friendly Curious'
};

const QUOTES = [
  '💬 "A whisper can change everything."',
  '💬 "Some words are meant to be whispered."',
  '💬 "In silence, we hear the loudest truths."',
  '💬 "Whispers carry the weight of secrets."',
  '💬 "The softest voice often speaks the loudest."',
  '💬 "A whisper is a secret shared."',
  '💬 "Words whispered are words remembered."',
  '💬 "Every whisper tells a story."',
  '💬 "Trust the whisper, not the shout."',
  '💬 "A whisper can heal a broken heart."'
];

// =====================================================
// UTILS
// =====================================================

function safeErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function getRandomQuote() {
  return QUOTES[
    Math.floor(
      Math.random() * QUOTES.length
    )
  ];
}

function countParagraphs(content) {
  return content
    .split(/\n\s*\n/)
    .filter(
      part =>
        part.trim().length > 0
    )
    .length;
}

function normalizeChannelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
}

function isWhisperRoom(channel) {
  if (!channel) {
    return false;
  }

  if (!channel.isTextBased()) {
    return false;
  }

  const normalized =
    normalizeChannelName(
      channel.name
    );

  return [
    'whispers',
    'vegas-whispers',
    'secret-whispers'
  ].includes(
    normalized
  );
}

function parseSessionData(session) {
  try {
    const data =
      session?.data
        ? JSON.parse(session.data)
        : {};

    if (
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data)
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

// =====================================================
// KEEP ALIVE
// =====================================================

const server =
  http.createServer(
    (req, res) => {
      res.writeHead(
        200,
        {
          'Content-Type':
            'text/plain; charset=utf-8'
        }
      );

      res.end('OK');
    }
  );

server.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `✅ Keep-alive server running on port ${PORT}`
    );
  }
);

const keepAliveTimer =
  setInterval(
    () => {
      fetch(
        `http://127.0.0.1:${PORT}/`
      )
        .then(() => {
          console.log(
            '🔄 Keep-alive ping'
          );
        })
        .catch(() => {});
    },
    180000
  );

// =====================================================
// DATABASE
// =====================================================

const db =
  new Database(
    DATABASE_PATH
  );

db.pragma(
  'journal_mode = WAL'
);

db.pragma(
  'foreign_keys = ON'
);

function tableExists(
  tableName
) {
  return !!db
    .prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
        AND name = ?
    `)
    .get(
      tableName
    );
}

function hasColumn(
  tableName,
  columnName
) {
  if (
    !tableExists(
      tableName
    )
  ) {
    return false;
  }

  return db
    .prepare(
      `PRAGMA table_info(${tableName})`
    )
    .all()
    .some(
      column =>
        column.name ===
        columnName
    );
}

function addColumnIfMissing(
  tableName,
  columnName,
  definition
) {
  if (
    !hasColumn(
      tableName,
      columnName
    )
  ) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
    );

    console.log(
      `🛠️ Added ${tableName}.${columnName}`
    );
  }
}

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      pseudo_a TEXT,
      pseudo_b TEXT,
      is_blocked BOOLEAN DEFAULT 0,
      blocked_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      content TEXT,
      status TEXT DEFAULT 'pending',
      attempts INTEGER DEFAULT 0,
      discord_message_id TEXT,
      request_id TEXT,
      action_key TEXT,
      previous_message_id INTEGER,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS active_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      state TEXT NOT NULL,
      data TEXT,
      request_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS processed_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_key TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      message_id INTEGER,
      locked_until DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whisper_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ---------------------------------------------------
  // Existing DB compatibility / migrations
  // ---------------------------------------------------

  addColumnIfMissing(
    'messages',
    'status',
    "TEXT DEFAULT 'pending'"
  );

  addColumnIfMissing(
    'messages',
    'attempts',
    'INTEGER DEFAULT 0'
  );

  addColumnIfMissing(
    'messages',
    'discord_message_id',
    'TEXT'
  );

  addColumnIfMissing(
    'messages',
    'request_id',
    'TEXT'
  );

  addColumnIfMissing(
    'messages',
    'action_key',
    'TEXT'
  );

  addColumnIfMissing(
    'messages',
    'previous_message_id',
    'INTEGER'
  );

  addColumnIfMissing(
    'active_sessions',
    'request_id',
    'TEXT'
  );

  addColumnIfMissing(
    'processed_actions',
    'status',
    "TEXT NOT NULL DEFAULT 'reserved'"
  );

  addColumnIfMissing(
    'processed_actions',
    'message_id',
    'INTEGER'
  );

  addColumnIfMissing(
    'processed_actions',
    'locked_until',
    'DATETIME'
  );

  addColumnIfMissing(
    'processed_actions',
    'updated_at',
    'DATETIME'
  );

  // Legacy migration: old sent boolean -> status.
  if (
    hasColumn(
      'messages',
      'sent'
    )
  ) {
    db.exec(`
      UPDATE messages
      SET status = CASE
        WHEN sent = 1 THEN 'sent'
        ELSE 'pending'
      END
      WHERE sent IS NOT NULL
    `);
  }

  // ---------------------------------------------------
  // IMPORTANT:
  // No recovery system.
  //
  // Sessions are temporary only.
  // When the bot restarts, old temporary sessions
  // are removed.
  //
  // Pending messages are NOT automatically delivered.
  // They are marked failed instead.
  // ---------------------------------------------------

  db.exec(`
    UPDATE messages
    SET
      status = 'failed'
    WHERE status = 'pending';

    UPDATE processed_actions
    SET
      status = 'failed',
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE status = 'reserved';

    DELETE FROM active_sessions;

    CREATE UNIQUE INDEX IF NOT EXISTS
      idx_active_session_user
      ON active_sessions(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_messages_status
      ON messages(status);

    CREATE INDEX IF NOT EXISTS
      idx_messages_request_id
      ON messages(request_id);

    CREATE INDEX IF NOT EXISTS
      idx_messages_action_key
      ON messages(action_key);

    CREATE INDEX IF NOT EXISTS
      idx_processed_actions_status
      ON processed_actions(status);
  `);

  console.log(
    '✅ Database initialization/migration completed.'
  );
}

initializeDatabase();

// =====================================================
// DISCORD CLIENT
// =====================================================

const client =
  new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.DirectMessages
    ],
    partials: [
      Partials.Channel
    ]
  });

// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription(
      'Replies Pong!'
    ),

  new SlashCommandBuilder()
    .setName('whisper')
    .setDescription(
      'Open Vegas Whispers'
    ),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription(
      'Admin commands'
    )
    .addSubcommand(
      sub =>
        sub
          .setName('find')
          .setDescription(
            'Find sender of a message'
          )
          .addStringOption(
            option =>
              option
                .setName(
                  'message_id'
                )
                .setDescription(
                  'Internal whisper message ID'
                )
                .setRequired(
                  true
                )
          )
    )
].map(
  command =>
    command.toJSON()
);

const rest =
  new REST({
    version: '10'
  }).setToken(
    process.env.TOKEN
  );

// =====================================================
// CONVERSATIONS
// =====================================================

function getConversationById(
  conversationId
) {
  return db
    .prepare(`
      SELECT *
      FROM conversations
      WHERE id = ?
    `)
    .get(
      conversationId
    );
}

function getOrCreateConversation(
  userA,
  userB
) {
  const existing =
    db
      .prepare(`
        SELECT *
        FROM conversations
        WHERE
          (
            user_a_id = ?
            AND user_b_id = ?
          )
          OR
          (
            user_a_id = ?
            AND user_b_id = ?
          )
        ORDER BY id ASC
        LIMIT 1
      `)
      .get(
        userA,
        userB,
        userB,
        userA
      );

  if (existing) {
    if (
      existing.is_blocked
    ) {
      throw new Error(
        'This conversation is blocked.'
      );
    }

    return existing;
  }

  const [
    a,
    b
  ] = [
    userA,
    userB
  ].sort();

  const result =
    db
      .prepare(`
        INSERT INTO conversations (
          user_a_id,
          user_b_id
        )
        VALUES (?, ?)
      `)
      .run(
        a,
        b
      );

  return getConversationById(
    result.lastInsertRowid
  );
}

function getOtherParticipant(
  conversation,
  userId
) {
  if (
    conversation.user_a_id ===
    userId
  ) {
    return conversation.user_b_id;
  }

  if (
    conversation.user_b_id ===
    userId
  ) {
    return conversation.user_a_id;
  }

  return null;
}

function getUserPseudo(
  conversation,
  userId
) {
  if (
    conversation.user_a_id ===
    userId
  ) {
    return conversation.pseudo_a;
  }

  if (
    conversation.user_b_id ===
    userId
  ) {
    return conversation.pseudo_b;
  }

  return null;
}

function setUserPseudo(
  conversationId,
  userId,
  pseudo
) {
  const conversation =
    getConversationById(
      conversationId
    );

  if (!conversation) {
    throw new Error(
      'Conversation not found.'
    );
  }

  if (
    conversation.user_a_id ===
    userId
  ) {
    db.prepare(`
      UPDATE conversations
      SET pseudo_a = ?
      WHERE id = ?
        AND user_a_id = ?
    `).run(
      pseudo,
      conversationId,
      userId
    );

    return;
  }

  if (
    conversation.user_b_id ===
    userId
  ) {
    db.prepare(`
      UPDATE conversations
      SET pseudo_b = ?
      WHERE id = ?
        AND user_b_id = ?
    `).run(
      pseudo,
      conversationId,
      userId
    );

    return;
  }

  throw new Error(
    'Not a conversation participant.'
  );
}

function blockConversation(
  conversationId,
  userId
) {
  const conversation =
    getConversationById(
      conversationId
    );

  if (!conversation) {
    throw new Error(
      'Conversation not found.'
    );
  }

  if (
    !getOtherParticipant(
      conversation,
      userId
    )
  ) {
    throw new Error(
      'Not a participant.'
    );
  }

  if (
    conversation.is_blocked
  ) {
    return false;
  }

  const result =
    db
      .prepare(`
        UPDATE conversations
        SET
          is_blocked = 1,
          blocked_by = ?
        WHERE
          id = ?
          AND is_blocked = 0
      `)
      .run(
        userId,
        conversationId
      );

  return (
    result.changes > 0
  );
}

// =====================================================
// MESSAGES
// =====================================================

function getPreviousMessage(
  conversationId
) {
  return db
    .prepare(`
      SELECT *
      FROM messages
      WHERE
        conversation_id = ?
        AND status = 'sent'
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(
      conversationId
    );
}

function getMessageById(
  messageId
) {
  return db
    .prepare(`
      SELECT *
      FROM messages
      WHERE id = ?
    `)
    .get(
      messageId
    );
}

function getMessageByRequestId(
  requestId
) {
  if (!requestId) {
    return null;
  }

  return db
    .prepare(`
      SELECT *
      FROM messages
      WHERE request_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(
      requestId
    );
}

function createPendingMessage({
  conversationId,
  senderId,
  receiverId,
  content,
  requestId,
  actionKey
}) {
  const existing =
    getMessageByRequestId(
      requestId
    );

  if (existing) {
    return existing;
  }

  const previous =
    getPreviousMessage(
      conversationId
    );

  const result =
    db
      .prepare(`
        INSERT INTO messages (
          conversation_id,
          sender_id,
          receiver_id,
          content,
          status,
          attempts,
          request_id,
          action_key,
          previous_message_id
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          'pending',
          0,
          ?,
          ?,
          ?
        )
      `)
      .run(
        conversationId,
        senderId,
        receiverId,
        content,
        requestId,
        actionKey,
        previous?.id ?? null
      );

  return getMessageById(
    result.lastInsertRowid
  );
}

function markMessageSent(
  messageId,
  discordMessageId
) {
  db.prepare(`
    UPDATE messages
    SET
      status = 'sent',
      discord_message_id = ?
    WHERE id = ?
  `).run(
    discordMessageId || null,
    messageId
  );
}

function markMessageFailed(
  messageId
) {
  db.prepare(`
    UPDATE messages
    SET status = 'failed'
    WHERE id = ?
  `).run(
    messageId
  );
}

function incrementAttempts(
  messageId
) {
  const row =
    db
      .prepare(`
        UPDATE messages
        SET attempts = attempts + 1
        WHERE id = ?
        RETURNING attempts
      `)
      .get(
        messageId
      );

  return row?.attempts || 0;
}

function getConversationHistory(
  conversationId,
  limit = 10
) {
  return db
    .prepare(`
      SELECT
        sender_id,
        content,
        sent_at
      FROM messages
      WHERE
        conversation_id = ?
        AND status = 'sent'
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(
      conversationId,
      limit
    )
    .reverse();
}

// =====================================================
// IDEMPOTENCE
// =====================================================

function reserveAction(
  actionKey,
  userId
) {
  if (!actionKey) {
    return true;
  }

  const existing =
    db
      .prepare(`
        SELECT *
        FROM processed_actions
        WHERE action_key = ?
      `)
      .get(
        actionKey
      );

  if (!existing) {
    try {
      db
        .prepare(`
          INSERT INTO processed_actions (
            action_key,
            user_id,
            status,
            locked_until
          )
          VALUES (
            ?,
            ?,
            'reserved',
            datetime('now', '+60 seconds')
          )
        `)
        .run(
          actionKey,
          userId
        );

      return true;
    } catch (error) {
      if (
        safeErrorMessage(error)
          .includes(
            'UNIQUE constraint failed'
          )
      ) {
        return false;
      }

      throw error;
    }
  }

  if (
    existing.status ===
    'completed'
  ) {
    return false;
  }

  const result =
    db
      .prepare(`
        UPDATE processed_actions
        SET
          status = 'reserved',
          user_id = ?,
          locked_until =
            datetime('now', '+60 seconds'),
          updated_at =
            CURRENT_TIMESTAMP
        WHERE
          action_key = ?
          AND (
            status = 'failed'
            OR (
              status = 'reserved'
              AND (
                locked_until IS NULL
                OR locked_until <= CURRENT_TIMESTAMP
              )
            )
          )
      `)
      .run(
        userId,
        actionKey
      );

  return (
    result.changes > 0
  );
}

function linkActionToMessage(
  actionKey,
  messageId
) {
  if (!actionKey) {
    return;
  }

  db.prepare(`
    UPDATE processed_actions
    SET
      message_id = ?,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(
    messageId,
    actionKey
  );
}

function completeAction(
  actionKey
) {
  if (!actionKey) {
    return;
  }

  db.prepare(`
    UPDATE processed_actions
    SET
      status = 'completed',
      locked_until = NULL,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(
    actionKey
  );
}

function failAction(
  actionKey
) {
  if (!actionKey) {
    return;
  }

  db.prepare(`
    UPDATE processed_actions
    SET
      status = 'failed',
      locked_until = NULL,
      updated_at =
        CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(
    actionKey
  );
}

// =====================================================
// TEMPORARY SESSIONS
// =====================================================

function saveSession(
  userId,
  channelId,
  messageId,
  state,
  data,
  requestId
) {
  if (
    !userId ||
    !channelId ||
    !messageId ||
    !requestId
  ) {
    throw new Error(
      'Invalid session reference.'
    );
  }

  db.transaction(
    () => {
      db.prepare(`
        DELETE FROM active_sessions
        WHERE user_id = ?
      `).run(
        userId
      );

      db.prepare(`
        INSERT INTO active_sessions (
          user_id,
          channel_id,
          message_id,
          state,
          data,
          request_id,
          updated_at
        )
        VALUES (
          ?,
          ?,
          ?,
          ?,
          ?,
          ?,
          CURRENT_TIMESTAMP
        )
      `).run(
        userId,
        String(channelId),
        String(messageId),
        state,
        JSON.stringify(
          data || {}
        ),
        requestId
      );
    }
  )();
}

function getSession(
  userId
) {
  return db
    .prepare(`
      SELECT *
      FROM active_sessions
      WHERE user_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(
      userId
    );
}

function deleteSession(
  userId
) {
  db.prepare(`
    DELETE FROM active_sessions
    WHERE user_id = ?
  `).run(
    userId
  );
}

// =====================================================
// MEMBER CACHE
// =====================================================

const memberCache =
  new Map();

async function getCachedMembers(
  guild,
  excludedUserId
) {
  if (!guild) {
    return [];
  }

  const cached =
    memberCache.get(
      guild.id
    );

  const now =
    Date.now();

  if (
    cached &&
    now - cached.updatedAt <
      60000
  ) {
    return cached.members.filter(
      member =>
        member.id !==
        excludedUserId
    );
  }

  try {
    await guild.members.fetch();

    const members =
      guild.members.cache
        .filter(
          member =>
            !member.user.bot
        )
        .map(
          member => ({
            id:
              member.user.id,
            username:
              member.user.username,
            displayName:
              member.displayName ||
              member.user.username
          })
        );

    memberCache.set(
      guild.id,
      {
        members,
        updatedAt: now
      }
    );

    return members.filter(
      member =>
        member.id !==
        excludedUserId
    );
  } catch (error) {
    console.error(
      '❌ Member fetch error:',
      safeErrorMessage(error)
    );

    return (
      cached?.members ||
      []
    ).filter(
      member =>
        member.id !==
        excludedUserId
    );
  }
}

function searchMembers(
  members,
  query
) {
  const normalized =
    query
      .trim()
      .toLowerCase();

  if (!normalized) {
    return members.slice(
      0,
      25
    );
  }

  return members
    .filter(
      member =>
        member.displayName
          .toLowerCase()
          .includes(
            normalized
          ) ||
        member.username
          .toLowerCase()
          .includes(
            normalized
          ) ||
        member.id.includes(
          normalized
        )
    )
    .slice(
      0,
      25
    );
}

async function resolveTargetMember(
  guild,
  targetId,
  senderId
) {
  if (!guild) {
    throw new Error(
      'This action must be used inside a whisper room.'
    );
  }

  if (
    targetId ===
    senderId
  ) {
    throw new Error(
      'You cannot whisper yourself.'
    );
  }

  const member =
    await guild.members
      .fetch(
        targetId
      )
      .catch(
        () => null
      );

  if (!member) {
    throw new Error(
      'User not found in this server.'
    );
  }

  if (member.user.bot) {
    throw new Error(
      'You cannot whisper a bot.'
    );
  }

  return member;
}

// =====================================================
// PERMANENT PANEL
// =====================================================

function buildPermanentPanel() {
  const embed =
    new EmbedBuilder()
      .setColor(
        PURPLE
      )
      .setImage(
        BANNER_URL
      )
      .setTitle(
        '💋 Vegas Whispers'
      )
      .setDescription(
        [
          'Send an anonymous whisper to another member.',
          '',
          '🔎 Search by **name, nickname or Discord ID**.',
          '🌙 Choose your anonymous identity.',
          '✍️ Write your message.',
          '',
          'Your identity remains hidden from the recipient.'
        ].join('\n')
      )
      .addFields({
        name:
          '💬 Quote',
        value:
          getRandomQuote(),
        inline:
          false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            'vw_open_whisper'
          )
          .setLabel(
            '💋 Send a Whisper'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  return {
    content:
      PANEL_MARKER,
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

function buildMemberPanel(
  requestId,
  members,
  searchQuery = ''
) {
  const results =
    searchMembers(
      members,
      searchQuery
    );

  const embed =
    new EmbedBuilder()
      .setColor(
        PURPLE
      )
      .setImage(
        BANNER_URL
      )
      .setTitle(
        '💋 Vegas Whispers'
      )
      .setDescription(
        [
          'Choose the person who deserves your whisper.',
          '',
          '🔎 Search by **name, nickname or Discord ID**.'
        ].join('\n')
      )
      .addFields({
        name:
          '💬 Quote',
        value:
          getRandomQuote(),
        inline:
          false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      });

  if (searchQuery) {
    embed.addFields({
      name:
        '🔎 Current search',
      value:
        `\`${searchQuery.slice(0, 100)}\``,
      inline:
        false
    });
  }

  const components = [];

  components.push(
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `vw_search_${requestId}`
          )
          .setLabel(
            '🔎 Search Member'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      )
  );

  if (results.length) {
    components.push(
      new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(
              `vw_recipient_${requestId}`
            )
            .setPlaceholder(
              searchQuery
                ? 'Select a search result...'
                : 'Select a member...'
            )
            .addOptions(
              results.map(
                member =>
                  new StringSelectMenuOptionBuilder()
                    .setLabel(
                      (
                        member.displayName ||
                        member.username
                      ).slice(
                        0,
                        100
                      )
                    )
                    .setDescription(
                      `@${member.username}`.slice(
                        0,
                        100
                      )
                    )
                    .setValue(
                      member.id
                    )
              )
            )
        )
    );
  } else {
    embed.addFields({
      name:
        '⚠️ Result',
      value:
        'No matching member found.',
      inline:
        false
    });
  }

  components.push(
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `vw_cancel_${requestId}`
          )
          .setLabel(
            'Cancel'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      )
  );

  return {
    embeds: [
      embed
    ],
    components
  };
}

function buildPseudoPanel(
  targetDisplayName,
  targetId,
  requestId
) {
  const embed =
    new EmbedBuilder()
      .setColor(
        PURPLE
      )
      .setImage(
        BANNER_URL
      )
      .setTitle(
        '🌙 Choose Your Identity'
      )
      .setDescription(
        [
          `You are about to whisper to **${targetDisplayName}**.`,
          '',
          'Choose one identity for this conversation.'
        ].join('\n')
      )
      .addFields({
        name:
          '💬 Quote',
        value:
          getRandomQuote(),
        inline:
          false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      });

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `vw_pseudo_${targetId}_${requestId}_shadow`
          )
          .setLabel(
            '👤 Shadow'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            `vw_pseudo_${targetId}_${requestId}_admirer`
          )
          .setLabel(
            '❤️ Secret Admirer'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            `vw_pseudo_${targetId}_${requestId}_friendly`
          )
          .setLabel(
            '🤝 Friendly Curious'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

function buildWritingPanel(
  targetDisplayName,
  targetId,
  requestId
) {
  const embed =
    new EmbedBuilder()
      .setColor(
        PURPLE
      )
      .setImage(
        BANNER_URL
      )
      .setTitle(
        `💌 A secret for ${targetDisplayName}...`
      )
      .setDescription(
        [
          '✍️ Write your anonymous message.',
          '',
          '**Rules:**',
          '• Maximum **3 paragraphs**',
          '• Maximum **2000 characters**'
        ].join('\n')
      )
      .addFields({
        name:
          '💬 Quote',
        value:
          getRandomQuote(),
        inline:
          false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      });

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `vw_open_modal_${targetId}_${requestId}`
          )
          .setLabel(
            '✍️ Write Message'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  return {
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

// =====================================================
// SEARCH MODAL
// =====================================================

function buildSearchModal(
  requestId
) {
  return new ModalBuilder()
    .setCustomId(
      `vw_search_modal_${requestId}`
    )
    .setTitle(
      '🔎 Search Member'
    )
    .addComponents(
      new ActionRowBuilder()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'member_query'
            )
            .setLabel(
              'Name, nickname or Discord ID'
            )
            .setStyle(
              TextInputStyle.Short
            )
            .setPlaceholder(
              'Example: Alex or 123456789'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              100
            )
        )
    );
}

// =====================================================
// MESSAGE MODAL
// =====================================================

function buildMessageModal(
  targetId,
  requestId
) {
  return new ModalBuilder()
    .setCustomId(
      `vw_message_modal_${targetId}_${requestId}`
    )
    .setTitle(
      '✍️ Your Whisper'
    )
    .addComponents(
      new ActionRowBuilder()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'whisper_content'
            )
            .setLabel(
              'Anonymous message'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Write your message here...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              MAX_MESSAGE_LENGTH
            )
        )
    );
}

// =====================================================
// REPLY MODAL
// =====================================================

function buildReplyModal(
  messageId
) {
  return new ModalBuilder()
    .setCustomId(
      `vw_reply_modal_${messageId}`
    )
    .setTitle(
      '💬 Reply'
    )
    .addComponents(
      new ActionRowBuilder()
        .addComponents(
          new TextInputBuilder()
            .setCustomId(
              'reply_content'
            )
            .setLabel(
              'Your anonymous reply'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Write your reply...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              MAX_MESSAGE_LENGTH
            )
        )
    );
}

// =====================================================
// DM PAYLOAD
// =====================================================

function buildWhisperPayload(
  message,
  conversation
) {
  const pseudo =
    getUserPseudo(
      conversation,
      message.sender_id
    ) ||
    'Anonymous';

  const previous =
    message.previous_message_id
      ? getMessageById(
          message.previous_message_id
        )
      : null;

  const embed =
    new EmbedBuilder()
      .setColor(
        PURPLE
      )
      .setImage(
        BANNER_URL
      )
      .setAuthor({
        name:
          `💬 ${pseudo}`
      })
      .setDescription(
        message.content ||
        ''
      )
      .setFooter({
        text:
          `Vegas Whispers • Message #${message.id}`
      })
      .setTimestamp();

  if (previous) {
    const previousPseudo =
      getUserPseudo(
        conversation,
        previous.sender_id
      ) ||
      'Anonymous';

    const preview =
      (previous.content || '')
        .length > 100
        ? `${previous.content.slice(0, 100)}...`
        : previous.content || '';

    embed.addFields({
      name:
        '📜 Previous message',
      value:
        `**${previousPseudo}:** ${preview}`
    });
  }

  const row =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `vw_reply_${message.id}`
          )
          .setLabel(
            '💬 Reply'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            `vw_block_${conversation.id}`
          )
          .setLabel(
            '🚫 Block Sender'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            `vw_history_${conversation.id}`
          )
          .setLabel(
            '📜 History'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  return {
    content:
      '👋 **You received a whisper:**',
    embeds: [
      embed
    ],
    components: [
      row
    ]
  };
}

// =====================================================
// DELIVERY
// =====================================================

async function findExistingDiscordDelivery(
  message,
  targetUser
) {
  try {
    const dm =
      await targetUser.createDM();

    const recent =
      await dm.messages.fetch({
        limit: 50
      });

    const expected =
      `vw_reply_${message.id}`;

    return (
      recent.find(
        dmMessage => {
          if (
            dmMessage.author?.id !==
            client.user?.id
          ) {
            return false;
          }

          return (
            dmMessage.components?.some(
              row =>
                row.components?.some(
                  component =>
                    component.customId ===
                    expected
                )
            ) || false
          );
        }
      ) || null
    );
  } catch (error) {
    console.error(
      `⚠️ Delivery check failed for #${message.id}:`,
      safeErrorMessage(error)
    );

    return null;
  }
}

async function deliverMessage(
  messageId
) {
  const message =
    getMessageById(
      messageId
    );

  if (!message) {
    throw new Error(
      'Message not found.'
    );
  }

  if (
    message.status ===
    'sent'
  ) {
    return {
      status:
        'sent',
      discordMessageId:
        message.discord_message_id
    };
  }

  if (
    message.status ===
    'failed'
  ) {
    return {
      status:
        'failed'
    };
  }

  const conversation =
    getConversationById(
      message.conversation_id
    );

  if (
    !conversation ||
    conversation.is_blocked
  ) {
    markMessageFailed(
      message.id
    );

    failAction(
      message.action_key
    );

    return {
      status:
        'failed'
    };
  }

  const target =
    await client.users.fetch(
      message.receiver_id
    );

  /*
    Check whether Discord already received
    the message before a possible crash.
    This is NOT a recovery system.
    It is only duplicate protection for the
    current send operation.
  */
  const existing =
    await findExistingDiscordDelivery(
      message,
      target
    );

  if (existing) {
    markMessageSent(
      message.id,
      existing.id
    );

    completeAction(
      message.action_key
    );

    return {
      status:
        'sent',
      discordMessageId:
        existing.id
    };
  }

  incrementAttempts(
    message.id
  );

  try {
    const payload =
      buildWhisperPayload(
        message,
        conversation
      );

    const sent =
      await target.send(
        payload
      );

    markMessageSent(
      message.id,
      sent.id
    );

    completeAction(
      message.action_key
    );

    console.log(
      `✅ Delivered whisper #${message.id}`
    );

    return {
      status:
        'sent',
      discordMessageId:
        sent.id
    };
  } catch (error) {
    markMessageFailed(
      message.id
    );

    failAction(
      message.action_key
    );

    console.error(
      `❌ Delivery failed for #${message.id}:`,
      safeErrorMessage(error)
    );

    throw error;
  }
}

// =====================================================
// FAILURE HANDLER
// =====================================================

async function failCurrentSession(
  interaction,
  message = null
) {
  if (message) {
    markMessageFailed(
      message.id
    );

    failAction(
      message.action_key
    );
  }

  deleteSession(
    interaction.user.id
  );

  const content =
    '❌ Le message n’a pas pu être envoyé. Veuillez réessayer.';

  try {
    if (
      interaction.deferred ||
      interaction.replied
    ) {
      await interaction.editReply({
        content,
        embeds: [],
        components: []
      });
    } else {
      await interaction.reply({
        content,
        flags:
          MessageFlags.Ephemeral
      });
    }
  } catch (error) {
    console.error(
      '❌ Could not display failure message:',
      safeErrorMessage(error)
    );
  }
}

// =====================================================
// PERMANENT PANELS
// =====================================================

async function findPermanentPanels(
  channel
) {
  try {
    const messages =
      await channel.messages.fetch({
        limit: 100
      });

    return messages.filter(
      message => {
        if (
          message.author?.id !==
          client.user?.id
        ) {
          return false;
        }

        if (
          message.content ===
          PANEL_MARKER
        ) {
          return true;
        }

        return message.components?.some(
          row =>
            row.components?.some(
              component =>
                component.customId ===
                'vw_open_whisper'
            )
        );
      }
    );
  } catch (error) {
    console.error(
      `❌ Could not inspect #${channel.name}:`,
      safeErrorMessage(error)
    );

    return new Map();
  }
}

async function ensurePermanentPanel(
  channel
) {
  if (
    !isWhisperRoom(channel)
  ) {
    return;
  }

  const panel =
    buildPermanentPanel();

  try {
    const stored =
      db.prepare(`
        SELECT *
        FROM whisper_panels
        WHERE channel_id = ?
      `).get(
        channel.id
      );

    let panelMessage =
      null;

    if (stored) {
      panelMessage =
        await channel.messages
          .fetch(
            stored.message_id
          )
          .catch(
            () => null
          );
    }

    /*
      If the stored message is gone,
      search recent messages before
      creating a new one.
    */
    if (!panelMessage) {
      const messages =
        await channel.messages.fetch({
          limit: 100
        });

      panelMessage =
        messages.find(
          message => {
            if (
              message.author?.id !==
              client.user?.id
            ) {
              return false;
            }

            return (
              message.content ===
              PANEL_MARKER ||
              message.components?.some(
                row =>
                  row.components?.some(
                    component =>
                      component.customId ===
                      'vw_open_whisper'
                  )
              )
            );
          }
        ) || null;
    }

    /*
      More than one permanent panel should
      never exist in a room.
      Keep the oldest valid one and delete
      duplicate bot panels.
    */
    if (panelMessage) {
      const messages =
        await channel.messages
          .fetch({
            limit: 100
          })
          .catch(
            () => null
          );

      if (messages) {
        const duplicates =
          messages.filter(
            message =>
              message.id !==
              panelMessage.id &&
              message.author?.id ===
                client.user?.id &&
              (
                message.content ===
                PANEL_MARKER ||
                message.components?.some(
                  row =>
                    row.components?.some(
                      component =>
                        component.customId ===
                        'vw_open_whisper'
                    )
                )
              )
          );

        for (
          const duplicate
            of duplicates.values()
        ) {
          await duplicate
            .delete()
            .catch(
              () => {}
            );
        }
      }

      await panelMessage.edit(
        panel
      );

      db.prepare(`
        INSERT INTO whisper_panels (
          guild_id,
          channel_id,
          message_id,
          updated_at
        )
        VALUES (
          ?,
          ?,
          ?,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(channel_id)
        DO UPDATE SET
          guild_id =
            excluded.guild_id,
          message_id =
            excluded.message_id,
          updated_at =
            CURRENT_TIMESTAMP
      `).run(
        channel.guild.id,
        channel.id,
        panelMessage.id
      );

      console.log(
        `✅ Permanent Vegas Whispers panel ready in #${channel.name}`
      );

      return;
    }

    const newMessage =
      await channel.send(
        panel
      );

    db.prepare(`
      INSERT INTO whisper_panels (
        guild_id,
        channel_id,
        message_id,
        updated_at
      )
      VALUES (
        ?,
        ?,
        ?,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT(channel_id)
      DO UPDATE SET
        guild_id =
          excluded.guild_id,
        message_id =
          excluded.message_id,
        updated_at =
          CURRENT_TIMESTAMP
    `).run(
      channel.guild.id,
      channel.id,
      newMessage.id
    );

    console.log(
      `✅ Permanent Vegas Whispers panel created in #${channel.name}`
    );
  } catch (error) {
    console.error(
      `❌ Could not ensure permanent panel in #${channel.name}:`,
      safeErrorMessage(error)
    );
  }
}

async function ensureAllPermanentPanels() {
  for (
    const guild
      of client.guilds.cache.values()
  ) {
    const channels =
      guild.channels.cache.filter(
        channel =>
          isWhisperRoom(
            channel
          )
      );

    for (
      const channel
        of channels.values()
    ) {
      await ensurePermanentPanel(
        channel
      );
    }
  }
}

// =====================================================
// PANEL DELETION RECOVERY
// =====================================================

client.on(
  'messageDelete',
  async message => {
    try {
      if (
        message.author?.id !==
        client.user?.id
      ) {
        return;
      }

      const stored =
        db.prepare(`
          SELECT *
          FROM whisper_panels
          WHERE channel_id = ?
            AND message_id = ?
        `).get(
          message.channel?.id,
          message.id
        );

      if (!stored) {
        return;
      }

      const channel =
        await client.channels
          .fetch(
            stored.channel_id
          )
          .catch(
            () => null
          );

      if (
        channel &&
        isWhisperRoom(channel)
      ) {
        console.log(
          `🔄 Permanent panel deleted in #${channel.name}. Recreating...`
        );

        await ensurePermanentPanel(
          channel
        );
      }
    } catch (error) {
      console.error(
        '❌ Permanent panel recreation error:',
        safeErrorMessage(error)
      );
    }
  }
);

// =====================================================
// INTERACTION HANDLER
// =====================================================

client.on(
  'interactionCreate',
  async interaction => {
    try {

      // =================================================
      // SLASH COMMANDS
      // =================================================

      if (
        interaction.isChatInputCommand()
      ) {

        // -----------------------------------------------
        // PING
        // -----------------------------------------------

        if (
          interaction.commandName ===
          'ping'
        ) {
          await interaction.reply({
            content:
              '🏓 Pong!',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        // -----------------------------------------------
        // WHISPER
        // -----------------------------------------------

        if (
          interaction.commandName ===
          'whisper'
        ) {
          if (
            !interaction.guild ||
            !isWhisperRoom(
              interaction.channel
            )
          ) {
            await interaction.reply({
              content:
                '❌ Use `/whisper` inside a whisper room.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          const oldSession =
            getSession(
              interaction.user.id
            );

          if (oldSession) {
            deleteSession(
              interaction.user.id
            );
          }

          await interaction.deferReply({
            flags:
              MessageFlags.Ephemeral
          });

          const requestId =
            interaction.id;

          const members =
            await getCachedMembers(
              interaction.guild,
              interaction.user.id
            );

          if (!members.length) {
            await interaction.editReply({
              content:
                '❌ No members found. Please try again.',
              embeds: [],
              components: []
            });

            return;
          }

          const panel =
            buildMemberPanel(
              requestId,
              members
            );

          const reply =
            await interaction.editReply(
              panel
            );

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            reply.id,
            'selecting_recipient',
            {
              guildId:
                interaction.guild.id,
              searchQuery:
                ''
            },
            requestId
          );

          return;
        }

        // -----------------------------------------------
        // ADMIN FIND
        // -----------------------------------------------

        if (
          interaction.commandName ===
          'admin'
        ) {
          if (
            !interaction.guild ||
            !interaction.member
              ?.permissions.has(
                PermissionsBitField.Flags.Administrator
              )
          ) {
            await interaction.reply({
              content:
                '❌ Admin only.',
              flags:
                MessageFlags.Ephemeral
            });

            return;
          }

          await interaction.deferReply({
            flags:
              MessageFlags.Ephemeral
          });

          const messageId =
            interaction.options.getString(
              'message_id',
              true
            );

          const row =
            db.prepare(`
              SELECT
                sender_id,
                content,
                sent_at,
                status
              FROM messages
              WHERE id = ?
            `).get(
              messageId
            );

          if (!row) {
            await interaction.editReply({
              content:
                '❌ Message not found.'
            });

            return;
          }

          try {
            const user =
              await client.users.fetch(
                row.sender_id
              );

            const embed =
              new EmbedBuilder()
                .setColor(
                  PURPLE
                )
                .setTitle(
                  '🔍 Message Sender'
                )
                .addFields(
                  {
                    name:
                      'User',
                    value:
                      user.tag,
                    inline:
                      true
                  },
                  {
                    name:
                      'ID',
                    value:
                      user.id,
                    inline:
                      true
                  },
                  {
                    name:
                      'Status',
                    value:
                      row.status,
                    inline:
                      true
                  },
                  {
                    name:
                      'Content',
                    value:
                      (
                        row.content ||
                        ''
                      ).slice(
                        0,
                        1024
                      ) ||
                      '(empty)',
                    inline:
                      false
                  },
                  {
                    name:
                      'Sent',
                    value:
                      new Date(
                        row.sent_at
                      ).toLocaleString(),
                    inline:
                      true
                  }
                )
                .setTimestamp();

            await interaction.editReply({
              embeds: [
                embed
              ]
            });
          } catch {
            await interaction.editReply({
              content:
                '❌ User not found.'
            });
          }

          return;
        }
      }

      // =================================================
      // OPEN FROM PERMANENT PANEL
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId ===
          'vw_open_whisper'
      ) {
        if (
          !interaction.guild ||
          !isWhisperRoom(
            interaction.channel
          )
        ) {
          await interaction.reply({
            content:
              '❌ Use the Vegas Whispers panel inside a whisper room.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const previousSession =
          getSession(
            interaction.user.id
          );

        if (previousSession) {
          /*
            No recovery.
            A new operation simply replaces
            the previous temporary one.
          */
          deleteSession(
            interaction.user.id
          );
        }

        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const requestId =
          interaction.id;

        const members =
          await getCachedMembers(
            interaction.guild,
            interaction.user.id
          );

        if (!members.length) {
          await interaction.editReply({
            content:
              '❌ No members found. Please try again.',
            embeds: [],
            components: []
          });

          return;
        }

        const panel =
          buildMemberPanel(
            requestId,
            members
          );

        const reply =
          await interaction.editReply(
            panel
          );

        saveSession(
          interaction.user.id,
          interaction.channel.id,
          reply.id,
          'selecting_recipient',
          {
            guildId:
              interaction.guild.id,
            searchQuery:
              ''
          },
          requestId
        );

        return;
      }

      // =================================================
      // SEARCH MEMBER
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_search_'
        )
      ) {
        const requestId =
          interaction.customId.slice(
            'vw_search_'.length
          );

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'selecting_recipient'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        await interaction.showModal(
          buildSearchModal(
            requestId
          )
        );

        return;
      }

      // =================================================
      // SEARCH MODAL
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'vw_search_modal_'
        )
      ) {
        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const requestId =
          interaction.customId.slice(
            'vw_search_modal_'.length
          );

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'selecting_recipient'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        if (!interaction.guild) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const query =
          interaction.fields
            .getTextInputValue(
              'member_query'
            )
            .trim();

        const members =
          await getCachedMembers(
            interaction.guild,
            interaction.user.id
          );

        const panel =
          buildMemberPanel(
            requestId,
            members,
            query
          );

        const reply =
          await interaction.editReply(
            panel
          );

        saveSession(
          interaction.user.id,
          interaction.channel.id,
          reply.id,
          'selecting_recipient',
          {
            guildId:
              interaction.guild.id,
            searchQuery:
              query
          },
          requestId
        );

        return;
      }

      // =================================================
      // RECIPIENT SELECT
      // =================================================

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith(
          'vw_recipient_'
        )
      ) {
        await interaction.deferUpdate();

        const requestId =
          interaction.customId.slice(
            'vw_recipient_'.length
          );

        const targetId =
          interaction.values[0];

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'selecting_recipient'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        try {
          const member =
            await resolveTargetMember(
              interaction.guild,
              targetId,
              interaction.user.id
            );

          const panel =
            buildPseudoPanel(
              member.displayName ||
                member.user.username,
              member.id,
              requestId
            );

          await interaction.editReply(
            panel
          );

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            interaction.message.id,
            'choosing_pseudo',
            {
              guildId:
                interaction.guild.id,
              targetId:
                member.id,
              targetDisplayName:
                member.displayName ||
                member.user.username
            },
            requestId
          );
        } catch (error) {
          console.error(
            '❌ Recipient selection error:',
            safeErrorMessage(error)
          );

          await failCurrentSession(
            interaction
          );
        }

        return;
      }

      // =================================================
      // CANCEL
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_cancel_'
        )
      ) {
        await interaction.deferUpdate();

        deleteSession(
          interaction.user.id
        );

        await interaction.editReply({
          content:
            '❌ Whisper cancelled.',
          embeds: [],
          components: []
        });

        return;
      }

      // =================================================
      // PSEUDONYM
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_pseudo_'
        )
      ) {
        await interaction.deferUpdate();

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          5
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const targetId =
          parts[2];

        const requestId =
          parts[3];

        const pseudoType =
          parts[4];

        const pseudo =
          PSEUDOS[
            pseudoType
          ];

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !pseudo ||
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'choosing_pseudo'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const data =
          parseSessionData(
            session
          );

        if (
          !data ||
          data.targetId !==
            targetId
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        try {
          const conversation =
            getOrCreateConversation(
              interaction.user.id,
              targetId
            );

          setUserPseudo(
            conversation.id,
            interaction.user.id,
            pseudo
          );

          const target =
            await client.users.fetch(
              targetId
            );

          const panel =
            buildWritingPanel(
              data.targetDisplayName ||
                target.username,
              targetId,
              requestId
            );

          await interaction.editReply(
            panel
          );

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            interaction.message.id,
            'writing_message',
            {
              guildId:
                data.guildId,
              targetId,
              targetDisplayName:
                data.targetDisplayName ||
                target.username,
              conversationId:
                conversation.id
            },
            requestId
          );
        } catch (error) {
          console.error(
            '❌ Pseudonym selection error:',
            safeErrorMessage(error)
          );

          await failCurrentSession(
            interaction
          );
        }

        return;
      }

      // =================================================
      // OPEN MESSAGE MODAL
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_open_modal_'
        )
      ) {
        const restId =
          interaction.customId.slice(
            'vw_open_modal_'.length
          );

        const separator =
          restId.lastIndexOf(
            '_'
          );

        if (
          separator <= 0
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const targetId =
          restId.slice(
            0,
            separator
          );

        const requestId =
          restId.slice(
            separator + 1
          );

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'writing_message'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const data =
          parseSessionData(
            session
          );

        if (
          !data ||
          data.targetId !==
            targetId
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        await interaction.showModal(
          buildMessageModal(
            targetId,
            requestId
          )
        );

        return;
      }

      // =================================================
      // SEND NEW WHISPER
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'vw_message_modal_'
        )
      ) {
        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const restId =
          interaction.customId.slice(
            'vw_message_modal_'.length
          );

        const separator =
          restId.lastIndexOf(
            '_'
          );

        if (
          separator <= 0
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const targetId =
          restId.slice(
            0,
            separator
          );

        const requestId =
          restId.slice(
            separator + 1
          );

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'writing_message'
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const data =
          parseSessionData(
            session
          );

        if (
          !data ||
          data.targetId !==
            targetId
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const content =
          interaction.fields
            .getTextInputValue(
              'whisper_content'
            )
            .trim();

        if (!content) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        if (
          content.length >
          MAX_MESSAGE_LENGTH
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        if (
          countParagraphs(content) >
          MAX_PARAGRAPHS
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        const actionKey =
          `send_${requestId}`;

        if (
          !reserveAction(
            actionKey,
            interaction.user.id
          )
        ) {
          await failCurrentSession(
            interaction
          );

          return;
        }

        let pendingMessage =
          null;

        try {
          const conversation =
            getOrCreateConversation(
              interaction.user.id,
              targetId
            );

          if (
            conversation.is_blocked
          ) {
            throw new Error(
              'This conversation is blocked.'
            );
          }

          /*
            The request is persisted BEFORE
            Discord delivery.
          */
          pendingMessage =
            createPendingMessage({
              conversationId:
                conversation.id,
              senderId:
                interaction.user.id,
              receiverId:
                targetId,
              content,
              requestId,
              actionKey
            });

          linkActionToMessage(
            actionKey,
            pendingMessage.id
          );

          await deliverMessage(
            pendingMessage.id
          );

          /*
            No recovery.
            The temporary session ends here.
          */
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '✅ Your anonymous whisper has been sent.',
            embeds: [],
            components: []
          });
        } catch (error) {
          console.error(
            `❌ Whisper delivery failed for request ${requestId}:`,
            safeErrorMessage(error)
          );

          await failCurrentSession(
            interaction,
            pendingMessage
          );
        }

        return;
      }

      // =================================================
      // REPLY BUTTON
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_reply_'
        )
      ) {
        const messageId =
          interaction.customId.slice(
            'vw_reply_'.length
          );

        const original =
          getMessageById(
            messageId
          );

        if (
          !original ||
          original.status !==
            'sent'
        ) {
          await interaction.reply({
            content:
              '❌ This whisper is no longer available.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          original.receiver_id !==
          interaction.user.id
        ) {
          await interaction.reply({
            content:
              '❌ You cannot reply to this whisper.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        await interaction.showModal(
          buildReplyModal(
            original.id
          )
        );

        return;
      }

      // =================================================
      // REPLY SUBMIT
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'vw_reply_modal_'
        )
      ) {
        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const messageId =
          interaction.customId.slice(
            'vw_reply_modal_'.length
          );

        const original =
          getMessageById(
            messageId
          );

        if (
          !original ||
          original.status !==
            'sent'
        ) {
          await interaction.editReply({
            content:
              '❌ This whisper is no longer available.'
          });

          return;
        }

        if (
          original.receiver_id !==
          interaction.user.id
        ) {
          await interaction.editReply({
            content:
              '❌ You cannot reply to this whisper.'
          });

          return;
        }

        const content =
          interaction.fields
            .getTextInputValue(
              'reply_content'
            )
            .trim();

        if (!content) {
          await interaction.editReply({
            content:
              '❌ Reply cannot be empty.'
          });

          return;
        }

        if (
          content.length >
          MAX_MESSAGE_LENGTH
        ) {
          await interaction.editReply({
            content:
              '❌ Maximum 2000 characters.'
          });

          return;
        }

        if (
          countParagraphs(content) >
          MAX_PARAGRAPHS
        ) {
          await interaction.editReply({
            content:
              '❌ Maximum 3 paragraphs are allowed.'
          });

          return;
        }

        const conversation =
          getConversationById(
            original.conversation_id
          );

        if (
          !conversation ||
          conversation.is_blocked
        ) {
          await interaction.editReply({
            content:
              '❌ This conversation is blocked.'
          });

          return;
        }

        const requestId =
          interaction.id;

        const actionKey =
          `reply_${requestId}`;

        if (
          !reserveAction(
            actionKey,
            interaction.user.id
          )
        ) {
          await interaction.editReply({
            content:
              '❌ The reply could not be processed. Please try again.'
          });

          return;
        }

        let pendingMessage =
          null;

        try {
          pendingMessage =
            createPendingMessage({
              conversationId:
                conversation.id,
              senderId:
                interaction.user.id,
              receiverId:
                original.sender_id,
              content,
              requestId,
              actionKey
            });

          linkActionToMessage(
            actionKey,
            pendingMessage.id
          );

          await deliverMessage(
            pendingMessage.id
          );

          await interaction.editReply({
            content:
              '✅ Your anonymous reply has been sent.',
            embeds: [],
            components: []
          });
        } catch (error) {
          console.error(
            '❌ Reply delivery failed:',
            safeErrorMessage(error)
          );

          await interaction.editReply({
            content:
              '❌ Le message n’a pas pu être envoyé. Veuillez réessayer.',
            embeds: [],
            components: []
          });

          if (pendingMessage) {
            markMessageFailed(
              pendingMessage.id
            );

            failAction(
              pendingMessage.action_key
            );
          }
        }

        return;
      }

      // =================================================
      // BLOCK
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_block_'
        )
      ) {
        const conversationId =
          interaction.customId.slice(
            'vw_block_'.length
          );

        const conversation =
          getConversationById(
            conversationId
          );

        if (!conversation) {
          await interaction.reply({
            content:
              '❌ Conversation not found.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        if (
          !getOtherParticipant(
            conversation,
            interaction.user.id
          )
        ) {
          await interaction.reply({
            content:
              '❌ You are not part of this conversation.',
            flags:
              MessageFlags.Ephemeral
          });

          return;
        }

        const row =
          new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(
                  `vw_confirm_block_${conversationId}`
                )
                .setLabel(
                  '🚫 Confirm Block'
                )
                .setStyle(
                  ButtonStyle.Danger
                ),

              new ButtonBuilder()
                .setCustomId(
                  `vw_cancel_block_${conversationId}`
                )
                .setLabel(
                  'Cancel'
                )
                .setStyle(
                  ButtonStyle.Secondary
                )
            );

        await interaction.reply({
          content:
            '⚠️ Are you sure you want to block this sender?',
          components: [
            row
          ],
          flags:
            MessageFlags.Ephemeral
        });

        return;
      }

      // =================================================
      // CONFIRM BLOCK
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_confirm_block_'
        )
      ) {
        await interaction.deferUpdate();

        const conversationId =
          interaction.customId.slice(
            'vw_confirm_block_'.length
          );

        const actionKey =
          `block_${conversationId}_${interaction.user.id}`;

        if (
          !reserveAction(
            actionKey,
            interaction.user.id
          )
        ) {
          await interaction.editReply({
            content:
              '✅ This action has already been processed.',
            components: []
          });

          return;
        }

        try {
          const conversation =
            getConversationById(
              conversationId
            );

          if (
            !conversation ||
            !getOtherParticipant(
              conversation,
              interaction.user.id
            )
          ) {
            throw new Error(
              'Not a participant.'
            );
          }

          /*
            Re-check the DB state immediately
            before blocking.
          */
          const latest =
            getConversationById(
              conversationId
            );

          if (
            latest?.is_blocked
          ) {
            completeAction(
              actionKey
            );

            await interaction.editReply({
              content:
                '🚫 This conversation is already blocked.',
              components: []
            });

            return;
          }

          blockConversation(
            conversationId,
            interaction.user.id
          );

          completeAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '🚫 This conversation has been blocked.',
            components: []
          });
        } catch (error) {
          failAction(
            actionKey
          );

          console.error(
            '❌ Block error:',
            safeErrorMessage(error)
          );

          await interaction.editReply({
            content:
              '❌ Could not block this conversation.',
            components: []
          });
        }

        return;
      }

      // =================================================
      // CANCEL BLOCK
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_cancel_block_'
        )
      ) {
        await interaction.update({
          content:
            '❎ Block cancelled.',
          components: []
        });

        return;
      }

      // =================================================
      // HISTORY
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'vw_history_'
        )
      ) {
        await interaction.deferReply({
          flags:
            MessageFlags.Ephemeral
        });

        const conversationId =
          interaction.customId.slice(
            'vw_history_'.length
          );

        const conversation =
          getConversationById(
            conversationId
          );

        if (!conversation) {
          await interaction.editReply({
            content:
              '❌ Conversation not found.'
          });

          return;
        }

        if (
          !getOtherParticipant(
            conversation,
            interaction.user.id
          )
        ) {
          await interaction.editReply({
            content:
              '❌ You cannot view this conversation.'
          });

          return;
        }

        const history =
          getConversationHistory(
            conversationId,
            10
          );

        if (!history.length) {
          await interaction.editReply({
            content:
              '📜 No previous messages.'
          });

          return;
        }

        const lines =
          history.map(
            row => {
              const pseudo =
                getUserPseudo(
                  conversation,
                  row.sender_id
                ) ||
                'Anonymous';

              return (
                `**${pseudo}:** ${(row.content || '').slice(0, 500)}`
              );
            }
          );

        const embed =
          new EmbedBuilder()
            .setColor(
              PURPLE
            )
            .setTitle(
              '📜 Vegas Whispers History'
            )
            .setDescription(
              lines.join(
                '\n\n'
              ).slice(
                0,
                4000
              )
            )
            .setTimestamp();

        await interaction.editReply({
          embeds: [
            embed
          ]
        });

        return;
      }

      // =================================================
      // OLD / INVALID BUTTON
      // =================================================

      if (
        interaction.isButton() ||
        interaction.isStringSelectMenu() ||
        interaction.isModalSubmit()
      ) {
        deleteSession(
          interaction.user.id
        );

        if (
          !interaction.replied &&
          !interaction.deferred
        ) {
          await interaction.reply({
            content:
              '❌ Cette action n’est plus valide. Utilisez le panneau Vegas Whispers pour recommencer.',
            flags:
              MessageFlags.Ephemeral
          });
        }

        return;
      }

    } catch (error) {
      console.error(
        '❌ Interaction handler error:',
        safeErrorMessage(error)
      );

      /*
        IMPORTANT:
        No recovery.
        Any temporary user operation that
        reaches an unexpected error is deleted.
      */
      deleteSession(
        interaction.user.id
      );

      try {
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply({
            content:
              '❌ Le message n’a pas pu être traité. Veuillez réessayer.',
            embeds: [],
            components: []
          });
        } else {
          await interaction.reply({
            content:
              '❌ Le message n’a pas pu être traité. Veuillez réessayer.',
            flags:
              MessageFlags.Ephemeral
          });
        }
      } catch {
        // Ignore secondary Discord response errors.
      }
    }
  }
);

// =====================================================
// STARTUP
// =====================================================

client.once(
  'ready',
  async () => {
    try {
      console.log(
        `✅ Bot online as ${client.user.tag}`
      );

      await rest.put(
        Routes.applicationCommands(
          client.user.id
        ),
        {
          body:
            commands
        }
      );

      console.log(
        '✅ Slash commands registered!'
      );

      /*
        IMPORTANT:
        No /recover.
        No unfinished-session notification.
        No pending-message recovery.

        Only permanent room panels are restored.
      */
      await ensureAllPermanentPanels();

    } catch (error) {
      console.error(
        '❌ Startup error:',
        safeErrorMessage(error)
      );
    }
  }
);

// =====================================================
// CHANNEL CREATE
// =====================================================

client.on(
  'channelCreate',
  async channel => {
    try {
      if (
        isWhisperRoom(channel)
      ) {
        await ensurePermanentPanel(
          channel
        );
      }
    } catch (error) {
      console.error(
        '❌ New whisper channel panel error:',
        safeErrorMessage(error)
      );
    }
  }
);

// =====================================================
// LOGIN
// =====================================================

client.login(
  process.env.TOKEN
);

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

function shutdown(
  signal
) {
  console.log(
    `🛑 Received ${signal}. Shutting down safely...`
  );

  clearInterval(
    keepAliveTimer
  );

  try {
    client.destroy();
  } catch {
    // Ignore.
  }

  try {
    db.close();
  } catch {
    // Ignore.
  }

  try {
    server.close(
      () => {
        process.exit(0);
      }
    );
  } catch {
    process.exit(0);
  }
}

process.on(
  'SIGTERM',
  () =>
    shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () =>
    shutdown('SIGINT')
);