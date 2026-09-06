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
      `⏳ Delivery still pending. Attempts: ${result.attempts || message.attempts}/3.`
  });

  return true;
}

async function recoverSession(
  interaction,
  session
) {
  const data =
    parseSessionData(
      session
    );

  if (
    data === null
  ) {
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
        '❌ Session is missing its request ID.'
    });

    return false;
  }

  if (
    session.state ===
    'selecting_recipient'
  ) {
    return showMainMenu(
      interaction,
      requestId
    );
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
        buildWritingPanel(
          data.targetDisplayName ||
            target.username,
          data.targetId,
          requestId
        );

      const reply =
        await interaction.editReply({
          embeds: [
            panel.embed
          ],
          components: [
            panel.row
          ]
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
    'choosing_pseudo' &&
    data.targetId &&
    data.messageContent
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
          embeds: [
            panel.embed
          ],
          components: [
            panel.row
          ]
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
      components: [row],
      embeds: []
    });

    return true;
  }

  if (
    session.state ===
      'sending_message' ||
    session.state ===
      'delivery_pending'
  ) {
    return recoverDeliverySession(
      interaction,
      session,
      data
    );
  }

  deleteSession(
    interaction.user.id
  );

  await interaction.editReply({
    content:
      '❌ No recoverable action found.'
  });

  return false;
}

// =====================================================
// MAIN MENU
// =====================================================

async function showMainMenu(
  interaction,
  requestId = null
) {
  if (!interaction.guild) {
    await interaction.editReply({
      content:
        '❌ Use `/whisper` inside a server.',
      embeds: [],
      components: []
    });

    return false;
  }

  const stableRequestId =
    requestId ||
    crypto.randomUUID();

  const members =
    await getCachedMembers(
      interaction
    );

  if (!members.length) {
    await interaction.editReply({
      content:
        '❌ No members found.',
      embeds: [],
      components: []
    });

    return false;
  }

  const embed =
    new EmbedBuilder()
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
      .setTitle(
        '💋 Who deserves your whisper?'
      )
      .setDescription(
        'Select a server member to send an anonymous message to.'
      )
      .addFields({
        name:
          '💬 Quote',
        value:
          getRandomQuote(),
        inline: false
      })
      .setFooter({
        text:
          'Vegas Whispers • Your identity is safe'
      })
      .setTimestamp();

  const select =
    new StringSelectMenuBuilder()
      .setCustomId(
        `select_recipient_${stableRequestId}`
      )
      .setPlaceholder(
        'Choose a member...'
      )
      .addOptions(
        members
          .slice(0, 25)
          .map(member =>
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
              .setValue(
                member.id
              )
          )
      );

  const selectRow =
    new ActionRowBuilder()
      .addComponents(
        select
      );

  const cancelRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `cancel_whisper_${stableRequestId}`
          )
          .setLabel(
            'Cancel'
          )
          .setStyle(
            ButtonStyle.Secondary
          )
      );

  const reply =
    await interaction.editReply({
      embeds: [embed],
      components: [
        selectRow,
        cancelRow
      ]
    });

  saveSession(
    interaction.user.id,
    interaction.channel.id,
    reply.id,
    'selecting_recipient',
    {
      guildId:
        interaction.guild.id
    },
    stableRequestId
  );

  return true;
}

// =====================================================
// INTERACTIONS
// =====================================================

