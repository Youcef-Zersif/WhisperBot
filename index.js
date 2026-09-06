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

// ===== KEEP-ALIVE =====
const http = require('http');
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
});
server.listen(PORT, () => console.log(`✅ Keep-alive server running on port ${PORT}`));
setInterval(() => {
  fetch(`http://localhost:${PORT}/`).then(() => console.log('🔄 Keep-alive ping')).catch(() => {});
}, 180000);

// ===== DATABASE =====
const db = new Database(path.join(__dirname, 'whispers.db'));

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
function getRandomQuote() { return QUOTES[Math.floor(Math.random() * QUOTES.length)]; }

// ===== COMMANDES =====
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies Pong!'),
  new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Send an anonymous message to a server member')
    .addStringOption(option =>
      option.setName('target')
        .setDescription('Search for a member by username or nickname')
        .setAutocomplete(true)
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Your message (max 3 paragraphs)')
        .setRequired(true)
        .setMaxLength(2000)
    ),
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
  const info = db.prepare(`INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`).run(userA, userB);
  return db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(info.lastInsertRowid);
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
  db.prepare(`UPDATE conversations SET pseudo_a = ? WHERE id = ? AND user_a_id = ?`).run(pseudo, conversationId, userId);
  db.prepare(`UPDATE conversations SET pseudo_b = ? WHERE id = ? AND user_b_id = ?`).run(pseudo, conversationId, userId);
}

function blockConversation(conversationId, userId) {
  db.prepare(`UPDATE conversations SET is_blocked = 1, blocked_by = ? WHERE id = ?`).run(userId, conversationId);
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
    memberCache.set(guildId, { members, lastUpdated: now });
    return members;
  } catch (error) {
    console.error('❌ Error fetching members:', error.message);
    if (cacheEntry) return cacheEntry.members;
    return [];
  }
}

