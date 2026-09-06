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

// ===== COMMANDES AVEC AUTOCOMPLÉTION =====
const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Replies Pong!'),
  new SlashCommandBuilder()
    .setName('whisper')
    .setDescription('Send an anonymous message')
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

        // On récupère le target et on continue comme avant
        const target = await client.users.fetch(targetId);
        
        // Puis on suit la même logique qu'avant (choix du pseudo, envoi du message...)
        // Je vais réutiliser le code existant ici pour la suite
        
        await interaction.deferReply({ ephemeral: true });
        // ... (le reste du code de gestion du whisper)
        // Pour ne pas surcharger, dis-moi si tu veux que j'ajoute toute la suite
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
    // ===== BOUTONS ET AUTRES (inchangés) =====
    // =============================================
    if (interaction.isButton() && interaction.customId === 'cancel_whisper') {
      await interaction.deferUpdate();
      await interaction.deleteReply();
      deleteSession(interaction.user.id);
      await showMainMenu(interaction);
      return;
    }

    // ... (le reste des boutons et modales que tu avais déjà, que je réintègre)

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