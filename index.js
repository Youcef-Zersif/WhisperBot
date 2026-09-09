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
  UserSelectMenuBuilder,
  MessageFlags,
  PermissionsBitField
} = require('discord.js');

const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

dotenv.config();

if (!process.env.TOKEN) {
  console.error('❌ TOKEN environment variable is missing.');
  process.exit(1);
}

// =====================================================
// DATABASE
// =====================================================

const db = new sqlite3.Database(path.join(__dirname, 'whispers.db'));

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initializeDatabase() {
  console.log('🔄 Initializing database...');

  await dbRun(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      pseudo_a TEXT,
      pseudo_b TEXT,
      is_blocked BOOLEAN DEFAULT 0,
      blocked_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      content TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS whisper_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL UNIQUE,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ Database ready.');
}

// =====================================================
// DISCORD CLIENT
// =====================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// =====================================================
// CONSTANTS
// =====================================================

const BANNER_URL = 'https://cdn.discordapp.com/attachments/1545825179895074946/1545861012815614022/file_0000000038dc8210b6ae006f111c6e65.webp';

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

const PANEL_MARKER = 'VEGAS_WHISPERS_PERMANENT_PANEL';
const PURPLE = 0x6C2BD9;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_PARAGRAPHS = 3;

function getRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

function safeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function countParagraphs(content) {
  return content.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

function getOtherParticipant(conversation, userId) {
  if (conversation.user_a_id === userId) return conversation.user_b_id;
  if (conversation.user_b_id === userId) return conversation.user_a_id;
  return null;
}

// =====================================================
// CONVERSATIONS
// =====================================================

async function getConversationById(conversationId) {
  return dbGet(`SELECT * FROM conversations WHERE id = ?`, [conversationId]);
}

async function getOrCreateConversation(userA, userB) {
  const existing = await dbGet(`
    SELECT * FROM conversations WHERE
    (user_a_id = ? AND user_b_id = ?) OR
    (user_a_id = ? AND user_b_id = ?)
  `, [userA, userB, userB, userA]);

  if (existing) {
    if (existing.is_blocked) throw new Error('Conversation is blocked');
    return existing;
  }

  const [a, b] = [userA, userB].sort();
  const result = await dbRun(
    `INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`,
    [a, b]
  );
  return getConversationById(result.lastID);
}

async function getUserPseudo(conversation, userId) {
  if (conversation.user_a_id === userId) return conversation.pseudo_a;
  if (conversation.user_b_id === userId) return conversation.pseudo_b;
  return null;
}

async function setUserPseudo(conversationId, userId, pseudo) {
  await dbRun(
    `UPDATE conversations SET pseudo_a = ? WHERE id = ? AND user_a_id = ?`,
    [pseudo, conversationId, userId]
  );
  await dbRun(
    `UPDATE conversations SET pseudo_b = ? WHERE id = ? AND user_b_id = ?`,
    [pseudo, conversationId, userId]
  );
}

async function blockConversation(conversationId, userId) {
  const conversation = await getConversationById(conversationId);
  if (!conversation) throw new Error('Conversation not found');
  if (!getOtherParticipant(conversation, userId)) throw new Error('Not a participant');
  if (conversation.is_blocked) return false;

  const result = await dbRun(
    `UPDATE conversations SET is_blocked = 1, blocked_by = ? WHERE id = ? AND is_blocked = 0`,
    [userId, conversationId]
  );
  return result.changes > 0;
}

// =====================================================
// MESSAGES
// =====================================================

async function createMessage(conversationId, senderId, receiverId, content) {
  const result = await dbRun(`
    INSERT INTO messages (conversation_id, sender_id, receiver_id, content)
    VALUES (?, ?, ?, ?)
  `, [conversationId, senderId, receiverId, content]);
  return dbGet(`SELECT * FROM messages WHERE id = ?`, [result.lastID]);
}

async function deleteMessage(messageId) {
  await dbRun(`DELETE FROM messages WHERE id = ?`, [messageId]);
}

async function getMessageById(messageId) {
  return dbGet(`SELECT * FROM messages WHERE id = ?`, [messageId]);
}

async function getConversationHistory(conversationId, limit = 10) {
  const rows = await dbAll(`
    SELECT sender_id, content, sent_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY id DESC
    LIMIT ?
  `, [conversationId, limit]);
  return rows.reverse();
}

// =====================================================
// PANEL MANAGEMENT
// =====================================================

async function getConfiguredPanel(guildId) {
  return dbGet(`SELECT * FROM whisper_panels WHERE guild_id = ?`, [guildId]);
}

async function savePanelConfig(guildId, channelId, messageId) {
  await dbRun(`
    INSERT INTO whisper_panels (guild_id, channel_id, message_id, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(guild_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      updated_at = CURRENT_TIMESTAMP
  `, [guildId, channelId, messageId]);
}

async function deletePanelConfig(guildId) {
  await dbRun(`DELETE FROM whisper_panels WHERE guild_id = ?`, [guildId]);
}

async function getAllPanelConfigs() {
  return dbAll(`SELECT * FROM whisper_panels`);
}

// =====================================================
// UI BUILDERS
// =====================================================

function buildPermanentPanel() {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setImage(BANNER_URL)
    .setTitle('💋 Vegas Whispers')
    .setDescription(
      'Send an anonymous whisper to another member.\n\n' +
      'Choose a member from the menu below.\n' +
      '🌙 Choose your anonymous identity.\n' +
      '✍️ Write your message.\n\n' +
      'Your identity remains hidden from the recipient.'
    )
    .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
    .setFooter({ text: '📩 Vegas Whispers' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('vw_open_whisper')
      .setLabel('💋 Send a Whisper')
      .setStyle(ButtonStyle.Primary)
  );

  return { content: PANEL_MARKER, embeds: [embed], components: [row] };
}

function buildMemberPanel(requestId) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setImage(BANNER_URL)
    .setTitle('💋 Vegas Whispers')
    .setDescription('Choose the member you want to whisper to.')
    .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
    .setFooter({ text: '📩 Vegas Whispers' });

  const select = new UserSelectMenuBuilder()
    .setCustomId(`vw_recipient_${requestId}`)
    .setPlaceholder('Select a member...');

  const components = [
    new ActionRowBuilder().addComponents(select),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`vw_cancel_${requestId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Secondary)
    )
  ];

  return { embeds: [embed], components };
}

function buildPseudoPanel(targetDisplayName, targetId, requestId) {
  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setImage(BANNER_URL)
    .setTitle('🌙 Choose Your Identity')
    .setDescription(
      `You are about to whisper to **${targetDisplayName}**.\n\n` +
      'Choose one identity for this conversation.'
    )
    .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
    .setFooter({ text: '📩 Vegas Whispers' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vw_pseudo_${targetId}_${requestId}_shadow`)
      .setLabel('👤 Shadow')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`vw_pseudo_${targetId}_${requestId}_admirer`)
      .setLabel('❤️ Secret Admirer')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`vw_pseudo_${targetId}_${requestId}_friendly`)
      .setLabel('🤝 Friendly Curious')
      .setStyle(ButtonStyle.Success)
  );

  return { embeds: [embed], components: [row] };
}