// =============================================
// ===== INTERACTION HANDLER =====
// =============================================
client.on('interactionCreate', async interaction => {
  try {
    // =============================================
    // ===== AUTOCOMPLETE =====
    // =============================================
    if (interaction.isAutocomplete()) {
      const focusedValue = interaction.options.getFocused();
      const members = await getCachedMembers(interaction);

      const filtered = members
        .filter(m =>
          m.displayName.toLowerCase().includes(focusedValue.toLowerCase()) ||
          m.username.toLowerCase().includes(focusedValue.toLowerCase())
        )
        .slice(0, 25)
        .map(m => ({
          name: m.displayName || m.username,
          value: m.id
        }));

      await interaction.respond(filtered);
      return;
    }

    // =============================================
    // ===== SLASH COMMANDS =====
    // =============================================
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'ping') {
        await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
        return;
      }

      if (commandName === 'whisper') {
        const targetId = interaction.options.getString('target');
        const messageContent = interaction.options.getString('message');
        const sender = interaction.user;

        await interaction.deferReply({ ephemeral: true });

        // Vérifier si le destinataire existe
        let target;
        try {
          target = await client.users.fetch(targetId);
        } catch (err) {
          await interaction.editReply({ content: '❌ User not found. Please try again.' });
          return;
        }

        if (target.id === sender.id) {
          await interaction.editReply({ content: '❌ You cannot send a whisper to yourself.' });
          return;
        }

        if (target.bot) {
          await interaction.editReply({ content: '❌ You cannot send a whisper to a bot.' });
          return;
        }

        let displayName = target.username;
        if (interaction.guild) {
          const member = await interaction.guild.members.fetch(targetId).catch(() => null);
          if (member) displayName = member.displayName;
        }

        // Vérifier la limite de paragraphes
        const paragraphs = messageContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        if (paragraphs.length > 3) {
          await interaction.editReply({
            content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3. Please shorten your message.`
          });
          return;
        }

        // Créer ou récupérer la conversation
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
          return;
        }

        const senderPseudo = getUserPseudo(conversation, sender.id);

        // Si l'utilisateur n'a pas encore de pseudo, lui proposer
        if (!senderPseudo) {
          const embed = new EmbedBuilder()
            .setColor(0x6C2BD9)
            .setImage(BANNER_URL)
            .setTitle(`🌙 Choose Your Identity`)
            .setDescription(`You are about to message **${displayName}**.\n\nSelect a name for this conversation.`)
            .addFields({ name: '💬 Quote', value: getRandomQuote(), inline: false })
            .setFooter({ text: 'Vegas Whispers • Your identity is safe' })
            .setTimestamp();

          const row = new ActionRowBuilder()
            .addComponents(
              new ButtonBuilder().setCustomId(`pseudo_${targetId}_shadow`).setLabel('👤 Shadow').setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(`pseudo_${targetId}_admirer`).setLabel('❤️ Secret Admirer').setStyle(ButtonStyle.Danger),
              new ButtonBuilder().setCustomId(`pseudo_${targetId}_friendly`).setLabel('🤝 Friendly Curious').setStyle(ButtonStyle.Success)
            );

          // Sauvegarder le message en session en attendant le choix du pseudo
          saveSession(sender.id, interaction.channel.id, interaction.message?.id, 'choosing_pseudo', { 
            targetId, 
            targetDisplayName: displayName, 
            messageContent 
          });

          await interaction.editReply({ embeds: [embed], components: [row] });
          return;
        }

        // Envoyer le message
        let message;
        try {
          message = saveMessage(conversation.id, sender.id, target.id, messageContent);
        } catch (err) {
          console.error('❌ saveMessage error:', err);
          await interaction.editReply({ content: '❌ Error saving message. Please try again.' });
          return;
        }

        await interaction.editReply({
          content: `✅ **Sent!** ${messageContent.length} characters • ${paragraphs.length} paragraphs`
        });

        // Envoyer au destinataire
        try {
          const embedMsg = new EmbedBuilder()
            .setColor(0x6C2BD9)
            .setImage(BANNER_URL)
            .setAuthor({ name: `💬 ${senderPseudo}` })
            .setDescription(messageContent)
            .setFooter({ text: `ID: ${message.id}` })
            .setTimestamp();

          const lastMsg = getLastMessage(conversation.id);
          if (lastMsg && lastMsg.id !== message.id) {
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
        } catch (err) {
          console.error(`❌ Error sending DM:`, err);
        }

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

    // =============================================
    // ===== PSEUDO SELECTION =====
    // =============================================
    if (interaction.isButton() && interaction.customId.startsWith('pseudo_')) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const targetId = parts[1];
      const pseudoType = parts[2];
      const pseudoMap = { shadow: 'Shadow', admirer: 'Secret Admirer', friendly: 'Friendly Curious' };
      const pseudo = pseudoMap[pseudoType];

      const session = getSession(interaction.user.id);
      if (!session) {
        await interaction.editReply({ content: '❌ Session expired. Please use /whisper again.', embeds: [], components: [] });
        return;
      }

      const data = session.data ? JSON.parse(session.data) : {};
      const targetDisplayName = data.targetDisplayName || targetId;
      const messageContent = data.messageContent;

      if (!messageContent) {
        await interaction.editReply({ content: '❌ No message found. Please use /whisper again.', embeds: [], components: [] });
        return;
      }

      try {
        const conversation = getOrCreateConversation(interaction.user.id, targetId);
        setUserPseudo(conversation.id, interaction.user.id, pseudo);

        const target = await client.users.fetch(targetId);

        // Envoyer le message
        let message;
        try {
          message = saveMessage(conversation.id, interaction.user.id, target.id, messageContent);
        } catch (err) {
          console.error('❌ saveMessage error:', err);
          await interaction.editReply({ content: '❌ Error saving message.' });
          return;
        }

        await interaction.editReply({
          content: `✅ **Sent!** (as ${pseudo})`
        });

        // Envoyer au destinataire
        const embedMsg = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setAuthor({ name: `💬 ${pseudo}` })
          .setDescription(messageContent)
          .setFooter({ text: `ID: ${message.id}` })
          .setTimestamp();

        const lastMsg = getLastMessage(conversation.id);
        if (lastMsg && lastMsg.id !== message.id) {
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
            new ButtonBuilder().setCustomId(`reply_${message.id}_${interaction.user.id}`).setLabel('💬 Reply').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`block_${conversation.id}_${interaction.user.id}`).setLabel('🚫 Block Sender').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`history_${conversation.id}`).setLabel('📜 History').setStyle(ButtonStyle.Secondary)
          );

        await target.send({ content: `👋 **You received a whisper:**`, embeds: [embedMsg], components: [row1] });
        console.log(`✅ Message sent from ${interaction.user.username} to ${targetDisplayName}`);

        deleteSession(interaction.user.id);
      } catch (err) {
        console.error('❌ Error in pseudo flow:', err);
        await interaction.editReply({ content: '❌ An error occurred. Please try again.' });
      }
      return;
    }

    // =============================================
    // ===== REPLY BUTTON =====
    // =============================================
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

    // =============================================
    // ===== REPLY MODAL =====
    // =============================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('reply_modal_')) {
      await interaction.deferReply({ ephemeral: true });

      const parts = interaction.customId.split('_');
      const messageId = parts[2];
      const senderId = parts[3];
      const replyContent = interaction.fields.getTextInputValue('reply_content');
      const replier = interaction.user;

      const paragraphs = replyContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
      if (paragraphs.length > 3) {
        await interaction.editReply({
          content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3.`
        });
        return;
      }

      const originalMessage = getMessageById(messageId);
      if (!originalMessage) {
        await interaction.editReply({ content: '❌ Original message not found.' });
        return;
      }

      if (originalMessage.receiver_id !== replier.id) {
        await interaction.editReply({ content: '❌ You are not authorized to reply.' });
        return;
      }

      let conversation;
      try {
        conversation = getOrCreateConversation(replier.id, senderId);
      } catch (err) {
        console.error('❌ getOrCreateConversation reply error:', err);
        await interaction.editReply({ content: '❌ Error creating conversation.' });
        return;
      }

      let savedMessage;
      try {
        savedMessage = saveMessage(conversation.id, replier.id, senderId, replyContent);
      } catch (err) {
        console.error('❌ saveMessage reply error:', err);
        await interaction.editReply({ content: '❌ Error saving reply.' });
        return;
      }

      await interaction.editReply({ content: '✅ Reply sent!' });

      const senderPseudo = getUserPseudo(conversation, replier.id);

      try {
        const sender = await client.users.fetch(senderId);

        const embed = new EmbedBuilder()
          .setColor(0x6C2BD9)
          .setImage(BANNER_URL)
          .setAuthor({ name: `💬 Reply from ${senderPseudo || 'Anonymous'}` })
          .setDescription(replyContent)
          .setFooter({ text: `ID: ${savedMessage.id}` })
          .setTimestamp();

        const lastMsg = getLastMessage(conversation.id);
        if (lastMsg && lastMsg.id !== savedMessage.id) {
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

        await sender.send({
          content: `👋 **Someone replied to your whisper:**`,
          embeds: [embed],
          components: [row1]
        });
        console.log(`✅ Reply sent from ${replier.username}`);
      } catch (err) {
        console.error(`❌ Error sending reply:`, err);
      }
      return;
    }

    // =============================================
    // ===== HISTORY BUTTON =====
    // =============================================
    if (interaction.isButton() && interaction.customId.startsWith('history_')) {
      await interaction.deferReply({ ephemeral: true });
      const conversationId = interaction.customId.split('_')[1];

      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
      if (!conversation) {
        await interaction.editReply({ content: '❌ Conversation not found.' });
        return;
      }

      const history = getConversationHistory(conversationId, 10);
      if (!history || history.length === 0) {
        await interaction.editReply({ content: '📜 No messages in this conversation yet.' });
        return;
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

    // =============================================
    // ===== BLOCK BUTTON =====
    // =============================================
    if (interaction.isButton() && interaction.customId.startsWith('block_')) {
      await interaction.deferReply({ ephemeral: true });

      const parts = interaction.customId.split('_');
      const conversationId = parts[1];
      const senderId = parts[2];

      const conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
      if (!conversation) {
        await interaction.editReply({ content: '❌ Conversation not found.' });
        return;
      }

      if (conversation.user_a_id !== interaction.user.id && conversation.user_b_id !== interaction.user.id) {
        await interaction.editReply({ content: '❌ You are not part of this conversation.' });
        return;
      }

      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder().setCustomId(`confirm_block_${conversationId}_${senderId}`).setLabel('✅ Yes, Block').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`cancel_block_${conversationId}`).setLabel('❌ Cancel').setStyle(ButtonStyle.Secondary)
        );

      await interaction.editReply({
        content: `⚠️ **Block this sender?** You will no longer receive messages.`,
        components: [row]
      });
      return;
    }

    // =============================================
    // ===== CONFIRM BLOCK =====
    // =============================================
    if (interaction.isButton() && interaction.customId.startsWith('confirm_block_')) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const conversationId = parts[2];
      const senderId = parts[3];

      try {
        blockConversation(conversationId, interaction.user.id);
      } catch (err) {
        await interaction.editReply({ content: '❌ Error blocking.', components: [] });
        return;
      }

      await interaction.editReply({
        content: `✅ **Blocked.**`,
        components: []
      });

      try {
        const sender = await client.users.fetch(senderId);
        await sender.send({ content: `🚫 **You have been blocked.**` });
      } catch { /* ignore */ }
      return;
    }

    // =============================================
    // ===== CANCEL BLOCK =====
    // =============================================
    if (interaction.isButton() && interaction.customId.startsWith('cancel_block_')) {
      await interaction.deferUpdate();
      await interaction.editReply({
        content: `❌ Cancelled.`,
        components: []
      });
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

// =============================================
// ===== DÉMARRAGE =====
// =============================================
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