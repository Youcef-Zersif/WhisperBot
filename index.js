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
  StringSelectMenuOptionBuilder
} = require('discord.js');

const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const http = require('http');

dotenv.config();

if (!process.env.TOKEN) {
  console.error('❌ TOKEN environment variable is missing.');
  process.exit(1);
}

// =====================================================
// KEEP-ALIVE
// =====================================================

const PORT = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8'
  });

  res.end('OK');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

const keepAliveTimer = setInterval(() => {
  fetch(`http://127.0.0.1:${PORT}/`)
    .then(() => console.log('🔄 Keep-alive ping'))
    .catch(() => {});
}, 180000);

// =====================================================
// DATABASE
// =====================================================

const db = new Database(
  path.join(__dirname, 'whispers.db')
);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableExists(tableName) {
  return !!db
    .prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table'
      AND name = ?
    `)
    .get(tableName);
}

function hasColumn(tableName, columnName) {
  if (!tableExists(tableName)) return false;

  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .some(column => column.name === columnName);
}

function addColumnIfMissing(
  tableName,
  columnName,
  definition
) {
  if (!hasColumn(tableName, columnName)) {
    db.exec(
      `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`
    );

    console.log(
      `🛠️ Added ${tableName}.${columnName}`
    );
  }
}

function initializeDatabase() {
  // ===================================================
  // BASE TABLES
  // ===================================================

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
      notified_at DATETIME,
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
  `);

  // ===================================================
  // MIGRATIONS
  // ===================================================

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

  // Legacy sent column migration.
  if (hasColumn('messages', 'sent')) {
    db.exec(`
      UPDATE messages
      SET status = CASE
        WHEN sent = 1 THEN 'sent'
        ELSE 'pending'
      END
      WHERE sent IS NOT NULL
    `);
  }

  addColumnIfMissing(
    'active_sessions',
    'request_id',
    'TEXT'
  );

  addColumnIfMissing(
    'active_sessions',
    'notified_at',
    'DATETIME'
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

  db.exec(`
    UPDATE processed_actions
    SET
      status = COALESCE(status, 'reserved'),
      updated_at = COALESCE(
        updated_at,
        created_at,
        CURRENT_TIMESTAMP
      );
  `);

  // One active session per user.
  db.exec(`
    DELETE FROM active_sessions
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM active_sessions
      GROUP BY user_id
    );
  `);

  // Legacy sessions without request_id.
  const oldSessions = db.prepare(`
    SELECT id
    FROM active_sessions
    WHERE request_id IS NULL
       OR request_id = ''
  `).all();

  const updateRequestId = db.prepare(`
    UPDATE active_sessions
    SET request_id = ?
    WHERE id = ?
  `);

  for (const session of oldSessions) {
    updateRequestId.run(
      crypto.randomUUID(),
      session.id
    );
  }

  db.exec(`
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
      idx_sessions_request_id
      ON active_sessions(request_id);

    CREATE INDEX IF NOT EXISTS
      idx_actions_status
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// =====================================================
// CONSTANTS
// =====================================================

const BANNER_URL =
  'https://cdn.discordapp.com/attachments/1545825179895074946/1545861012815614022/file_0000000038dc8210b6ae006f111c6e65.webp';

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

const PSEUDOS = {
  shadow: 'Shadow',
  admirer: 'Secret Admirer',
  friendly: 'Friendly Curious'
};

function getRandomQuote() {
  return QUOTES[
    Math.floor(
      Math.random() * QUOTES.length
    )
  ];
}

function safeErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
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
// COMMANDS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies Pong!'),

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
    .addSubcommand(sub =>
      sub
        .setName('find')
        .setDescription(
          'Find sender of a message'
        )
        .addStringOption(opt =>
          opt
            .setName('message_id')
            .setDescription(
              'Internal whisper message ID'
            )
            .setRequired(true)
        )
    ),

  new SlashCommandBuilder()
    .setName('recover')
    .setDescription(
      'Recover an interrupted session'
    )
].map(command =>
  command.toJSON()
);

const rest = new REST({
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
    .get(conversationId);
}

function getOrCreateConversation(
  userA,
  userB
) {
  const existing = db
    .prepare(`
      SELECT *
      FROM conversations
      WHERE
        (user_a_id = ? AND user_b_id = ?)
        OR
        (user_a_id = ? AND user_b_id = ?)
    `)
    .get(
      userA,
      userB,
      userB,
      userA
    );

  if (existing) {
    if (existing.is_blocked) {
      throw new Error(
        'Conversation is blocked'
      );
    }

    return existing;
  }

  const [a, b] =
    [userA, userB].sort();

  const result =
    db.prepare(`
      INSERT INTO conversations (
        user_a_id,
        user_b_id
      )
      VALUES (?, ?)
    `).run(a, b);

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
  const first =
    db.prepare(`
      UPDATE conversations
      SET pseudo_a = ?
      WHERE
        id = ?
        AND user_a_id = ?
        AND (
          pseudo_a IS NULL
          OR pseudo_a = ''
        )
    `).run(
      pseudo,
      conversationId,
      userId
    );

  if (first.changes > 0) {
    return true;
  }

  const second =
    db.prepare(`
      UPDATE conversations
      SET pseudo_b = ?
      WHERE
        id = ?
        AND user_b_id = ?
        AND (
          pseudo_b IS NULL
          OR pseudo_b = ''
        )
    `).run(
      pseudo,
      conversationId,
      userId
    );

  return second.changes > 0;
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
      'Conversation not found'
    );
  }

  if (
    !getOtherParticipant(
      conversation,
      userId
    )
  ) {
    throw new Error(
      'Not a participant'
    );
  }

  if (conversation.is_blocked) {
    return false;
  }

  const result =
    db.prepare(`
      UPDATE conversations
      SET
        is_blocked = 1,
        blocked_by = ?
      WHERE
        id = ?
        AND is_blocked = 0
    `).run(
      userId,
      conversationId
    );

  return result.changes > 0;
}

// =====================================================
// MESSAGES
// =====================================================

function getPreviousMessage(
  conversationId
) {
  return db.prepare(`
    SELECT
      id,
      sender_id,
      receiver_id,
      content,
      sent_at
    FROM messages
    WHERE
      conversation_id = ?
      AND status = 'sent'
    ORDER BY id DESC
    LIMIT 1
  `).get(conversationId);
}

function getMessageById(messageId) {
  return db.prepare(`
    SELECT *
    FROM messages
    WHERE id = ?
  `).get(messageId);
}

function getMessageByRequestId(
  requestId
) {
  return db.prepare(`
    SELECT *
    FROM messages
    WHERE request_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(requestId);
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
    db.prepare(`
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
        ?, ?, ?, ?, 'pending', 0, ?, ?, ?
      )
    `).run(
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
  `).run(messageId);
}

function incrementAttempts(
  messageId
) {
  const row =
    db.prepare(`
      UPDATE messages
      SET attempts = attempts + 1
      WHERE id = ?
      RETURNING attempts
    `).get(messageId);

  return row?.attempts || 0;
}

function getPendingMessages() {
  return db.prepare(`
    SELECT *
    FROM messages
    WHERE
      status = 'pending'
      AND attempts < 3
    ORDER BY id ASC
  `).all();
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
  const existing =
    db.prepare(`
      SELECT *
      FROM processed_actions
      WHERE action_key = ?
    `).get(actionKey);

  if (!existing) {
    try {
      db.prepare(`
        INSERT INTO processed_actions (
          action_key,
          user_id,
          status,
          locked_until,
          created_at,
          updated_at
        )
        VALUES (
          ?,
          ?,
          'reserved',
          datetime('now', '+60 seconds'),
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
      `).run(
        actionKey,
        userId
      );

      return true;
    } catch (error) {
      if (
        safeErrorMessage(
          error
        ).includes(
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

  const updated =
    db.prepare(`
      UPDATE processed_actions
      SET
        status = 'reserved',
        user_id = ?,
        locked_until =
          datetime('now', '+60 seconds'),
        updated_at = CURRENT_TIMESTAMP
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
    `).run(
      userId,
      actionKey
    );

  return updated.changes > 0;
}

function linkActionToMessage(
  actionKey,
  messageId
) {
  db.prepare(`
    UPDATE processed_actions
    SET
      message_id = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(
    messageId,
    actionKey
  );
}

function completeAction(
  actionKey
) {
  if (!actionKey) return;

  db.prepare(`
    UPDATE processed_actions
    SET
      status = 'completed',
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(actionKey);
}

function failAction(
  actionKey
) {
  if (!actionKey) return;

  db.prepare(`
    UPDATE processed_actions
    SET
      status = 'failed',
      locked_until = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE action_key = ?
  `).run(actionKey);
}

function getAction(
  actionKey
) {
  if (!actionKey) return null;

  return db.prepare(`
    SELECT *
    FROM processed_actions
    WHERE action_key = ?
  `).get(actionKey);
}

// =====================================================
// SESSIONS
// =====================================================

function saveSession(
  userId,
  channelId,
  messageId,
  state,
  data,
  requestId,
  notifiedAt = null
) {
  if (!requestId) {
    throw new Error(
      'requestId is required'
    );
  }

  if (!channelId || !messageId) {
    throw new Error(
      'Invalid session message reference'
    );
  }

  const jsonData =
    data ? JSON.stringify(data) : null;

  db.transaction(() => {
    db.prepare(`
      DELETE FROM active_sessions
      WHERE user_id = ?
    `).run(userId);

    db.prepare(`
      INSERT INTO active_sessions (
        user_id,
        channel_id,
        message_id,
        state,
        data,
        request_id,
        notified_at,
        updated_at
      )
      VALUES (
        ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
    `).run(
      userId,
      String(channelId),
      String(messageId),
      state,
      jsonData,
      requestId,
      notifiedAt
    );
  })();
}

function updateSessionData(
  userId,
  state,
  data,
  notifiedAt = null
) {
  db.prepare(`
    UPDATE active_sessions
    SET
      state = ?,
      data = ?,
      notified_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ?
  `).run(
    state,
    data
      ? JSON.stringify(data)
      : null,
    notifiedAt,
    userId
  );
}

function getSession(userId) {
  return db.prepare(`
    SELECT *
    FROM active_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);
}

function deleteSession(userId) {
  db.prepare(`
    DELETE FROM active_sessions
    WHERE user_id = ?
  `).run(userId);
}

function deleteSessionByRequestId(
  requestId
) {
  if (!requestId) return;

  db.prepare(`
    DELETE FROM active_sessions
    WHERE request_id = ?
  `).run(requestId);
}

function getAllSessions() {
  return db.prepare(`
    SELECT *
    FROM active_sessions
    ORDER BY id ASC
  `).all();
}

// =====================================================
// MEMBER CACHE / SEARCH
// =====================================================

const memberCache = new Map();

async function getCachedMembers(
  interaction
) {
  if (!interaction.guild) {
    return [];
  }

  const guildId =
    interaction.guild.id;

  const now =
    Date.now();

  const cached =
    memberCache.get(guildId);

  if (
    cached &&
    now - cached.lastUpdated <
      60000
  ) {
    return cached.members;
  }

  try {
    await interaction.guild.members.fetch();

    const members =
      interaction.guild.members.cache
        .filter(
          member =>
            !member.user.bot &&
            member.user.id !==
              interaction.user.id
        )
        .map(member => ({
          id: member.user.id,
          username:
            member.user.username,
          displayName:
            member.displayName
        }));

    memberCache.set(
      guildId,
      {
        members,
        lastUpdated:
          now
      }
    );

    return members;
  } catch (error) {
    console.error(
      '❌ Member fetch error:',
      safeErrorMessage(error)
    );

    return cached?.members || [];
  }
}

async function resolveTargetMember(
  interaction,
  targetId
) {
  if (!interaction.guild) {
    throw new Error(
      'Use `/whisper` inside a server.'
    );
  }

  if (
    targetId ===
    interaction.user.id
  ) {
    throw new Error(
      'You cannot whisper yourself.'
    );
  }

  const member =
    await interaction.guild.members
      .fetch(targetId)
      .catch(() => null);

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

function searchMembers(
  members,
  query
) {
  const normalized =
    query
      .trim()
      .toLowerCase();

  if (!normalized) {
    return members.slice(0, 25);
  }

  return members
    .filter(member =>
      member.displayName
        .toLowerCase()
        .includes(normalized) ||
      member.username
        .toLowerCase()
        .includes(normalized) ||
      member.id.includes(normalized)
    )
    .slice(0, 25);
}

// =====================================================
// UI BUILDERS
// =====================================================

function buildMainPanel(
  requestId,
  members,
  searchQuery = ''
) {
  const embed =
    new EmbedBuilder()
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
      .setTitle(
        '💋 Vegas Whispers'
      )
      .setDescription(
        'Choose the person who deserves your whisper.\\n\\n' +
        '🔎 Search by **name, nickname or ID**, then select the member below.'
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

  const selectedMembers =
    searchMembers(
      members,
      searchQuery
    );

  const components = [];

  const searchRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `search_member_${requestId}`
          )
          .setLabel(
            '🔎 Search Member'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  components.push(searchRow);

  if (selectedMembers.length > 0) {
    const select =
      new StringSelectMenuBuilder()
        .setCustomId(
          `recipient_${requestId}`
        )
        .setPlaceholder(
          searchQuery
            ? 'Select a search result...'
            : 'Select a member...'
        )
        .addOptions(
          selectedMembers.map(
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
        );

    components.push(
      new ActionRowBuilder()
        .addComponents(
          select
        )
    );
  }

  const cancelRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `cancel_whisper_${requestId}`
          )
          .setLabel(
            'Cancel'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  components.push(
    cancelRow
  );

  return {
    embed,
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
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
      .setTitle(
        '🌙 Choose Your Identity'
      )
      .setDescription(
        `You are about to whisper to **${targetDisplayName}**.\\n\\n` +
        'Choose one identity for this conversation.'
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
            `pseudo_${targetId}_${requestId}_shadow`
          )
          .setLabel(
            '👤 Shadow'
          )
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            `pseudo_${targetId}_${requestId}_admirer`
          )
          .setLabel(
            '❤️ Secret Admirer'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            `pseudo_${targetId}_${requestId}_friendly`
          )
          .setLabel(
            '🤝 Friendly Curious'
          )
          .setStyle(
            ButtonStyle.Success
          )
      );

  return {
    embed,
    components: [row]
  };
}

function buildMessagePanel(
  targetDisplayName,
  targetId,
  requestId
) {
  const embed =
    new EmbedBuilder()
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
      .setTitle(
        `💌 A secret for ${targetDisplayName}...`
      )
      .setDescription(
        '✍️ Write your anonymous message.\\n\\n' +
        '**Rules:**\\n' +
        '• Maximum **3 paragraphs**\\n' +
        '• Maximum **2000 characters**'
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
            `open_modal_${targetId}_${requestId}`
          )
          .setLabel(
            '✍️ Write Message'
          )
          .setStyle(
            ButtonStyle.Primary
          )
      );

  return {
    embed,
    components: [row]
  };
}

async function buildAndSendWhisper(
  message,
  conversation
) {
  const pseudo =
    getUserPseudo(
      conversation,
      message.sender_id
    ) || 'Anonymous';

  const previous =
    message.previous_message_id
      ? getMessageById(
          message.previous_message_id
        )
      : null;

  const embed =
    new EmbedBuilder()
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
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
            `reply_${message.id}`
          )
          .setLabel(
            '💬 Reply'
          )
          .setStyle(
            ButtonStyle.Primary
          ),

        new ButtonBuilder()
          .setCustomId(
            `block_${conversation.id}`
          )
          .setLabel(
            '🚫 Block Sender'
          )
          .setStyle(
            ButtonStyle.Danger
          ),

        new ButtonBuilder()
          .setCustomId(
            `history_${conversation.id}`
          )
          .setLabel(
            '📜 History'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const target =
    await client.users.fetch(
      message.receiver_id
    );

  return target.send({
    content:
      '👋 **You received a whisper:**',
    embeds: [embed],
    components: [row]
  });
}

// =====================================================
// DELIVERY / RECOVERY
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
        limit:
          50
      });

    const expected =
      `reply_${message.id}`;

    return recent.find(
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
          ) ||
          false
        );
      }
    ) || null;
  } catch (error) {
    console.error(
      `⚠️ Delivery reconciliation failed for #${message.id}:`,
      safeErrorMessage(error)
    );

    return null;
  }
}

