const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} = require('discord.js');
const dotenv = require('dotenv');
const Database = require('better-sqlite3');
const path = require('path');

dotenv.config();

const db = new Database(path.join(__dirname, 'whispers.db'));

// ===== TABLES =====
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
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    content TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS active_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    state TEXT NOT NULL,
    data TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel]
});

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

function getRandomQuote() {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies Pong!'),
  new SlashCommandBuilder().setName('whisper').setDescription('Send an anonymous message'),
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .addSubcommand(sub =>
      sub.setName('find')
        .setDescription('Find sender of a message')
        .addStringOption(opt =>
          opt.setName('message_id')
            .setDescription('The message ID to look up')
            .setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName('recover')
    .setDescription('Recover an interrupted session')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// ===== FONCTIONS BDD =====
function getOrCreateConversation(userA, userB) {
  let row = db.prepare(`
    SELECT * FROM conversations WHERE
    (user_a_id = ? AND user_b_id = ?) OR
    (user_a_id = ? AND user_b_id = ?)
  `).get(userA, userB, userB, userA);

  if (row) {
    if (row.is_blocked) throw new Error('Conversation is blocked');
    return row;
  }

  const info = db.prepare(`
    INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)
  `).run(userA, userB);

  row = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(info.lastInsertRowid);
  return row;
}

function saveMessage(conversationId, senderId, receiverId, content) {
  const info = db.prepare(`
    INSERT INTO messages (conversation_id, sender_id, receiver_id, content)
    VALUES (?, ?, ?, ?)
  `).run(conversationId, senderId, receiverId, content);

  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(info.lastInsertRowid);
}

function getMessageById(messageId) {
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId);
}

function getUserPseudo(conversation, userId) {
  if (conversation.user_a_id === userId) return conversation.pseudo_a;
  if (conversation.user_b_id === userId) return conversation.pseudo_b;
  return null;
}

function setUserPseudo(conversationId, userId, pseudo) {
  db.prepare(`
    UPDATE conversations SET pseudo_a = ? WHERE id = ? AND user_a_id = ?
  `).run(pseudo, conversationId, userId);

  db.prepare(`
    UPDATE conversations SET pseudo_b = ? WHERE id = ? AND user_b_id = ?
  `).run(pseudo, conversationId, userId);
}

function blockConversation(conversationId, userId) {
  db.prepare(`
    UPDATE conversations SET is_blocked = 1, blocked_by = ? WHERE id = ?
  `).run(userId, conversationId);
}

function getLastMessage(conversationId) {
  return db.prepare(`
    SELECT sender_id, content, sent_at FROM messages
    WHERE conversation_id = ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(conversationId);
}

function getConversationHistory(conversationId, limit) {
  const rows = db.prepare(`
    SELECT sender_id, content, sent_at FROM messages
    WHERE conversation_id = ?
    ORDER BY sent_at DESC LIMIT ?
  `).all(conversationId, limit);
  return rows.reverse();
}

function saveSession(userId, channelId, messageId, state, data) {
  const jsonData = data ? JSON.stringify(data) : null;
  db.prepare(`
    INSERT OR REPLACE INTO active_sessions (user_id, channel_id, message_id, state, data, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(userId, channelId, messageId, state, jsonData);
}

function getSession(userId) {
  return db.prepare(`
    SELECT * FROM active_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1
  `).get(userId);
}

function deleteSession(userId) {
  db.prepare(`DELETE FROM active_sessions WHERE user_id = ?`).run(userId);
}

function getAllSessions() {
  return db.prepare(`SELECT * FROM active_sessions`).all();
}

async function restorePersistentViews() {
  console.log('🔄 Restoring persistent views...');
  const sessions = getAllSessions();
  sessions.forEach(session => {
    console.log(`  ↳ Session for user ${session.user_id} (state: ${session.state})`);
  });
  console.log(`✅ Restored ${sessions.length} active sessions.`);
}

// ===== CACHE DES MEMBRES =====
const memberCache = new Map();

async function getCachedMembers(interaction) {
  if (!interaction.guild) return [];

  const guildId = interaction.guild.id;
  const now = Date.now();
  const cacheEntry = memberCache.get(guildId);

  if (cacheEntry && (now - cacheEntry.lastUpdated) < 60000) {
    return cacheEntry.members;
  }

  try {
    await interaction.guild.members.fetch();
    const members = interaction.guild.members.cache
      .filter(m => !m.user.bot && m.user.id !== interaction.user.id)
      .map(m => ({
        id: m.user.id,
        username: m.user.username,
        displayName: m.displayName
      }));

    memberCache.set(guildId, {
      members: members,
      lastUpdated: now
    });

    return members;
  } catch (error) {
    console.error('❌ Error fetching members:', error.message);
    if (cacheEntry) return cacheEntry.members;
    return [];
  }
}

async function showMainMenu(interaction) {
  try {
    if (!interaction.guild) {
      await interaction.followUp({
        content: '❌ This command must be used in a server, not in DMs.',
        ephemeral: true
      });
      return;
    }

    const members = await getCachedMembers(interaction);

    if (members.length === 0) {
      await interaction.followUp({
        content: '❌ No members found in this server.',
        ephemeral: true
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x6C2BD9)
      .setImage(BANNER_URL)
      .setTitle('💋 Who deserves your whisper?')
      .setDescription('Select a server member to send an anonymous message to.')
      .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
      .setFooter({ text: 'Vegas Whispers • Your identity is safe' })
      .setTimestamp();

    const select = new StringSelectMenuBuilder()
      .setCustomId('select_recipient')
      .setPlaceholder('Choose a member...')
      .addOptions(
        members.slice(0, 25).map(m =>
          new StringSelectMenuOptionBuilder()
            .setLabel(m.displayName || m.username)
            .setValue(m.id)
        )
      );

    const row = new ActionRowBuilder().addComponents(select);
    const cancelRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('cancel_whisper')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

    if (interaction.replied || interaction.deferred) {
      const reply = await interaction.followUp({
        embeds: [embed],
        components: [row, cancelRow],
        ephemeral: true
      });
      saveSession(interaction.user.id, interaction.channel.id, reply.id, 'selecting_recipient', { guildId: interaction.guild?.id });
    } else {
      const reply = await interaction.reply({
        embeds: [embed],
        components: [row, cancelRow],
        ephemeral: true
      });
      saveSession(interaction.user.id, interaction.channel.id, reply.id, 'selecting_recipient', { guildId: interaction.guild?.id });
    }
  } catch (error) {
    console.error('❌ Error in showMainMenu:', error);
    try {
      await interaction.followUp({ content: '❌ An error occurred. Please try again with `/whisper`.', ephemeral: true });
    } catch (e) {
      console.error('❌ Could not send error message:', e);
    }
  }
}

// ===== INTERACTION HANDLER =====
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
        return;
      }

      if (commandName === 'whisper') {
        await interaction.deferReply({ ephemeral: true });
        await showMainMenu(interaction);
        return;
      }

      if (commandName === 'admin') {
        await interaction.deferReply({ ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (!interaction.member.permissions.has('Administrator')) {
          await interaction.editReply({ content: '❌ Admin only.' });
          return;
        }
        if (sub === 'find') {
          const msgId = interaction.options.getString('message_id');
          const row = db.prepare(`SELECT sender_id, content, sent_at FROM messages WHERE id = ?`).get(msgId);
          if (!row) {
            await interaction.editReply({ content: '❌ Message not found.' });
            return;
          }
          try {
            const user = await client.users.fetch(row.sender_id);
            const embed = new EmbedBuilder()
              .setColor(0x6C2BD9)
              .setTitle('🔍 Message Sender')
              .addFields(
                { name: 'User', value: `${user.tag}`, inline: true },
                { name: 'ID', value: user.id, inline: true },
                { name: 'Content', value: row.content, inline: false },
                { name: 'Sent', value: new Date(row.sent_at).toLocaleString(), inline: true }
              )
              .setTimestamp();
            await interaction.editReply({ embeds: [embed] });
          } catch {
            await interaction.editReply({ content: '❌ User not found.' });
          }
        }
        return;
      }

      if (commandName === 'recover') {
        await interaction.deferReply({ ephemeral: true });
        const session = getSession(interaction.user.id);
        if (!session) {
          await interaction.editReply({ content: '❌ No active session found.' });
          return;
        }
        const data = session.data ? JSON.parse(session.data) : {};
        const embed = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setTitle('🔄 Session Recovered')
          .setDescription(`You were in the middle of: **${session.state}**`)
          .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
          .setFooter({ text: 'Vegas Whispers' })
          .setTimestamp();
        await interaction.editReply({ embeds: [embed] });
        deleteSession(interaction.user.id);
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === 'cancel_whisper') {
      await interaction.deferUpdate();
      await interaction.deleteReply();
      deleteSession(interaction.user.id);
      await showMainMenu(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_recipient') {
      await interaction.deferUpdate();
      const targetId = interaction.values[0];
      try {
        const target = await client.users.fetch(targetId);

        let displayName = target.username;
        if (interaction.guild) {
          const member = await interaction.guild.members.fetch(targetId).catch(() => null);
          if (member) displayName = member.displayName;
        }

        const embed = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setTitle(`🌙 What name will you wear tonight?`)
          .setDescription(`You are about to message **${displayName}**.`)
          .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
          .setFooter({ text: 'Vegas Whispers • Your identity is safe' })
          .setTimestamp();

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`pseudo_${targetId}_shadow`).setLabel('👤 Shadow').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`pseudo_${targetId}_admirer`).setLabel('❤️ Secret Admirer').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`pseudo_${targetId}_friendly`).setLabel('🤝 Friendly Curious').setStyle(ButtonStyle.Success)
          );

        await interaction.editReply({ embeds: [embed], components: [row] });
        saveSession(interaction.user.id, interaction.channel.id, interaction.message.id, 'choosing_pseudo', { targetId, targetDisplayName: displayName });
      } catch {
        await interaction.editReply({ content: '❌ User not found.', embeds: [], components: [] });
        await showMainMenu(interaction);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('pseudo_')) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const targetId = parts[1];
      const pseudoType = parts[2];

      const pseudoMap = { shadow: 'Shadow', admirer: 'Secret Admirer', friendly: 'Friendly Curious' };
      const pseudo = pseudoMap[pseudoType];

      const session = getSession(interaction.user.id);
      if (!session) {
        await interaction.editReply({ content: '❌ Session expired.', embeds: [], components: [] });
        await showMainMenu(interaction);
        return;
      }

      const data = session.data ? JSON.parse(session.data) : {};
      const displayName = data.targetDisplayName || targetId;

      saveSession(interaction.user.id, interaction.channel.id, interaction.message.id, 'pseudo_selected', { targetId, targetDisplayName: displayName, pseudo });

      const target = await client.users.fetch(targetId);

      const embed = new EmbedBuilder()
        .setColor(0x6C2BD9)
        .setImage(BANNER_URL)
        .setTitle(`💌 A secret for ${displayName}...`)
        .setDescription(
          `✍️ Write your message below.\n\n` +
          `**Rules:**\n• Max **3 paragraphs**\n• Max **2000 characters**`
        )
        .addFields(
          { name: '💬 Quote', value: getRandomQuote(), inline: false },
          { name: '🔮 Your identity', value: `You will appear as **${pseudo}**`, inline: false }
        )
        .setFooter({ text: 'Vegas Whispers • Your identity is safe' })
        .setTimestamp();

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`open_modal_${targetId}_${pseudo}`)
            .setLabel('✍️ Write Message')
            .setStyle(ButtonStyle.Primary)
        );

      await interaction.editReply({ embeds: [embed], components: [row] });
      saveSession(interaction.user.id, interaction.channel.id, interaction.message.id, 'writing_message', { targetId, targetDisplayName: displayName, pseudo });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('open_modal_')) {
      const parts = interaction.customId.split('_');
      const targetId = parts[2];
      const pseudo = parts[3];
      const target = await client.users.fetch(targetId);

      const session = getSession(interaction.user.id);
      if (!session) {
        await interaction.reply({ content: '❌ Session expired.', ephemeral: true });
        await showMainMenu(interaction);
        return;
      }

      const data = session.data ? JSON.parse(session.data) : {};
      const displayName = data.targetDisplayName || target.username;

      saveSession(interaction.user.id, interaction.channel.id, interaction.message.id, 'writing_message', { targetId, targetDisplayName: displayName, pseudo });

      const modal = new ModalBuilder()
        .setCustomId(`send_message_${targetId}_${pseudo}`)
        .setTitle(`💌 A secret for ${displayName}...`);

      const input = new TextInputBuilder()
        .setCustomId('message_content')
        .setLabel('Your message (max 3 paragraphs) *')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Type your anonymous message here...')
        .setRequired(true)
        .setMaxLength(2000);

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('send_message_')) {
      await interaction.deferReply({ ephemeral: true });

      const parts = interaction.customId.split('_');
      const targetId = parts[2];
      const pseudo = parts[3];
      const messageContent = interaction.fields.getTextInputValue('message_content');
      const sender = interaction.user;

      const paragraphs = messageContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      const charCount = messageContent.length;

      if (paragraphs.length > 3) {
        await interaction.editReply({ content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3.` });
        await showMainMenu(interaction);
        return;
      }

      const target = await client.users.fetch(targetId);

      const session = getSession(sender.id);
      if (!session) {
        await interaction.editReply({ content: '❌ Session expired.' });
        await showMainMenu(interaction);
        return;
      }

      const data = session.data ? JSON.parse(session.data) : {};
      const displayName = data.targetDisplayName || target.username;

      let conversation;
      try {
        conversation = getOrCreateConversation(sender.id, target.id);
      } catch (err) {
        if (err.message === 'Conversation is blocked') {
          await interaction.editReply({ content: '❌ This conversation is blocked.' });
        } else {
          console.error('❌ getOrCreateConversation error:', err);
          await interaction.editReply({ content: '❌ Error creating conversation.' });
        }
        await showMainMenu(interaction);
        return;
      }

      const senderPseudo = getUserPseudo(conversation, sender.id);
      if (!senderPseudo) {
        try {
          setUserPseudo(conversation.id, sender.id, pseudo);
        } catch (err) {
          console.error('❌ Error saving pseudo:', err);
        }
      }

      let message;
      try {
        message = saveMessage(conversation.id, sender.id, target.id, messageContent);
      } catch (err) {
        console.error('❌ saveMessage error:', err);
        await interaction.editReply({ content: '❌ Error saving message.' });
        await showMainMenu(interaction);
        return;
      }

      await interaction.editReply({ content: `✅ **Sent!** ${charCount} characters • ${paragraphs.length} paragraphs` });

      const lastMsg = getLastMessage(conversation.id);

      try {
        const embedMsg = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setAuthor({ name: `💬 ${pseudo}` })
          .setDescription(messageContent)
          .setFooter({ text: `ID: ${message.id}` })
          .setTimestamp();

        if (lastMsg) {
          const participants = [conversation.user_a_id, conversation.user_b_id];
          const pseudoMap = {};
          for (const uid of participants) {
            const p = getUserPseudo(conversation, uid);
            if (p) pseudoMap[uid] = p;
          }
          const sp = pseudoMap[lastMsg.sender_id] || 'Anonymous';
          const preview = lastMsg.content.length > 100 ? lastMsg.content.slice(0, 100) + '...' : lastMsg.content;
          embedMsg.addFields({ name: '📜 Last message', value: `**${sp}:** ${preview}` });
        }

        const row1 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`reply_${message.id}_${sender.id}`).setLabel('💬 Reply').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`block_${conversation.id}_${sender.id}`).setLabel('🚫 Block Sender').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`history_${conversation.id}`).setLabel('📜 History').setStyle(ButtonStyle.Secondary)
          );

        await target.send({ content: `👋 **You received a whisper:**`, embeds: [embedMsg], components: [row1] });
        console.log(`✅ Message sent from ${sender.username} to ${displayName}`);
      } catch (error) {
        console.error(`❌ Error sending DM:`, error);
      }

      deleteSession(sender.id);
      await showMainMenu(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('history_')) {
      await interaction.deferReply({ ephemeral: true });
      const conversationId = interaction.customId.split('_')[1];

      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
      if (!conversation) {
        return interaction.editReply({ content: '❌ Conversation not found.' });
      }

      const history = getConversationHistory(conversationId, 10);
      if (!history || history.length === 0) {
        return interaction.editReply({ content: '📜 No messages in this conversation yet.' });
      }

      let historyText = '';
      const participants = [conversation.user_a_id, conversation.user_b_id];
      const pseudoMap = {};
      for (const uid of participants) {
        const p = getUserPseudo(conversation, uid);
        if (p) pseudoMap[uid] = p;
      }
      history.forEach(msg => {
        const senderPseudo = pseudoMap[msg.sender_id] || 'Anonymous';
        const date = new Date(msg.sent_at).toLocaleString();
        historyText += `**${senderPseudo}** (${date}): ${msg.content}\n\n`;
      });

      const embed = new EmbedBuilder()
        .setColor(0x6C2BD9)
        .setTitle('📜 Conversation History (last 10)')
        .setDescription(historyText || 'No messages')
        .setFooter({ text: 'Vegas Whispers' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('reply_')) {
      const parts = interaction.customId.split('_');
      const messageId = parts[1];
      const senderId = parts[2];

      const modal = new ModalBuilder()
        .setCustomId(`reply_modal_${messageId}_${senderId}`)
        .setTitle('💬 Reply to Whisper');

      const input = new TextInputBuilder()
        .setCustomId('reply_content')
        .setLabel('Your reply (max 3 paragraphs) *')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Type your anonymous reply...')
        .setRequired(true)
        .setMaxLength(2000);

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('reply_modal_')) {
      await interaction.deferReply({ ephemeral: true });

      const parts = interaction.customId.split('_');
      const messageId = parts[2];
      const senderId = parts[3];
      const replyContent = interaction.fields.getTextInputValue('reply_content');
      const replier = interaction.user;

      const paragraphs = replyContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      if (paragraphs.length > 3) {
        await interaction.editReply({ content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3.` });
        await showMainMenu(interaction);
        return;
      }

      const originalMessage = getMessageById(messageId);
      if (!originalMessage) {
        await interaction.editReply({ content: '❌ Original message not found.' });
        await showMainMenu(interaction);
        return;
      }

      if (originalMessage.receiver_id !== replier.id) {
        await interaction.editReply({ content: '❌ You are not authorized to reply.' });
        await showMainMenu(interaction);
        return;
      }

      let conversation;
      try {
        conversation = getOrCreateConversation(replier.id, senderId);
      } catch (err) {
        console.error('❌ getOrCreateConversation reply error:', err);
        await interaction.editReply({ content: '❌ Error creating conversation.' });
        await showMainMenu(interaction);
        return;
      }

      let savedMessage;
      try {
        savedMessage = saveMessage(conversation.id, replier.id, senderId, replyContent);
      } catch (err) {
        console.error('❌ saveMessage reply error:', err);
        await interaction.editReply({ content: '❌ Error saving reply.' });
        await showMainMenu(interaction);
        return;
      }

      await interaction.editReply({ content: '✅ Reply sent!' });

      const senderPseudo = getUserPseudo(conversation, replier.id);

      try {
        const sender = await client.users.fetch(senderId);

        const lastMsg = getLastMessage(conversation.id);

        const embed = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setAuthor({ name: `💬 Reply from ${senderPseudo || 'Anonymous'}` })
          .setDescription(replyContent)
          .setFooter({ text: `ID: ${savedMessage.id}` })
          .setTimestamp();

        if (lastMsg) {
          const participants = [conversation.user_a_id, conversation.user_b_id];
          const pseudoMap = {};
          for (const uid of participants) {
            const p = getUserPseudo(conversation, uid);
            if (p) pseudoMap[uid] = p;
          }
          const sp = pseudoMap[lastMsg.sender_id] || 'Anonymous';
          const preview = lastMsg.content.length > 100 ? lastMsg.content.slice(0, 100) + '...' : lastMsg.content;
          embed.addFields({ name: '📜 Last message', value: `**${sp}:** ${preview}` });
        }

        const row1 = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder().setCustomId(`reply_${savedMessage.id}_${replier.id}`).setLabel('💬 Reply').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`block_${conversation.id}_${replier.id}`).setLabel('🚫 Block Sender').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`history_${conversation.id}`).setLabel('📜 History').setStyle(ButtonStyle.Secondary)
          );

        await sender.send({ content: `👋 **Someone replied to your whisper:**`, embeds: [embed], components: [row1] });
        console.log(`✅ Reply sent from ${replier.username}`);
      } catch (error) {
        console.error(`❌ Error sending reply:`, error);
      }

      await showMainMenu(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('block_')) {
      await interaction.deferReply({ ephemeral: true });

      const parts = interaction.customId.split('_');
      const conversationId = parts[1];
      const senderId = parts[2];

      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
      if (!conversation) {
        await interaction.editReply({ content: '❌ Conversation not found.' });
        await showMainMenu(interaction);
        return;
      }

      if (conversation.user_a_id !== interaction.user.id && conversation.user_b_id !== interaction.user.id) {
        await interaction.editReply({ content: '❌ You are not part of this conversation.' });
        await showMainMenu(interaction);
        return;
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`confirm_block_${conversationId}_${senderId}`).setLabel('✅ Yes, Block').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_block_${conversationId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
        );

      await interaction.editReply({ content: `⚠️ **Block this sender?** You will no longer receive messages.`, components: [row] });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('confirm_block_')) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const conversationId = parts[2];
      const senderId = parts[3];

      try {
        blockConversation(conversationId, interaction.user.id);
      } catch (err) {
        await interaction.editReply({ content: '❌ Error blocking.', components: [] });
        await showMainMenu(interaction);
        return;
      }

      await interaction.editReply({ content: `✅ **Blocked.**`, components: [] });

      try {
        const sender = await client.users.fetch(senderId);
        await sender.send({ content: `🚫 **You have been blocked.**` });
      } catch { /* ignore */ }

      await showMainMenu(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('cancel_block_')) {
      await interaction.deferUpdate();
      await interaction.editReply({ content: `❌ Cancelled.`, components: [] });
      await showMainMenu(interaction);
      return;
    }

  } catch (error) {
    console.error('❌ Unhandled interaction error:', error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Something went wrong. Please try again.' });
      } else {
        await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true });
      }
    } catch (e) {
      console.error('❌ Could not send error reply:', e);
    }
  }
});

// ===== DÉMARRAGE =====
client.once('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
  await restorePersistentViews();
});

client.login(process.env.TOKEN);