function buildMessageModal(targetId, requestId) {
  return new ModalBuilder()
    .setCustomId(`vw_message_modal_${targetId}_${requestId}`)
    .setTitle('✍️ Your Whisper')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('whisper_content')
          .setLabel('Anonymous message')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Write your message here...')
          .setRequired(true)
          .setMaxLength(MAX_MESSAGE_LENGTH)
      )
    );
}

function buildReplyModal(messageId) {
  return new ModalBuilder()
    .setCustomId(`vw_reply_modal_${messageId}`)
    .setTitle('💬 Reply')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('reply_content')
          .setLabel('Your anonymous reply')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Write your reply...')
          .setRequired(true)
          .setMaxLength(MAX_MESSAGE_LENGTH)
      )
    );
}

function buildWhisperPayload(message, conversation, pseudoOverride = null) {
  const pseudo = pseudoOverride || getUserPseudo(conversation, message.sender_id) || 'Anonymous';

  const embed = new EmbedBuilder()
    .setColor(PURPLE)
    .setImage(BANNER_URL)
    .setAuthor({ name: `💬 ${pseudo}` })
    .setDescription(message.content || '')
    .setFooter({ text: '📩 Vegas Whispers' })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`vw_reply_${message.id}`)
      .setLabel('💬 Reply')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vw_block_${message.conversation_id}`)
      .setLabel('🚫 Block Sender')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`vw_history_${message.conversation_id}`)
      .setLabel('📜 History')
      .setStyle(ButtonStyle.Secondary)
  );

  return {
    content: '👋 **You received a whisper:**',
    embeds: [embed],
    components: [row]
  };
}

// =====================================================
// PERMANENT PANEL MANAGEMENT
// =====================================================

async function ensurePermanentPanel(guild) {
  try {
    const config = await getConfiguredPanel(guild.id);
    if (!config) return;

    const channel = await client.channels.fetch(config.channel_id).catch(() => null);
    if (!channel) {
      console.log(`⚠️ Configured channel ${config.channel_id} not found. Cleaning config.`);
      await deletePanelConfig(guild.id);
      return;
    }

    const panel = buildPermanentPanel();

    let panelMessage = null;
    if (config.message_id) {
      try {
        panelMessage = await channel.messages.fetch(config.message_id);
      } catch { panelMessage = null; }
    }

    if (!panelMessage) {
      const messages = await channel.messages.fetch({ limit: 100 });
      panelMessage = messages.find(m =>
        m.author?.id === client.user?.id &&
        (m.content === PANEL_MARKER ||
         m.components?.some(row => row.components?.some(c => c.customId === 'vw_open_whisper')))
      ) || null;
    }

    if (panelMessage) {
      await panelMessage.edit(panel);
      await savePanelConfig(guild.id, channel.id, panelMessage.id);
      console.log(`✅ Permanent panel updated in #${channel.name}`);
      return;
    }

    const newMessage = await channel.send(panel);
    await savePanelConfig(guild.id, channel.id, newMessage.id);
    console.log(`✅ Permanent panel created in #${channel.name}`);
  } catch (error) {
    console.error(`❌ Panel error for guild ${guild.id}:`, safeErrorMessage(error));
  }
}