async function deliverMessageById(
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

  if (
    message.attempts >=
    3
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

  const conversation =
    getConversationById(
      message.conversation_id
    );

  if (!conversation) {
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

  // Reconciliation:
  // Discord may have received the DM before the process crashed.
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
        existing.id,
      reconciled:
        true
    };
  }

  const attempts =
    incrementAttempts(
      message.id
    );

  try {
    const sent =
      await buildAndSendWhisper(
        message,
        conversation
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
    console.error(
      `❌ Delivery failed for #${message.id}:`,
      safeErrorMessage(error)
    );

    if (
      attempts >=
      3
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

    return {
      status:
        'pending',
      attempts
    };
  }
}

async function retryPendingMessages() {
  const pending =
    getPendingMessages();

  if (!pending.length) {
    return;
  }

  console.log(
    `🔄 Checking ${pending.length} pending message(s)...`
  );

  for (
    const message of pending
  ) {
    try {
      const result =
        await deliverMessageById(
          message.id
        );

      if (
        result.status ===
          'sent' ||
        result.status ===
          'failed'
      ) {
        deleteSessionByRequestId(
          message.request_id
        );
      }
    } catch (error) {
      console.error(
        `❌ Pending #${message.id}:`,
        safeErrorMessage(error)
      );
    }
  }
}

// =====================================================
// NOTIFY SESSIONS
// =====================================================

async function notifyUnfinishedSessions() {
  const sessions =
    getAllSessions().filter(
      session =>
        !session.notified_at
    );

  if (!sessions.length) {
    return;
  }

  console.log(
    `🔄 Notifying ${sessions.length} unfinished session(s)...`
  );

  for (
    const session of sessions
  ) {
    try {
      const user =
        await client.users.fetch(
          session.user_id
        );

      await user.send(
        `🔁 **Unfinished Vegas Whispers session found.**\n` +
        `Pending step: **${session.state}**\n` +
        `Use \`/recover\` to resume.`
      );

      db.prepare(`
        UPDATE active_sessions
        SET notified_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(session.id);
    } catch (error) {
      console.log(
        `⚠️ Could not notify ${session.user_id}:`,
        safeErrorMessage(error)
      );
    }
  }
}

// =====================================================
// RECOVERY
// =====================================================

async function recoverSession(
  interaction,
  session
) {
  const data =
    parseSessionData(
      session
    );

  if (!data) {
    deleteSession(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        '❌ Session data is corrupted. Please use `/whisper` again.'
    });

    return false;
  }

  const requestId =
    session.request_id;

  if (!requestId) {
    deleteSession(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        '❌ Session request ID is missing.'
    });

    return false;
  }

  if (
    session.state ===
    'selecting_recipient'
  ) {
    return renderMainPanel(
      interaction,
      requestId,
      data.searchQuery || ''
    );
  }

  if (
    session.state ===
    'choosing_pseudo' &&
    data.targetId
  ) {
    try {
      const target =
        await client.users.fetch(
          data.targetId
        );

      const panel =
        buildPseudoPanel(
          data.targetDisplayName ||
            target.username,
          data.targetId,
          requestId
        );

      const reply =
        await interaction.editReply({
          embeds:
            [panel.embed],
          components:
            panel.components
        });

      saveSession(
        interaction.user.id,
        interaction.channel.id,
        reply.id,
        'choosing_pseudo',
        data,
        requestId,
        session.notified_at
      );

      return true;
    } catch {
      deleteSession(
        interaction.user.id
      );

      await interaction.editReply({
        content:
          '❌ Target user not found.'
      });

      return false;
    }
  }

  if (
    session.state ===
    'writing_message' &&
    data.targetId
  ) {
    try {
      const target =
        await client.users.fetch(
          data.targetId
        );

      const panel =
        buildMessagePanel(
          data.targetDisplayName ||
            target.username,
          data.targetId,
          requestId
        );

      const reply =
        await interaction.editReply({
          embeds:
            [panel.embed],
          components:
            panel.components
        });

      saveSession(
        interaction.user.id,
        interaction.channel.id,
        reply.id,
        'writing_message',
        data,
        requestId,
        session.notified_at
      );

      return true;
    } catch {
      deleteSession(
        interaction.user.id
      );

      await interaction.editReply({
        content:
          '❌ Target user not found.'
      });

      return false;
    }
  }

  if (
    session.state ===
      'delivery_pending' &&
    data.messageId
  ) {
    const result =
      await deliverMessageById(
        data.messageId
      );

    if (
      result.status ===
      'sent'
    ) {
      deleteSession(
        interaction.user.id
      );

      await interaction.editReply({
        content:
          '✅ Pending whisper delivered successfully.'
      });

      return true;
    }

    if (
      result.status ===
      'failed'
    ) {
      deleteSession(
        interaction.user.id
      );

      await interaction.editReply({
        content:
          '❌ Delivery failed.'
      });

      return false;
    }

    await interaction.editReply({
      content:
        `⏳ Delivery is still pending. Attempts: ${result.attempts || 0}/3.`
    });

    return true;
  }

  if (
    session.state ===
      'reply_writing' &&
    data.originalMessageId
  ) {
    const original =
      getMessageById(
        data.originalMessageId
      );

    if (
      !original ||
      original.receiver_id !==
        interaction.user.id
    ) {
      deleteSession(
        interaction.user.id
      );

      await interaction.editReply({
        content:
          '❌ Original whisper is no longer available.'
      });

      return false;
    }

    const row =
      new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(
              `reopen_reply_${original.id}_${requestId}`
            )
            .setLabel(
              '💬 Resume Reply'
            )
            .setStyle(
              ButtonStyle.Primary
            )
        );

    await interaction.editReply({
      content:
        '🔁 Your reply session was recovered.',
      embeds: [],
      components: [row]
    });

    return true;
  }

  deleteSession(
    interaction.user.id
  );

  await interaction.editReply({
    content:
      '❌ No recoverable session found.'
  });

  return false;
}

// =====================================================
// MAIN PANEL
// =====================================================

async function renderMainPanel(
  interaction,
  requestId,
  searchQuery = ''
) {
  const members =
    await getCachedMembers(
      interaction
    );

  if (!members.length) {
    await interaction.editReply({
      content:
        '❌ No members found in this server.',
      embeds: [],
      components: []
    });

    return false;
  }

  const panel =
    buildMainPanel(
      requestId,
      members,
      searchQuery
    );

  const reply =
    await interaction.editReply({
      embeds:
        [panel.embed],
      components:
        panel.components
    });

  saveSession(
    interaction.user.id,
    interaction.channel.id,
    reply.id,
    'selecting_recipient',
    {
      guildId:
        interaction.guild.id,
      searchQuery
    },
    requestId
  );

  return true;
}

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
        const command =
          interaction.commandName;

        // -----------------------------------------------
        // PING
        // -----------------------------------------------

        if (
          command ===
          'ping'
        ) {
          await interaction.reply({
            content:
              '🏓 Pong!',
            flags:
              64
          });

          return;
        }

        // -----------------------------------------------
        // WHISPER
        // -----------------------------------------------

        if (
          command ===
          'whisper'
        ) {
          if (!interaction.guild) {
            await interaction.reply({
              content:
                '❌ Use `/whisper` inside a server.',
              flags:
                64
            });

            return;
          }

          const existing =
            getSession(
              interaction.user.id
            );

          if (existing) {
            await interaction.reply({
              content:
                '⚠️ You already have an active operation. Finish it or use `/recover`.',
              flags:
                64
            });

            return;
          }

          await interaction.deferReply({
            flags:
              64
          });

          const requestId =
            interaction.id;

          await renderMainPanel(
            interaction,
            requestId
          );

          return;
        }

        // -----------------------------------------------
        // ADMIN
        // -----------------------------------------------

        if (
          command ===
          'admin'
        ) {
          if (
            !interaction.guild ||
            !interaction.member?.permissions.has(
              'Administrator'
            )
          ) {
            await interaction.reply({
              content:
                '❌ Admin only.',
              flags:
                64
            });

            return;
          }

          await interaction.deferReply({
            flags:
              64
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
            `).get(messageId);

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
                  0x6C2BD9
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
                      ),
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
              embeds:
                [embed]
            });
          } catch {
            await interaction.editReply({
              content:
                '❌ User not found.'
            });
          }

          return;
        }

        // -----------------------------------------------
        // RECOVER
        // -----------------------------------------------

        if (
          command ===
          'recover'
        ) {
          await interaction.deferReply({
            flags:
              64
          });

          const session =
            getSession(
              interaction.user.id
            );

          if (!session) {
            await interaction.editReply({
              content:
                '❌ No active session found.'
            });

            return;
          }

          await recoverSession(
            interaction,
            session
          );

          return;
        }
      }

      // =================================================
      // SEARCH MEMBER
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'search_member_'
        )
      ) {
        const requestId =
          interaction.customId.split(
            '_'
          )[2];

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
          await interaction.reply({
            content:
              '❌ This Vegas Whispers window has expired. Use `/whisper` again.',
            flags:
              64
          });

          return;
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `search_member_modal_${requestId}`
            )
            .setTitle(
              '🔎 Search Member'
            );

        const input =
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
              'Example: Alex, Alex123 or 123456789...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              100
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              input
            )
        );

        await interaction.showModal(
          modal
        );

        return;
      }

      // =================================================
      // SEARCH MEMBER MODAL
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'search_member_modal_'
        )
      ) {
        await interaction.deferReply({
          flags:
            64
        });

        const requestId =
          interaction.customId.split(
            '_'
          )[3];

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
          await interaction.editReply({
            content:
              '❌ Search session expired. Use `/whisper` again.'
          });

          return;
        }

        const query =
          interaction.fields
            .getTextInputValue(
              'member_query'
            )
            .trim();

        const data =
          parseSessionData(
            session
          );

        if (!data) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ Session data is corrupted.'
          });

          return;
        }

        await renderMainPanel(
          interaction,
          requestId,
          query
        );

        return;
      }

      // =================================================
      // RECIPIENT SELECT
      // =================================================

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith(
          'recipient_'
        )
      ) {
        await interaction.deferUpdate();

        const requestId =
          interaction.customId.split(
            '_'
          )[1];

        const targetId =
          interaction.values[0];

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.user_id !==
            interaction.user.id ||
          session.request_id !==
            requestId ||
          session.state !==
            'selecting_recipient'
        ) {
          await interaction.editReply({
            content:
              '❌ This selection has expired. Use `/whisper` again.',
            embeds: [],
            components: []
          });

          return;
        }

        try {
          const member =
            await resolveTargetMember(
              interaction,
              targetId
            );

          const panel =
            buildPseudoPanel(
              member.displayName,
              member.id,
              requestId
            );

          const reply =
            await interaction.editReply({
              embeds:
                [panel.embed],
              components:
                panel.components
            });

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            reply.id,
            'choosing_pseudo',
            {
              guildId:
                interaction.guild.id,
              targetId:
                member.id,
              targetDisplayName:
                member.displayName
            },
            requestId
          );
        } catch (error) {
          await interaction.editReply({
            content:
              `❌ ${safeErrorMessage(error)}`,
            embeds: [],
            components: []
          });
        }

        return;
      }

      // =================================================
      // CANCEL WHISPER
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'cancel_whisper_'
        )
      ) {
        await interaction.deferUpdate();

        const requestId =
          interaction.customId.split(
            '_'
          )[2];

        const session =
          getSession(
            interaction.user.id
          );

        if (
          session &&
          session.request_id ===
            requestId
        ) {
          deleteSession(
            interaction.user.id
          );
        }

        await interaction.editReply({
          content:
            '❌ Whisper cancelled.',
          embeds: [],
          components: []
        });

        return;
      }

      // =================================================
      // PSEUDO
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'pseudo_'
        )
      ) {
        await interaction.deferUpdate();

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          4
        ) {
          await interaction.editReply({
            content:
              '❌ Invalid pseudo action.',
            embeds: [],
            components: []
          });

          return;
        }

        const [
          ,
          targetId,
          requestId,
          pseudoType
        ] = parts;

        const pseudo =
          PSEUDOS[
            pseudoType
          ];

        if (!pseudo) {
          await interaction.editReply({
            content:
              '❌ Invalid pseudo choice.',
            embeds: [],
            components: []
          });

          return;
        }

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.user_id !==
            interaction.user.id ||
          session.request_id !==
            requestId ||
          session.state !==
            'choosing_pseudo'
        ) {
          await interaction.editReply({
            content:
              '❌ Invalid or expired session.',
            embeds: [],
            components: []
          });

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
          await interaction.editReply({
            content:
              '❌ Session does not match this member.',
            embeds: [],
            components: []
          });

          return;
        }

        const actionKey =
          `pseudo_${requestId}`;

        if (
          !reserveAction(
            actionKey,
            interaction.user.id
          )
        ) {
          await interaction.editReply({
            content:
              '⚠️ This pseudo selection is already being processed.',
            embeds: [],
            components: []
          });

          return;
        }

        try {
          const conversation =
            getOrCreateConversation(
              interaction.user.id,
              targetId
            );

          const currentPseudo =
            getUserPseudo(
              conversation,
              interaction.user.id
            );

          if (
            currentPseudo &&
            currentPseudo !==
              pseudo
          ) {
            throw new Error(
              'You already chose a pseudo for this conversation.'
            );
          }

          if (!currentPseudo) {
            const changed =
              setUserPseudo(
                conversation.id,
                interaction.user.id,
                pseudo
              );

            if (!changed) {
              throw new Error(
                'Could not save pseudo.'
              );
            }
          }

          // SECOND WINDOW = MESSAGE WRITING
          const panel =
            buildMessagePanel(
              data.targetDisplayName,
              targetId,
              requestId
            );

          updateSessionData(
            interaction.user.id,
            'writing_message',
            {
              ...data,
              pseudo
            }
          );

          completeAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '',
            embeds:
              [panel.embed],
            components:
              panel.components
          });
        } catch (error) {
          failAction(
            actionKey
          );

          await interaction.editReply({
            content:
              `❌ ${safeErrorMessage(error)}`,
            embeds: [],
            components: []
          });
        }

        return;
      }

      // =================================================
      // OPEN MESSAGE MODAL
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'open_modal_'
        )
      ) {
        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          4
        ) {
          await interaction.reply({
            content:
              '❌ Invalid message form.',
            flags:
              64
          });

          return;
        }

        const [
          ,
          targetId,
          requestId
        ] = parts;

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.user_id !==
            interaction.user.id ||
          session.request_id !==
            requestId ||
          session.state !==
            'writing_message'
        ) {
          await interaction.reply({
            content:
              '❌ This message window has expired. Use `/recover`.',
            flags:
              64
          });

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
          await interaction.reply({
            content:
              '❌ Session data does not match the recipient.',
            flags:
              64
          });

          return;
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `send_message_${targetId}_${requestId}`
            )
            .setTitle(
              `💌 A secret for ${(data.targetDisplayName || 'them').slice(0, 40)}...`
            );

        const input =
          new TextInputBuilder()
            .setCustomId(
              'message_content'
            )
            .setLabel(
              'Your message (max 3 paragraphs)'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Write your anonymous message...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              2000
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              input
            )
        );

        await interaction.showModal(
          modal
        );

        return;
      }

      // =================================================
      // SEND MESSAGE
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'send_message_'
        )
      ) {
        await interaction.deferReply({
          flags:
            64
        });

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          4
        ) {
          await interaction.editReply({
            content:
              '❌ Invalid message form.'
          });

          return;
        }

        const [
          ,
          targetId,
          requestId
        ] = parts;

        const messageContent =
          interaction.fields
            .getTextInputValue(
              'message_content'
            )
            .trim();

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.user_id !==
            interaction.user.id ||
          session.request_id !==
            requestId ||
          session.state !==
            'writing_message'
        ) {
          await interaction.editReply({
            content:
              '❌ This message session has expired. Use `/recover`.'
          });

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
          await interaction.editReply({
            content:
              '❌ Modal does not match the active session.'
          });

          return;
        }

        const paragraphs =
          countParagraphs(
            messageContent
          );

        if (
          paragraphs >
          3
        ) {
          await interaction.editReply({
            content:
              `❌ **${paragraphs} paragraphs** detected. Maximum is 3.`
          });

          return;
        }

        let targetMember;

        try {
          targetMember =
            await resolveTargetMember(
              interaction,
              targetId
            );
        } catch (error) {
          await interaction.editReply({
            content:
              `❌ ${safeErrorMessage(error)}`
          });

          return;
        }

        let conversation;

        try {
          conversation =
            getOrCreateConversation(
              interaction.user.id,
              targetMember.id
            );
        } catch (error) {
          await interaction.editReply({
            content:
              safeErrorMessage(error) ===
              'Conversation is blocked'
                ? '❌ This conversation is blocked.'
                : '❌ Error creating conversation.'
          });

          return;
        }

        const senderPseudo =
          getUserPseudo(
            conversation,
            interaction.user.id
          );

        if (!senderPseudo) {
          await interaction.editReply({
            content:
              '❌ No pseudo selected.'
          });

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
          await interaction.editReply({
            content:
              '⚠️ This whisper is already being processed.'
          });

          return;
        }

        let message;

        try {
          const transaction =
            db.transaction(() => {
              const currentConversation =
                getOrCreateConversation(
                  interaction.user.id,
                  targetMember.id
                );

              const created =
                createPendingMessage({
                  conversationId:
                    currentConversation.id,
                  senderId:
                    interaction.user.id,
                  receiverId:
                    targetMember.id,
                  content:
                    messageContent,
                  requestId,
                  actionKey
                });

              linkActionToMessage(
                actionKey,
                created.id
              );

              updateSessionData(
                interaction.user.id,
                'delivery_pending',
                {
                  targetId:
                    targetMember.id,
                  targetDisplayName:
                    targetMember.displayName,
                  messageContent,
                  pseudo:
                    senderPseudo,
                  messageId:
                    created.id,
                  actionKey
                }
              );

              return created;
            });

          message =
            transaction();
        } catch (error) {
          failAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '❌ Error saving the message.'
          });

          return;
        }

        const result =
          await deliverMessageById(
            message.id
          );

        if (
          result.status ===
          'sent'
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              `✅ **Sent!** ${messageContent.length} characters • ${paragraphs} paragraph${paragraphs > 1 ? 's' : ''}.`
          });

          return;
        }

        if (
          result.status ===
          'failed'
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ Message could not be delivered.'
          });

          return;
        }

        await interaction.editReply({
          content:
            `⏳ Message saved. Delivery is pending (${result.attempts}/3). Use \`/recover\` to retry.`
        });

        return;
      }

      // =================================================
      // REPLY BUTTON
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'reply_'
        )
      ) {
        const messageId =
          interaction.customId.split(
            '_'
          )[1];

        const original =
          getMessageById(
            messageId
          );

        if (!original) {
          await interaction.reply({
            content:
              '❌ Original whisper not found.',
            flags:
              64
          });

          return;
        }

        if (
          original.receiver_id !==
          interaction.user.id
        ) {
          await interaction.reply({
            content:
              '❌ You are not authorized to reply.',
            flags:
              64
          });

          return;
        }

        const existing =
          getSession(
            interaction.user.id
          );

        if (existing) {
          await interaction.reply({
            content:
              '⚠️ You already have an active operation. Use `/recover`.',
            flags:
              64
          });

          return;
        }

        const requestId =
          interaction.id;

        // Important: use a valid Discord message ID
        // whenever available.
        const sessionMessageId =
          interaction.message?.id ||
          String(
            original.id
          );

        saveSession(
          interaction.user.id,
          interaction.channel?.id,
          sessionMessageId,
          'reply_writing',
          {
            originalMessageId:
              original.id
          },
          requestId
        );

        const modal =
          new ModalBuilder()
            .setCustomId(
              `reply_modal_${original.id}_${requestId}`
            )
            .setTitle(
              '💬 Reply to Whisper'
            );

        const input =
          new TextInputBuilder()
            .setCustomId(
              'reply_content'
            )
            .setLabel(
              'Your reply (max 3 paragraphs)'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Type your anonymous reply...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              2000
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              input
            )
        );

        await interaction.showModal(
          modal
        );

        return;
      }

      // =================================================
      // REOPEN RECOVERED REPLY
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'reopen_reply_'
        )
      ) {
        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          4
        ) {
          await interaction.reply({
            content:
              '❌ Invalid recovery button.',
            flags:
              64
          });

          return;
        }

        const [
          ,
          messageId,
          requestId
        ] = parts;

        const session =
          getSession(
            interaction.user.id
          );

        const original =
          getMessageById(
            messageId
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'reply_writing' ||
          !original ||
          original.receiver_id !==
            interaction.user.id
        ) {
          await interaction.reply({
            content:
              '❌ Reply session is no longer valid.',
            flags:
              64
          });

          return;
        }

        const modal =
          new ModalBuilder()
            .setCustomId(
              `reply_modal_${messageId}_${requestId}`
            )
            .setTitle(
              '💬 Reply to Whisper'
            );

        const input =
          new TextInputBuilder()
            .setCustomId(
              'reply_content'
            )
            .setLabel(
              'Your reply (max 3 paragraphs)'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Type your anonymous reply...'
            )
            .setRequired(
              true
            )
            .setMaxLength(
              2000
            );

        modal.addComponents(
          new ActionRowBuilder()
            .addComponents(
              input
            )
        );

        await interaction.showModal(
          modal
        );

        return;
      }

      // =================================================
      // REPLY MODAL
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'reply_modal_'
        )
      ) {
        await interaction.deferReply({
          flags:
            64
        });

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !==
          4
        ) {
          await interaction.editReply({
            content:
              '❌ Invalid reply form.'
          });

          return;
        }

        const [
          ,
          messageId,
          requestId
        ] = parts;

        const replyContent =
          interaction.fields
            .getTextInputValue(
              'reply_content'
            )
            .trim();

        const session =
          getSession(
            interaction.user.id
          );

        if (
          !session ||
          session.request_id !==
            requestId ||
          session.state !==
            'reply_writing'
        ) {
          await interaction.editReply({
            content:
              '❌ Reply session expired. Use `/recover`.'
          });

          return;
        }

        const data =
          parseSessionData(
            session
          );

        if (
          !data ||
          String(
            data.originalMessageId
          ) !==
            String(messageId)
        ) {
          await interaction.editReply({
            content:
              '❌ Reply session does not match this whisper.'
          });

          return;
        }

        const paragraphs =
          countParagraphs(
            replyContent
          );

        if (
          paragraphs >
          3
        ) {
          await interaction.editReply({
            content:
              `❌ **${paragraphs} paragraphs** detected. Maximum is 3.`
          });

          return;
        }

        const original =
          getMessageById(
            messageId
          );

        if (!original) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ Original whisper not found.'
          });

          return;
        }

        if (
          original.receiver_id !==
          interaction.user.id
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ You are not authorized to reply.'
          });

          return;
        }

        const senderId =
          original.sender_id;

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
              '⚠️ This reply is already being processed.'
          });

          return;
        }

        let savedMessage;

        try {
          const transaction =
            db.transaction(() => {
              const conversation =
                getOrCreateConversation(
                  interaction.user.id,
                  senderId
                );

              const created =
                createPendingMessage({
                  conversationId:
                    conversation.id,
                  senderId:
                    interaction.user.id,
                  receiverId:
                    senderId,
                  content:
                    replyContent,
                  requestId,
                  actionKey
                });

              linkActionToMessage(
                actionKey,
                created.id
              );

              updateSessionData(
                interaction.user.id,
                'delivery_pending',
                {
                  originalMessageId:
                    original.id,
                  messageId:
                    created.id,
                  actionKey
                }
              );

              return created;
            });

          savedMessage =
            transaction();
        } catch {
          failAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '❌ Error saving reply.'
          });

          return;
        }

        const result =
          await deliverMessageById(
            savedMessage.id
          );

        if (
          result.status ===
          'sent'
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '✅ Reply sent!'
          });

          return;
        }

        if (
          result.status ===
          'failed'
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ Reply could not be delivered.'
          });

          return;
        }

        await interaction.editReply({
          content:
            `⏳ Reply saved. Delivery is pending (${result.attempts}/3). Use \`/recover\` to retry.`
        });

        return;
      }

      // =================================================
      // HISTORY
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'history_'
        )
      ) {
        await interaction.deferReply({
          flags:
            64
        });

        const conversationId =
          interaction.customId.split(
            '_'
          )[1];

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
          conversation.user_a_id !==
            interaction.user.id &&
          conversation.user_b_id !==
            interaction.user.id
        ) {
          await interaction.editReply({
            content:
              '❌ You are not part of this conversation.'
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
              '📜 No messages in this conversation yet.'
          });

          return;
        }

        const pseudoMap =
          {};

        for (
          const userId of [
            conversation.user_a_id,
            conversation.user_b_id
          ]
        ) {
          pseudoMap[userId] =
            getUserPseudo(
              conversation,
              userId
            ) ||
            'Anonymous';
        }

        let historyText =
          history
            .map(message => {
              const pseudo =
                pseudoMap[
                  message.sender_id
                ] ||
                'Anonymous';

              const date =
                new Date(
                  message.sent_at
                ).toLocaleString();

              return (
                `**${pseudo}** (${date}): ${message.content}`
              );
            })
            .join(
              '\n\n'
            );

        if (
          historyText.length >
          1000
        ) {
          historyText =
            `${historyText.slice(
              0,
              1000
            )}...`;
        }

        const embed =
          new EmbedBuilder()
            .setColor(
              0x6C2BD9
            )
            .setTitle(
              '📜 Conversation History (last 10)'
            )
            .setDescription(
              historyText
            )
            .setFooter({
              text:
                'Vegas Whispers'
            })
            .setTimestamp();

        await interaction.editReply({
          embeds:
            [embed]
        });

        return;
      }

      // =================================================
      // BLOCK
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'block_'
        )
      ) {
        await interaction.deferReply({
          flags:
            64
        });

        const conversationId =
          interaction.customId.split(
            '_'
          )[1];

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

        const otherParticipant =
          getOtherParticipant(
            conversation,
            interaction.user.id
          );

        if (!otherParticipant) {
          await interaction.editReply({
            content:
              '❌ You are not part of this conversation.'
          });

          return;
        }

        if (
          conversation.is_blocked
        ) {
          await interaction.editReply({
            content:
              '⚠️ This conversation is already blocked.'
          });

          return;
        }

        const row =
          new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder()
                .setCustomId(
                  `confirm_block_${conversationId}`
                )
                .setLabel(
                  '✅ Yes, Block'
                )
                .setStyle(
                  ButtonStyle.Danger
                ),

              new ButtonBuilder()
                .setCustomId(
                  `cancel_block_${conversationId}`
                )
                .setLabel(
                  '❌ Cancel'
                )
                .setStyle(
                  ButtonStyle.Secondary
                )
            );

        await interaction.editReply({
          content:
            '⚠️ **Block this sender?** You will no longer receive messages from this conversation.',
          components:
            [row]
        });

        return;
      }

      // =================================================
      // CONFIRM BLOCK
      // =================================================

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          'confirm_block_'
        )
      ) {
        await interaction.deferUpdate();

        const conversationId =
          interaction.customId.split(
            '_'
          )[2];

        const conversation =
          getConversationById(
            conversationId
          );

        if (!conversation) {
          await interaction.editReply({
            content:
              '❌ Conversation not found.',
            components:
              []
          });

          return;
        }

        const otherParticipant =
          getOtherParticipant(
            conversation,
            interaction.user.id
          );

        if (!otherParticipant) {
          await interaction.editReply({
            content:
              '❌ You are not part of this conversation.',
            components:
              []
          });

          return;
        }

        if (
          conversation.is_blocked
        ) {
          await interaction.editReply({
            content:
              '⚠️ This conversation is already blocked.',
            components:
              []
          });

          return;
        }

        const actionKey =
          `block_${interaction.user.id}_${conversationId}`;

        if (
          !reserveAction(
            actionKey,
            interaction.user.id
          )
        ) {
          await interaction.editReply({
            content:
              '⚠️ This block action is already being processed.',
            components:
              []
          });

          return;
        }

        try {
          const blocked =
            blockConversation(
              conversationId,
              interaction.user.id
            );

          if (!blocked) {
            failAction(
              actionKey
            );

            await interaction.editReply({
              content:
                '⚠️ Conversation already blocked.',
              components:
                []
            });

            return;
          }

          completeAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '✅ **Blocked.**',
            components:
              []
          });

          try {
            const other =
              await client.users.fetch(
                otherParticipant
              );

            await other.send({
              content:
                '🚫 **You have been blocked.**'
            });
          } catch {}
        } catch {
          failAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '❌ Error blocking the conversation.',
            components:
              []
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
          'cancel_block_'
        )
      ) {
        await interaction.deferUpdate();

        await interaction.editReply({
          content:
            '❌ Cancelled.',
          components:
            []
        });

        return;
      }
    } catch (error) {
      console.error(
        '❌ Unhandled interaction error:',
        safeErrorMessage(error)
      );

      try {
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply({
            content:
              '❌ Something went wrong. Please try again.'
          });
        } else {
          await interaction.reply({
            content:
              '❌ Something went wrong. Please try again.',
            flags:
              64
          });
        }
      } catch {}
    }
  }
);

// =====================================================
// STARTUP
// =====================================================

client.once(
  'ready',
  async () => {
    console.log(
      `✅ Bot online as ${client.user.tag}`
    );

    try {
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
    } catch (error) {
      console.error(
        '❌ Slash registration error:',
        safeErrorMessage(error)
      );
    }

    await retryPendingMessages();
    await notifyUnfinishedSessions();
  }
);

// =====================================================
// SAFE SHUTDOWN
// =====================================================

function shutdown(
  signal
) {
  console.log(
    `🛑 ${signal} received. Shutting down safely...`
  );

  clearInterval(
    keepAliveTimer
  );

  try {
    db.close();
  } catch {}

  try {
    server.close();
  } catch {}

  process.exit(0);
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

// =====================================================
// LOGIN
// =====================================================

client.login(
  process.env.TOKEN
);