client.on(
  'interactionCreate',
  async interaction => {
    try {
      // =================================================
      // AUTOCOMPLETE
      // =================================================

      if (
        interaction.isAutocomplete()
      ) {
        try {
          const focused =
            interaction.options
              .getFocused()
              .toLowerCase();

          const members =
            await getCachedMembers(
              interaction
            );

          const results =
            members
              .filter(member =>
                member.displayName
                  .toLowerCase()
                  .includes(focused) ||
                member.username
                  .toLowerCase()
                  .includes(focused) ||
                member.id.includes(
                  focused
                )
              )
              .slice(
                0,
                25
              )
              .map(member => ({
                name:
                  (
                    member.displayName ||
                    member.username
                  ).slice(
                    0,
                    100
                  ),
                value:
                  member.id
              }));

          await interaction.respond(
            results
          );
        } catch {
          try {
            await interaction.respond(
              []
            );
          } catch {}
        }

        return;
      }

      // =================================================
      // SLASH COMMANDS
      // =================================================

      if (
        interaction.isChatInputCommand()
      ) {
        const commandName =
          interaction.commandName;

        // -----------------------------------------------
        // PING
        // -----------------------------------------------

        if (
          commandName ===
          'ping'
        ) {
          await interaction.reply({
            content:
              '🏓 Pong!',
            ephemeral:
              true
          });

          return;
        }

        // -----------------------------------------------
        // WHISPER
        // -----------------------------------------------

        if (
          commandName ===
          'whisper'
        ) {
          if (!interaction.guild) {
            await interaction.reply({
              content:
                '❌ Use `/whisper` inside a server.',
              ephemeral:
                true
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
              ephemeral:
                true
            });

            return;
          }

          const targetId =
            interaction.options.getString(
              'target',
              true
            );

          const messageContent =
            interaction.options.getString(
              'message',
              true
            ).trim();

          const paragraphCount =
            countParagraphs(
              messageContent
            );

          if (
            paragraphCount > 3
          ) {
            await interaction.reply({
              content:
                `❌ **${paragraphCount} paragraphs** detected. Maximum is 3.`,
              ephemeral:
                true
            });

            return;
          }

          await interaction.deferReply({
            ephemeral:
              true
          });

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

          const requestId =
            interaction.id;

          // ---------------------------------------------
          // PSEUDO CHOICE
          // ---------------------------------------------

          if (!senderPseudo) {
            const panel =
              buildPseudoPanel(
                targetMember.displayName,
                targetMember.id,
                requestId
              );

            const reply =
              await interaction.editReply({
                embeds: [
                  panel.embed
                ],
                components: [
                  panel.row
                ]
              });

            saveSession(
              interaction.user.id,
              interaction.channel.id,
              reply.id,
              'choosing_pseudo',
              {
                targetId:
                  targetMember.id,
                targetDisplayName:
                  targetMember.displayName,
                messageContent
              },
              requestId
            );

            return;
          }

          // ---------------------------------------------
          // DIRECT SEND
          // ---------------------------------------------

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

          const preparingReply =
            await interaction.editReply({
              content:
                '⏳ Preparing your whisper...'
            });

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            preparingReply.id,
            'sending_message',
            {
              targetId:
                targetMember.id,
              targetDisplayName:
                targetMember.displayName,
              messageContent,
              actionKey
            },
            requestId
          );

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
                    actionKey,
                    messageId:
                      created.id
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

            deleteSession(
              interaction.user.id
            );

            await interaction.editReply({
              content:
                '❌ Error saving message. Please try again.'
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
                `✅ **Sent!** ${messageContent.length} characters • ${paragraphCount} paragraphs`
            });

            await showMainMenu(
              interaction
            );
          } else if (
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
          } else {
            await interaction.editReply({
              content:
                `⏳ Message saved. Delivery is pending (${result.attempts}/3). Use \`/recover\` to retry.`
            });
          }

          return;
        }

        // -----------------------------------------------
        // ADMIN
        // -----------------------------------------------

        if (
          commandName ===
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
              ephemeral:
                true
            });

            return;
          }

          await interaction.deferReply({
            ephemeral:
              true
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

        // -----------------------------------------------
        // RECOVER
        // -----------------------------------------------

        if (
          commandName ===
          'recover'
        ) {
          await interaction.deferReply({
            ephemeral:
              true
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
      // PSEUDO BUTTON
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
          parts.length !== 4
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

        const pseudoMap = {
          shadow:
            'Shadow',
          admirer:
            'Secret Admirer',
          friendly:
            'Friendly Curious'
        };

        const pseudo =
          pseudoMap[
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
            targetId ||
          !data.messageContent
        ) {
          await interaction.editReply({
            content:
              '❌ Invalid session data.',
            embeds: [],
            components: []
          });

          deleteSession(
            interaction.user.id
          );

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

        let message;
        let conversation;

        try {
          const transaction =
            db.transaction(() => {
              conversation =
                getOrCreateConversation(
                  interaction.user.id,
                  targetId
                );

              const existingPseudo =
                getUserPseudo(
                  conversation,
                  interaction.user.id
                );

              if (
                existingPseudo &&
                existingPseudo !==
                  pseudo
              ) {
                throw new Error(
                  'You already chose a pseudo for this conversation.'
                );
              }

              if (
                !existingPseudo
              ) {
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

              const created =
                createPendingMessage({
                  conversationId:
                    conversation.id,
                  senderId:
                    interaction.user.id,
                  receiverId:
                    targetId,
                  content:
                    data.messageContent,
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
                  ...data,
                  actionKey,
                  messageId:
                    created.id,
                  pseudo
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
              `❌ ${safeErrorMessage(error)}`,
            embeds: [],
            components: []
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
              `✅ **Sent!** (as ${pseudo})`,
            embeds: [],
            components: []
          });

          await showMainMenu(
            interaction
          );
        } else if (
          result.status ===
          'failed'
        ) {
          deleteSession(
            interaction.user.id
          );

          await interaction.editReply({
            content:
              '❌ Message could not be delivered.',
            embeds: [],
            components: []
          });
        } else {
          await interaction.editReply({
            content:
              `⏳ Message saved. Delivery is pending (${result.attempts}/3).`,
            embeds: [],
            components: []
          });
        }

        return;
      }

      // =================================================
      // RECIPIENT SELECT
      // =================================================

      if (
        interaction.isStringSelectMenu() &&
        interaction.customId.startsWith(
          'select_recipient_'
        )
      ) {
        await interaction.deferUpdate();

        const requestId =
          interaction.customId.split(
            '_'
          )[2];

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
          await interaction.editReply({
            content:
              '❌ Invalid or expired session.',
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
            buildWritingPanel(
              member.displayName,
              member.id,
              requestId
            );

          const reply =
            await interaction.editReply({
              embeds: [
                panel.embed
              ],
              components: [
                panel.row
              ]
            });

          saveSession(
            interaction.user.id,
            interaction.channel.id,
            reply.id,
            'writing_message',
            {
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
          parts.length !== 4
        ) {
          await interaction.reply({
            content:
              '❌ Invalid message form.',
            ephemeral:
              true
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
          session.request_id !==
            requestId ||
          session.state !==
            'writing_message'
        ) {
          await interaction.reply({
            content:
              '❌ Invalid or expired session. Use `/recover`.',
            ephemeral:
              true
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
              '❌ Session data does not match this form.',
            ephemeral:
              true
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
              'Your message (max 3 paragraphs) *'
            )
            .setStyle(
              TextInputStyle.Paragraph
            )
            .setPlaceholder(
              'Type your anonymous message here...'
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
      // SEND MESSAGE MODAL
      // =================================================

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          'send_message_'
        )
      ) {
        await interaction.deferReply({
          ephemeral:
            true
        });

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !== 4
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
              '❌ Invalid or expired session. Use `/recover`.'
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
              '❌ Modal data does not match the active session.'
          });

          return;
        }

        const paragraphs =
          countParagraphs(
            messageContent
          );

        if (
          paragraphs > 3
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
              '❌ No pseudo has been selected for this conversation.'
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
              '⚠️ This whisper is already being processed or has already been completed.'
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
                  actionKey,
                  messageId:
                    created.id
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
              '❌ Error saving message.'
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
              `✅ **Sent!** (as ${senderPseudo})`
          });

          await showMainMenu(
            interaction
          );
        } else if (
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
        } else {
          await interaction.editReply({
            content:
              `⏳ Message saved. Delivery is pending (${result.attempts}/3).`
          });
        }

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

        const originalMessage =
          getMessageById(
            messageId
          );

        if (!originalMessage) {
          await interaction.reply({
            content:
              '❌ Original whisper not found.',
            ephemeral:
              true
          });

          return;
        }

        if (
          originalMessage.receiver_id !==
          interaction.user.id
        ) {
          await interaction.reply({
            content:
              '❌ You are not authorized to reply.',
            ephemeral:
              true
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
              '⚠️ You already have an active operation. Use `/recover` first.',
            ephemeral:
              true
          });

          return;
        }

        const requestId =
          interaction.id;

        // On garde une valeur toujours valide.
        // interaction.message.id est utilisé lorsqu'il existe ;
        // sinon l'ID interne du whisper sert de référence persistante.
        const sessionMessageId =
          interaction.message?.id ||
          String(
            originalMessage.id
          );

        saveSession(
          interaction.user.id,
          interaction.channel?.id,
          sessionMessageId,
          'reply_writing',
          {
            originalMessageId:
              originalMessage.id
          },
          requestId
        );

        const modal =
          new ModalBuilder()
            .setCustomId(
              `reply_modal_${originalMessage.id}_${requestId}`
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
              'Your reply (max 3 paragraphs) *'
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
          parts.length !== 4
        ) {
          await interaction.reply({
            content:
              '❌ Invalid recovery button.',
            ephemeral:
              true
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
            ephemeral:
              true
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
              'Your reply (max 3 paragraphs) *'
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
          ephemeral:
            true
        });

        const parts =
          interaction.customId.split(
            '_'
          );

        if (
          parts.length !== 4
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

        const replier =
          interaction.user;

        const session =
          getSession(
            replier.id
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
          paragraphs > 3
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
            replier.id
          );

          await interaction.editReply({
            content:
              '❌ Original whisper not found.'
          });

          return;
        }

        if (
          original.receiver_id !==
          replier.id
        ) {
          deleteSession(
            replier.id
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
            replier.id
          )
        ) {
          await interaction.editReply({
            content:
              '⚠️ This reply is already being processed.'
          });

          return;
        }

        let savedMessage;
        let conversation;

        try {
          const transaction =
            db.transaction(() => {
              conversation =
                getOrCreateConversation(
                  replier.id,
                  senderId
                );

              savedMessage =
                createPendingMessage({
                  conversationId:
                    conversation.id,
                  senderId:
                    replier.id,
                  receiverId:
                    senderId,
                  content:
                    replyContent,
                  requestId,
                  actionKey
                });

              linkActionToMessage(
                actionKey,
                savedMessage.id
              );

              updateSessionData(
                replier.id,
                'delivery_pending',
                {
                  originalMessageId:
                    original.id,
                  actionKey,
                  messageId:
                    savedMessage.id
                }
              );
            });

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
            replier.id
          );

          await interaction.editReply({
            content:
              '✅ Reply sent!'
          });
        } else if (
          result.status ===
          'failed'
        ) {
          deleteSession(
            replier.id
          );

          await interaction.editReply({
            content:
              '❌ Reply could not be delivered.'
          });
        } else {
          await interaction.editReply({
            content:
              `⏳ Reply saved. Delivery is pending (${result.attempts}/3).`
          });
        }

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
          ephemeral:
            true
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

        const pseudoMap = {};

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
            .join('\n\n');

        if (
          historyText.length >
          1000
        ) {
          historyText =
            `${historyText.slice(0, 1000)}...`;
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
          embeds: [
            embed
          ]
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
          ephemeral:
            true
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
          getConversationOtherParticipant(
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
          components: [
            row
          ]
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
            components: []
          });

          return;
        }

        const otherParticipant =
          getConversationOtherParticipant(
            conversation,
            interaction.user.id
          );

        if (!otherParticipant) {
          await interaction.editReply({
            content:
              '❌ You are not part of this conversation.',
            components: []
          });

          return;
        }

        if (
          conversation.is_blocked
        ) {
          await interaction.editReply({
            content:
              '⚠️ This conversation is already blocked.',
            components: []
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
            components: []
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
              components: []
            });

            return;
          }

          completeAction(
            actionKey
          );
        } catch {
          failAction(
            actionKey
          );

          await interaction.editReply({
            content:
              '❌ Error blocking the conversation.',
            components: []
          });

          return;
        }

        await interaction.editReply({
          content:
            '✅ **Blocked.**',
          components: []
        });

        try {
          const sender =
            await client.users.fetch(
              otherParticipant
            );

          await sender.send({
            content:
              '🚫 **You have been blocked.**'
          });
        } catch {}

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
          components: []
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
            ephemeral:
              true
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
          body: commands
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

function shutdown(signal) {
  console.log(
    `🛑 ${signal} received.`
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
  () => shutdown('SIGTERM')
);

process.on(
  'SIGINT',
  () => shutdown('SIGINT')
);

// =====================================================
// LOGIN
// =====================================================

client.login(
  process.env.TOKEN
);