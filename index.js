const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
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

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});

server.listen(PORT, () => {
  console.log(`✅ Keep-alive server running on port ${PORT}`);
});

const keepAliveTimer = setInterval(() => {
  fetch(`http://localhost:${PORT}/`)
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

function hasColumn(tableName, columnName) {
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
  // ---------------------------------------------------
  // Base tables
  // ---------------------------------------------------

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

  // ---------------------------------------------------
  // Migrations
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

  // Ancienne version : sent = 0/1
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

  // ---------------------------------------------------
  // Nettoyage / indexes
  // ---------------------------------------------------

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

  // Une seule session active par utilisateur.
  db.exec(`
    DELETE FROM active_sessions
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM active_sessions
      GROUP BY user_id
    );
  `);

  // Générer un request_id pour anciennes sessions.
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
      idx_sessions_user_id
      ON active_sessions(user_id);

    CREATE INDEX IF NOT EXISTS
      idx_sessions_request_id
      ON active_sessions(request_id);

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

function getRandomQuote() {
  return QUOTES[
    Math.floor(Math.random() * QUOTES.length)
  ];
}

function safeErrorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}

function parseSessionData(session) {
  try {
    const data = session?.data
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

function countParagraphs(content) {
  return content
    .split(/\n\s*\n/)
    .filter(
      paragraph => paragraph.trim().length > 0
    )
    .length;
}

// =====================================================
// SLASH COMMANDS
// =====================================================

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Replies Pong!'),

  new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Send an anonymous message')
    .addStringOption(option =>
      option
        .setName('target')
        .setDescription(
          'Search by username/nickname or enter a member ID'
        )
        .setAutocomplete(true)
        .setRequired(true)
    )
    .addStringOption(option =>
      option
        .setName('message')
        .setDescription(
          'Your message (max 3 paragraphs)'
        )
        .setRequired(true)
        .setMaxLength(2000)
    ),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
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
].map(command => command.toJSON());

const rest = new REST({
  version: '10'
}).setToken(process.env.TOKEN);

// =====================================================
// CONVERSATIONS
// =====================================================

function getConversationById(conversationId) {
  return db.prepare(`
    SELECT *
    FROM conversations
    WHERE id = ?
  `).get(conversationId);
}

function getOrCreateConversation(
  userA,
  userB
) {
  const existing = db.prepare(`
    SELECT *
    FROM conversations
    WHERE
      (user_a_id = ? AND user_b_id = ?)
      OR
      (user_a_id = ? AND user_b_id = ?)
  `).get(
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

  const [a, b] = [userA, userB].sort();

  const result = db.prepare(`
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

function getConversationOtherParticipant(
  conversation,
  userId
) {
  if (conversation.user_a_id === userId) {
    return conversation.user_b_id;
  }

  if (conversation.user_b_id === userId) {
    return conversation.user_a_id;
  }

  return null;
}

function getUserPseudo(
  conversation,
  userId
) {
  if (
    conversation.user_a_id === userId
  ) {
    return conversation.pseudo_a;
  }

  if (
    conversation.user_b_id === userId
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
  let result = db.prepare(`
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

  if (result.changes > 0) {
    return true;
  }

  result = db.prepare(`
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

  return result.changes > 0;
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
    conversation.user_a_id !== userId &&
    conversation.user_b_id !== userId
  ) {
    throw new Error(
      'Not a participant'
    );
  }

  if (conversation.is_blocked) {
    return false;
  }

  const result = db.prepare(`
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

function createPendingMessage({
  conversationId,
  senderId,
  receiverId,
  content,
  requestId,
  actionKey
}) {
  const previous =
    getPreviousMessage(
      conversationId
    );

  const result = db.prepare(`
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
  const result = db.prepare(`
    UPDATE messages
    SET attempts = attempts + 1
    WHERE id = ?
    RETURNING attempts
  `).get(messageId);

  return result?.attempts ?? 0;
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
  return db.prepare(`
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
  `).all(
    conversationId,
    limit
  ).reverse();
}

// =====================================================
// IDEMPOTENCE
// =====================================================

function reserveAction(
  actionKey,
  userId
) {
  const existing = db.prepare(`
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
    existing.status === 'completed'
  ) {
    return false;
  }

  const reusable = db.prepare(`
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

  return reusable.changes > 0;
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

function getAction(actionKey) {
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
      'channelId and messageId are required'
    );
  }

  const jsonData = data
    ? JSON.stringify(data)
    : null;

  const save = db.transaction(() => {
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
      channelId,
      messageId,
      state,
      jsonData,
      requestId,
      notifiedAt
    );
  });

  save();
}

function updateSessionData(
  userId,
  state,
  data,
  notifiedAt = null
) {
  const jsonData = data
    ? JSON.stringify(data)
    : null;

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
    jsonData,
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
// UI
// =====================================================

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
        `You are about to message **${targetDisplayName}**.\n\n` +
        'Select a name for this conversation.'
      )
      .addFields({
        name: '💬 Quote',
        value: getRandomQuote(),
        inline: false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `pseudo_${targetId}_${requestId}_shadow`
        )
        .setLabel('👤 Shadow')
        .setStyle(
          ButtonStyle.Secondary
        ),

      new ButtonBuilder()
        .setCustomId(
          `pseudo_${targetId}_${requestId}_admirer`
        )
        .setLabel('❤️ Secret Admirer')
        .setStyle(
          ButtonStyle.Danger
        ),

      new ButtonBuilder()
        .setCustomId(
          `pseudo_${targetId}_${requestId}_friendly`
        )
        .setLabel('🤝 Friendly Curious')
        .setStyle(
          ButtonStyle.Success
        )
    );

  return {
    embed,
    row
  };
}

function buildWritingPanel(
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
        '✍️ Write your message below.\n\n' +
        '**Rules:**\n' +
        '• Max **3 paragraphs**\n' +
        '• Max **2000 characters**'
      )
      .addFields({
        name: '💬 Quote',
        value: getRandomQuote(),
        inline: false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      })
      .setTimestamp();

  const row =
    new ActionRowBuilder().addComponents(
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
    row
  };
}

async function buildAndSendWhisperEmbed(
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
        name: `💬 ${pseudo}`
      })
      .setDescription(
        message.content || ''
      )
      .setFooter({
        text:
          'Vegas Whispers'
      })
      .setTimestamp();

  if (previous) {
    const previousPseudo =
      getUserPseudo(
        conversation,
        previous.sender_id
      ) || 'Anonymous';

    const preview =
      (previous.content || '')
        .length > 100
        ? `${previous.content.slice(0, 100)}...`
        : (previous.content || '');

    embed.addFields({
      name:
        '📜 Previous message',
      value:
        `**${previousPseudo}:** ${preview}`
    });
  }

  const row =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `reply_${message.id}`
        )
        .setLabel('💬 Reply')
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

  return {
    embeds: [embed],
    components: [row]
  };
}

// =====================================================
// MEMBER SEARCH
// =====================================================

const memberCache =
  new Map();

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

  const cacheEntry =
    memberCache.get(
      guildId
    );

  if (
    cacheEntry &&
    now - cacheEntry.lastUpdated <
      60000
  ) {
    return cacheEntry.members;
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

    return (
      cacheEntry?.members || []
    );
  }
}

async function resolveTargetMember(
  interaction,
  targetId
) {
  if (!interaction.guild) {
    throw new Error(
      'This command must be used in a server.'
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

    const expectedReplyId =
      `reply_${message.id}`;

    const found =
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
                    expectedReplyId
                )
            ) || false
          );
        }
      );

    return found || null;
  } catch (error) {
    console.error(
      `⚠️ Could not check existing delivery for ${message.id}:`,
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
      status: 'sent',
      discordMessageId:
        message.discord_message_id
    };
  }

  if (
    message.status ===
    'failed'
  ) {
    return {
      status: 'failed'
    };
  }

  if (
    (message.attempts || 0) >= 3
  ) {
    markMessageFailed(
      message.id
    );

    failAction(
      message.action_key
    );

    return {
      status: 'failed'
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
      status: 'failed'
    };
  }

  // Vérifier si le DM a déjà
  // été envoyé avant un crash.
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
      status: 'sent',
      discordMessageId:
        existing.id,
      reconciled: true
    };
  }

  const attempts =
    incrementAttempts(
      message.id
    );

  try {
    const payload =
      await buildAndSendWhisperEmbed(
        message,
        conversation
      );

    const sent =
      await target.send({
        content:
          '👋 **You received a whisper:**',
        ...payload
      });

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
      status: 'sent',
      discordMessageId:
        sent.id
    };
  } catch (error) {
    console.error(
      `❌ Delivery failed for #${message.id}:`,
      safeErrorMessage(error)
    );

    if (
      attempts >= 3
    ) {
      markMessageFailed(
        message.id
      );

      failAction(
        message.action_key
      );

      return {
        status: 'failed'
      };
    }

    return {
      status: 'pending',
      attempts,
      error
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

  for (const message of pending) {
    try {
      const result =
        await deliverMessageById(
          message.id
        );

      if (
        result.status === 'sent' ||
        result.status === 'failed'
      ) {
        deleteSessionByRequestId(
          message.request_id
        );
      }
    } catch (error) {
      console.error(
        `❌ Pending message #${message.id}:`,
        safeErrorMessage(error)
      );
    }
  }
}

// =====================================================
// SESSION NOTIFICATION
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

  for (const session of sessions) {
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

async function recoverDeliverySession(
  interaction,
  session,
  data
) {
  let message =
    data.messageId
      ? getMessageById(
          data.messageId
        )
      : null;

  if (
    !message &&
    session.request_id
  ) {
    message =
      getMessageByRequestId(
        session.request_id
      );
  }

  if (
    !message &&
    data.actionKey
  ) {
    const action =
      getAction(
        data.actionKey
      );

    if (
      action?.message_id
    ) {
      message =
        getMessageById(
          action.message_id
        );
    }
  }

  if (!message) {
    deleteSession(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        '❌ No recoverable message was found. Please use `/whisper` again.'
    });

    return false;
  }

  if (
    message.status ===
    'sent'
  ) {
    completeAction(
      message.action_key
    );

    deleteSession(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        '✅ The whisper was already delivered.'
    });

    return true;
  }

  if (
    message.status ===
    'failed'
  ) {
    deleteSession(
      interaction.user.id
    );

    await interaction.editReply({
      content:
        '❌ Delivery failed. Please use `/whisper` again.'
    });

    return false;
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
        '❌ Delivery failed after the maximum number of attempts.'
    });

    return false;
  }

  updateSessionData(
    interaction.user.id,
    'delivery_pending',
    {
      ...data,
      messageId:
        message.id,
      actionKey:
        message.action_key
    },
    session.notified_at
  );

  await interaction.editReply({
    content:
      `⏳ Delivery