async function ensureAllPermanentPanels() {
  const configs = await getAllPanelConfigs();
  for (const config of configs) {
    const guild = client.guilds.cache.get(config.guild_id);
    if (guild) {
      await ensurePermanentPanel(guild);
    } else {
      console.log(`⚠️ Guild ${config.guild_id} not found. Cleaning config.`);
      await deletePanelConfig(config.guild_id);
    }
  }
}

// =====================================================
// MEMBER CACHE
// =====================================================

const memberCache = new Map();

async function getCachedMembers(guild, excludedUserId) {
  if (!guild) return [];
  const cached = memberCache.get(guild.id);
  const now = Date.now();
  if (cached && now - cached.updatedAt < 60000) {
    return cached.members.filter(m => m.id !== excludedUserId);
  }

  try {
    await guild.members.fetch();
    const members = guild.members.cache
      .filter(m => !m.user.bot)
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.displayName || m.user.username
      }));
    memberCache.set(guild.id, { members, updatedAt: now });
    return members.filter(m => m.id !== excludedUserId);
  } catch (error) {
    console.error('❌ Member fetch error:', safeErrorMessage(error));
    return cached?.members.filter(m => m.id !== excludedUserId) || [];
  }
}

// =====================================================
// TEMPORARY SESSION DATA (in-memory)
// =====================================================

if (!global.tempWhisperData) {
  global.tempWhisperData = {};
}

// =====================================================
// INTERACTION HANDLER
// =====================================================

client.on('interactionCreate', async interaction => {
  try {
    // --- SLASH COMMANDS ---
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong!', flags: MessageFlags.Ephemeral });
        return;
      }

      if (commandName === 'whisper') {
        if (!interaction.guild) {
          await interaction.reply({
            content: '❌ Use `/whisper` inside a server.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const config = await getConfiguredPanel(interaction.guild.id);
        if (!config || config.channel_id !== interaction.channel.id) {
          await interaction.reply({
            content: '❌ Vegas Whispers is not activated in this channel. Ask an admin to run `/admin panel`.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const requestId = interaction.id;
        const panel = buildMemberPanel(requestId);
        await interaction.editReply(panel);
        return;
      }

      if (commandName === 'admin') {
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'panel') {
          if (!interaction.guild || !interaction.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.reply({
              content: '❌ Admin only.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });

          const channel = interaction.channel;
          const panel = buildPermanentPanel();

          const oldConfig = await getConfiguredPanel(interaction.guild.id);
          if (oldConfig) {
            try {
              const oldChannel = await client.channels.fetch(oldConfig.channel_id);
              if (oldChannel) {
                const oldMsg = await oldChannel.messages.fetch(oldConfig.message_id).catch(() => null);
                if (oldMsg) await oldMsg.delete().catch(() => {});
              }
            } catch {}
          }

          const newMessage = await channel.send(panel);
          await savePanelConfig(interaction.guild.id, channel.id, newMessage.id);

          await interaction.editReply({
            content: `✅ Vegas Whispers activated in ${channel.toString()}!`,
            embeds: [],
            components: []
          });
          return;
        }

        if (subcommand === 'find') {
          if (!interaction.guild || !interaction.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
            await interaction.reply({
              content: '❌ Admin only.',
              flags: MessageFlags.Ephemeral
            });
            return;
          }

          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const messageId = interaction.options.getString('message_id', true);

          const row = await dbGet(
            `SELECT sender_id, content, sent_at FROM messages WHERE id = ?`,
            [messageId]
          );

          if (!row) {
            await interaction.editReply({ content: '❌ Message not found.' });
            return;
          }

          try {
            const user = await client.users.fetch(row.sender_id);
            const embed = new EmbedBuilder()
              .setColor(PURPLE)
              .setTitle('🔍 Message Sender')
              .addFields(
                { name: 'User', value: user.tag, inline: true },
                { name: 'ID', value: user.id, inline: true },
                { name: 'Content', value: (row.content || '').slice(0, 1024) || '(empty)', inline: false },
                { name: 'Sent', value: new Date(row.sent_at).toLocaleString(), inline: true }
              )
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } catch {
            await interaction.editReply({ content: '❌ User not found.' });
          }
          return;
        }
      }
    }

    // --- BUTTON: Open Whisper from panel ---
    if (interaction.isButton() && interaction.customId === 'vw_open_whisper') {
      if (!interaction.guild) {
        await interaction.reply({
          content: '❌ Use the panel inside a server.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const config = await getConfiguredPanel(interaction.guild.id);
      if (!config || config.channel_id !== interaction.channel.id) {
        await interaction.reply({
          content: '❌ Vegas Whispers is not activated in this channel.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const requestId = interaction.id;
      const panel = buildMemberPanel(requestId);
      await interaction.editReply(panel);
      return;
    }

    // --- SELECT: Recipient (UserSelectMenu) ---
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('vw_recipient_')) {
      await interaction.deferUpdate();
      const requestId = interaction.customId.slice('vw_recipient_'.length);
      const target = interaction.users.first();
      if (!target) {
        await interaction.editReply({ content: '❌ User not found.', embeds: [], components: [] });
        return;
      }

      const targetMember = await interaction.guild?.members.fetch(target.id).catch(() => null);
      const displayName = targetMember?.displayName || target.username;

      const panel = buildPseudoPanel(displayName, target.id, requestId);
      await interaction.editReply(panel);
      return;
    }

    // --- BUTTON: Cancel ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_cancel_')) {
      await interaction.update({ content: '❌ Whisper cancelled.', embeds: [], components: [] });
      return;
    }

    // --- BUTTON: Pseudonym (opens message modal directly) ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_pseudo_')) {
      const parts = interaction.customId.split('_');
      if (parts.length !== 5) {
        await interaction.reply({ content: '❌ Invalid pseudo action.', flags: MessageFlags.Ephemeral });
        return;
      }
      const targetId = parts[2];
      const requestId = parts[3];
      const pseudoType = parts[4];
      const pseudo = PSEUDOS[pseudoType];
      if (!pseudo) {
        await interaction.reply({ content: '❌ Invalid pseudo.', flags: MessageFlags.Ephemeral });
        return;
      }

      global.tempWhisperData[requestId] = { targetId, pseudo };

      await interaction.showModal(buildMessageModal(targetId, requestId));
      return;
    }

    // --- MODAL: Send Whisper ---
    if (interaction.isModalSubmit() && interaction.customId.startsWith('vw_message_modal_')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const rest = interaction.customId.slice('vw_message_modal_'.length);
      const sep = rest.lastIndexOf('_');
      if (sep <= 0) {
        await interaction.editReply({ content: '❌ Invalid message form.' });
        return;
      }
      const targetId = rest.slice(0, sep);
      const requestId = rest.slice(sep + 1);

      const content = interaction.fields.getTextInputValue('whisper_content').trim();
      if (!content) {
        await interaction.editReply({ content: '❌ Message cannot be empty.' });
        return;
      }
      if (content.length > MAX_MESSAGE_LENGTH) {
        await interaction.editReply({ content: `❌ Maximum ${MAX_MESSAGE_LENGTH} characters.` });
        return;
      }
      if (countParagraphs(content) > MAX_PARAGRAPHS) {
        await interaction.editReply({ content: `❌ Maximum ${MAX_PARAGRAPHS} paragraphs allowed.` });
        return;
      }

      if (!global.tempWhisperData || !global.tempWhisperData[requestId]) {
        await interaction.editReply({ content: '❌ Session expired. Please start over from the panel.' });
        return;
      }

      const { targetId: storedTargetId, pseudo } = global.tempWhisperData[requestId];
      if (storedTargetId !== targetId) {
        await interaction.editReply({ content: '❌ Target mismatch. Please start over.' });
        delete global.tempWhisperData[requestId];
        return;
      }

      try {
        const conversation = await getOrCreateConversation(interaction.user.id, targetId);
        if (conversation.is_blocked) {
          await interaction.editReply({ content: '❌ This conversation is blocked.' });
          delete global.tempWhisperData[requestId];
          return;
        }

        // -- Pseudo logic --
        const existingPseudo = await getUserPseudo(conversation, interaction.user.id);
        const effectivePseudo = existingPseudo || pseudo;

        if (!existingPseudo) {
          await setUserPseudo(conversation.id, interaction.user.id, pseudo);
        }

        // 1. Créer le message
        const message = await createMessage(
          conversation.id,
          interaction.user.id,
          targetId,
          content
        );

        // 2. Construire le payload et envoyer (protégé)
        try {
          const target = await client.users.fetch(targetId);
          const payload = buildWhisperPayload(message, conversation, effectivePseudo);
          await target.send(payload);

          // Succès
          await interaction.editReply({
            content: `✅ **Sent!** (as ${effectivePseudo})`,
            embeds: [],
            components: []
          });
        } catch (sendError) {
          // Échec : supprimer le message
          await deleteMessage(message.id);
          console.error('❌ Send error:', safeErrorMessage(sendError));
          await interaction.editReply({
            content: '❌ Message not sent. Please try again.',
            embeds: [],
            components: []
          });
        }

        delete global.tempWhisperData[requestId];
      } catch (error) {
        console.error('❌ Send error:', safeErrorMessage(error));
        await interaction.editReply({
          content: '❌ Message not sent. Please try again.',
          embeds: [],
          components: []
        });
        delete global.tempWhisperData[requestId];
      }
      return;
    }

    // --- BUTTON: Reply ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_reply_')) {
      const messageId = interaction.customId.slice('vw_reply_'.length);
      const original = await getMessageById(messageId);

      if (!original) {
        await interaction.reply({
          content: '❌ Whisper not found.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (original.receiver_id !== interaction.user.id) {
        await interaction.reply({
          content: '❌ You cannot reply to this whisper.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.showModal(buildReplyModal(messageId));
      return;
    }

    // --- MODAL: Reply ---
    if (interaction.isModalSubmit() && interaction.customId.startsWith('vw_reply_modal_')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const originalId = interaction.customId.slice('vw_reply_modal_'.length);

      const original = await getMessageById(originalId);
      if (!original) {
        await interaction.editReply({ content: '❌ Whisper not found.' });
        return;
      }

      if (original.receiver_id !== interaction.user.id) {
        await interaction.editReply({ content: '❌ You cannot reply to this.' });
        return;
      }

      const content = interaction.fields.getTextInputValue('reply_content').trim();
      if (!content) {
        await interaction.editReply({ content: '❌ Reply cannot be empty.' });
        return;
      }
      if (content.length > MAX_MESSAGE_LENGTH) {
        await interaction.editReply({ content: `❌ Maximum ${MAX_MESSAGE_LENGTH} characters.` });
        return;
      }
      if (countParagraphs(content) > MAX_PARAGRAPHS) {
        await interaction.editReply({ content: `❌ Maximum ${MAX_PARAGRAPHS} paragraphs.` });
        return;
      }

      const conversation = await getConversationById(original.conversation_id);
      if (!conversation || conversation.is_blocked) {
        await interaction.editReply({ content: '❌ Conversation is blocked.' });
        return;
      }

      // -- Pseudo pour le répondant --
      const responderPseudo = await getUserPseudo(conversation, interaction.user.id) || 'Anonymous';

      try {
        // 1. Créer le message de reply
        const replyMessage = await createMessage(
          conversation.id,
          interaction.user.id,
          original.sender_id,
          content
        );

        // 2. Envoyer protégé
        try {
          const target = await client.users.fetch(original.sender_id);
          const payload = buildWhisperPayload(replyMessage, conversation, responderPseudo);
          await target.send(payload);

          await interaction.editReply({
            content: '✅ Reply sent!',
            embeds: [],
            components: []
          });
        } catch (sendError) {
          await deleteMessage(replyMessage.id);
          console.error('❌ Reply send error:', safeErrorMessage(sendError));
          await interaction.editReply({
            content: '❌ Reply not sent. Please try again.',
            embeds: [],
            components: []
          });
        }
      } catch (error) {
        console.error('❌ Reply error:', safeErrorMessage(error));
        await interaction.editReply({
          content: '❌ Reply not sent. Please try again.',
          embeds: [],
          components: []
        });
      }
      return;
    }

    // --- BUTTON: Block ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_block_')) {
      const conversationId = interaction.customId.slice('vw_block_'.length);
      const conversation = await getConversationById(conversationId);

      if (!conversation) {
        await interaction.reply({
          content: '❌ Conversation not found.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!getOtherParticipant(conversation, interaction.user.id)) {
        await interaction.reply({
          content: '❌ Not part of this conversation.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`vw_confirm_block_${conversationId}`)
          .setLabel('🚫 Confirm Block')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`vw_cancel_block_${conversationId}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.reply({
        content: '⚠️ Block this sender?',
        components: [row],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // --- BUTTON: Confirm Block ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_confirm_block_')) {
      await interaction.deferUpdate();
      const conversationId = interaction.customId.slice('vw_confirm_block_'.length);

      try {
        const conversation = await getConversationById(conversationId);
        if (!conversation) {
          await interaction.editReply({ content: '❌ Conversation not found.', components: [] });
          return;
        }

        if (!getOtherParticipant(conversation, interaction.user.id)) {
          await interaction.editReply({ content: '❌ Not part of this conversation.', components: [] });
          return;
        }

        if (conversation.is_blocked) {
          await interaction.editReply({ content: '⚠️ Already blocked.', components: [] });
          return;
        }

        const blocked = await blockConversation(conversationId, interaction.user.id);
        if (!blocked) {
          await interaction.editReply({ content: '⚠️ Already blocked.', components: [] });
          return;
        }

        await interaction.editReply({ content: '✅ Blocked.', components: [] });
      } catch (error) {
        await interaction.editReply({
          content: `❌ ${safeErrorMessage(error)}`,
          components: []
        });
      }
      return;
    }

    // --- BUTTON: Cancel Block ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_cancel_block_')) {
      await interaction.update({ content: '❎ Cancelled.', components: [] });
      return;
    }

    // --- BUTTON: History ---
    if (interaction.isButton() && interaction.customId.startsWith('vw_history_')) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const conversationId = interaction.customId.slice('vw_history_'.length);

      const conversation = await getConversationById(conversationId);
      if (!conversation) {
        await interaction.editReply({ content: '❌ Conversation not found.' });
        return;
      }

      if (!getOtherParticipant(conversation, interaction.user.id)) {
        await interaction.editReply({ content: '❌ Not part of this conversation.' });
        return;
      }

      const history = await getConversationHistory(conversationId, 10);
      if (!history.length) {
        await interaction.editReply({ content: '📜 No messages yet.' });
        return;
      }

      const lines = history.map(row => {
        const pseudo = getUserPseudo(conversation, row.sender_id) || 'Anonymous';
        return `**${pseudo}:** ${(row.content || '').slice(0, 500)}`;
      });

      const embed = new EmbedBuilder()
        .setColor(PURPLE)
        .setTitle('📜 Vegas Whispers History')
        .setDescription(lines.join('\n\n').slice(0, 4000))
        .setFooter({ text: '📩 Vegas Whispers' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // --- Fallback for unhandled interactions ---
    if (interaction.isButton() || interaction.isUserSelectMenu() || interaction.isModalSubmit()) {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: '❌ This action is no longer valid. Use the Vegas Whispers panel.',
          flags: MessageFlags.Ephemeral
        });
      }
    }

  } catch (error) {
    console.error('❌ Interaction error:', safeErrorMessage(error));
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
          content: '❌ Something went wrong. Please try again.',
          embeds: [],
          components: []
        });
      } else {
        await interaction.reply({
          content: '❌ Something went wrong. Please try again.',
          flags: MessageFlags.Ephemeral
        });
      }
    } catch { /* ignore */ }
  }
});

// =====================================================
// SLASH COMMANDS
// =====================================================

const slashCommands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies Pong!'),
  new SlashCommandBuilder().setName('whisper').setDescription('Open Vegas Whispers'),
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .addSubcommand(sub =>
      sub.setName('panel')
        .setDescription('Activate Vegas Whispers in this channel')
    )
    .addSubcommand(sub =>
      sub.setName('find')
        .setDescription('Find sender of a message')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('Internal whisper message ID')
            .setRequired(true)
        )
    )
].map(cmd => cmd.toJSON());

// =====================================================
// STARTUP
// =====================================================

client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);

  await initializeDatabase();

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Slash registration error:', safeErrorMessage(error));
  }

  await ensureAllPermanentPanels();

  console.log('✅ Vegas Whispers ready.');
});

// =====================================================
// MESSAGE DELETE RECOVERY
// =====================================================

client.on('messageDelete', async message => {
  if (message.author?.id !== client.user?.id) return;
  if (!message.channel?.isTextBased()) return;

  const config = await getConfiguredPanel(message.guild?.id);
  if (!config) return;
  if (config.channel_id !== message.channel.id) return;
  if (config.message_id !== message.id) return;

  console.log(`🔄 Panel deleted in #${message.channel.name}. Recreating...`);
  await ensurePermanentPanel(message.guild);
});

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

function shutdown(signal) {
  console.log(`🛑 Received ${signal}. Shutting down safely...`);
  client.destroy();
  db.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// =====================================================
// LOGIN
// =====================================================

client.login(process.env.TOKEN);


