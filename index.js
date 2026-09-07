const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } = require('discord.js');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

dotenv.config();

const db = new sqlite3.Database(path.join(__dirname, 'whispers.db'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_a_id TEXT NOT NULL,
        user_b_id TEXT NOT NULL,
        pseudo_a TEXT,
        pseudo_b TEXT,
        is_blocked BOOLEAN DEFAULT 0,
        blocked_by TEXT,
        images_unlocked_a BOOLEAN DEFAULT 0,
        images_unlocked_b BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        sender_id TEXT NOT NULL,
        receiver_id TEXT NOT NULL,
        content TEXT,
        is_image BOOLEAN DEFAULT 0,
        image_url TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(message_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reaction_counts (
        conversation_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        likes INTEGER DEFAULT 0,
        hearts INTEGER DEFAULT 0,
        fires INTEGER DEFAULT 0,
        dislikes INTEGER DEFAULT 0,
        PRIMARY KEY (conversation_id, user_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS contexts (
        user_id TEXT PRIMARY KEY,
        partner_id TEXT
    )`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel]
});

// ===== BANNER =====
const BANNER_URL = 'https://placehold.co/680x240/6C2BD9/FFFFFF?text=Vegas+Whispers';

// ===== QUOTES =====
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
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Replies Pong!'),
    
    new SlashCommandBuilder()
        .setName('whisper')
        .setDescription('Send an anonymous message'),
    
    new SlashCommandBuilder()
        .setName('admin')
        .setDescription('Admin commands')
        .addSubcommand(sub => 
            sub.setName('find')
                .setDescription('Find sender of a message')
                .addStringOption(option => 
                    option.setName('message_id')
                        .setDescription('The message ID to look up')
                        .setRequired(true)))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

function getOrCreateConversation(userA, userB, callback) {
    db.get(
        `SELECT * FROM conversations WHERE 
        (user_a_id = ? AND user_b_id = ?) OR 
        (user_a_id = ? AND user_b_id = ?)`,
        [userA, userB, userB, userA],
        (err, row) => {
            if (err) return callback(err, null);
            if (row) {
                if (row.is_blocked) {
                    return callback(new Error('Conversation is blocked'), null);
                }
                return callback(null, row);
            }
            
            db.run(
                `INSERT INTO conversations (user_a_id, user_b_id) VALUES (?, ?)`,
                [userA, userB],
                function(err) {
                    if (err) return callback(err, null);
                    db.get(`SELECT * FROM conversations WHERE id = ?`, [this.lastID], (err, row) => {
                        if (err) return callback(err, null);
                        db.run(
                            `INSERT OR IGNORE INTO reaction_counts (conversation_id, user_id) VALUES (?, ?), (?, ?)`,
                            [row.id, userA, row.id, userB]
                        );
                        callback(null, row);
                    });
                }
            );
        }
    );
}

function saveMessage(conversationId, senderId, receiverId, content, isImage = false, imageUrl = null, callback) {
    db.run(
        `INSERT INTO messages (conversation_id, sender_id, receiver_id, content, is_image, image_url) VALUES (?, ?, ?, ?, ?, ?)`,
        [conversationId, senderId, receiverId, content, isImage ? 1 : 0, imageUrl],
        function(err) {
            if (err) return callback(err, null);
            db.get(`SELECT * FROM messages WHERE id = ?`, [this.lastID], callback);
        }
    );
}

function getMessageById(messageId, callback) {
    db.get(`SELECT * FROM messages WHERE id = ?`, [messageId], callback);
}

function getUserPseudo(conversation, userId) {
    if (conversation.user_a_id === userId) return conversation.pseudo_a;
    if (conversation.user_b_id === userId) return conversation.pseudo_b;
    return null;
}

function setUserPseudo(conversationId, userId, pseudo, callback) {
    db.run(
        `UPDATE conversations SET pseudo_a = ? WHERE id = ? AND user_a_id = ?`,
        [pseudo, conversationId, userId],
        function(err) {
            if (err) return callback(err);
            db.run(
                `UPDATE conversations SET pseudo_b = ? WHERE id = ? AND user_b_id = ?`,
                [pseudo, conversationId, userId],
                callback
            );
        }
    );
}

function blockConversation(conversationId, userId, callback) {
    db.run(
        `UPDATE conversations SET is_blocked = 1, blocked_by = ? WHERE id = ?`,
        [userId, conversationId],
        callback
    );
}

function addReaction(messageId, userId, type, callback) {
    db.run(
        `INSERT OR IGNORE INTO reactions (message_id, user_id, type) VALUES (?, ?, ?)`,
        [messageId, userId, type],
        function(err) {
            if (err) return callback(err);
            
            db.get(
                `SELECT conversation_id, sender_id FROM messages WHERE id = ?`,
                [messageId],
                (err, msg) => {
                    if (err || !msg) return callback(err);
                    
                    const field = type === 'like' ? 'likes' : 
                                  type === 'heart' ? 'hearts' : 
                                  type === 'fire' ? 'fires' : 'dislikes';
                    
                    db.run(
                        `UPDATE reaction_counts SET ${field} = ${field} + 1 WHERE conversation_id = ? AND user_id = ?`,
                        [msg.conversation_id, msg.sender_id],
                        function(err) {
                            if (err) return callback(err);
                            
                            db.get(
                                `SELECT likes, hearts, fires, dislikes FROM reaction_counts WHERE conversation_id = ? AND user_id = ?`,
                                [msg.conversation_id, msg.sender_id],
                                (err, counts) => {
                                    if (err) return callback(err);
                                    
                                    if (counts.likes >= 20 || counts.hearts >= 5 || counts.fires >= 3) {
                                        db.run(
                                            `UPDATE conversations SET images_unlocked_a = 1 WHERE id = ? AND user_a_id = ?`,
                                            [msg.conversation_id, msg.sender_id]
                                        );
                                        db.run(
                                            `UPDATE conversations SET images_unlocked_b = 1 WHERE id = ? AND user_b_id = ?`,
                                            [msg.conversation_id, msg.sender_id]
                                        );
                                        
                                        client.users.fetch(msg.sender_id).then(user => {
                                            user.send({
                                                content: `📸 **Image sharing unlocked!** You've earned enough reactions (20 Likes, 5 Hearts, or 3 Fires).`
                                            }).catch(() => {});
                                        }).catch(() => {});
                                    }
                                    
                                    if (counts.dislikes >= 3) {
                                        db.run(
                                            `UPDATE conversations SET is_blocked = 1 WHERE id = ?`,
                                            [msg.conversation_id]
                                        );
                                        
                                        const users = [msg.sender_id, msg.sender_id === msg.conversation.user_a_id ? msg.conversation.user_b_id : msg.conversation.user_a_id];
                                        users.forEach(userId => {
                                            client.users.fetch(userId).then(user => {
                                                user.send({
                                                    content: `🚫 **Conversation blocked** due to 3 dislikes.`
                                                }).catch(() => {});
                                            }).catch(() => {});
                                        });
                                    }
                                    
                                    callback(null);
                                }
                            );
                        }
                    );
                }
            );
        }
    );
}

function getReactionCounts(messageId, callback) {
    db.all(
        `SELECT type, COUNT(*) as count FROM reactions WHERE message_id = ? GROUP BY type`,
        [messageId],
        callback
    );
}

client.once('ready', async () => {
    console.log(`✅ Bot online as ${client.user.tag}`);
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('❌ Error:', error);
    }
});

async function getServerMembers(interaction) {
    if (!interaction.guild) {
        return [];
    }
    
    try {
        await interaction.guild.members.fetch();
        return interaction.guild.members.cache
            .filter(m => !m.user.bot && m.user.id !== interaction.user.id)
            .map(m => ({
                id: m.user.id,
                username: m.user.username,
                displayName: m.displayName
            }));
    } catch (error) {
        console.error('Error fetching members:', error);
        return [];
    }
}

// =============================================
// ===== MAIN INTERACTION HANDLER =====
// =============================================
client.on('interactionCreate', async interaction => {
    // ----- SLASH COMMANDS -----
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'ping') {
            await interaction.reply({ content: '🏓 Pong!', ephemeral: true });
        }

        if (interaction.commandName === 'whisper') {
            const members = await getServerMembers(interaction);
            
            if (members.length === 0) {
                return interaction.reply({ 
                    content: '❌ No members found in this server.', 
                    ephemeral: true 
                });
            }

            // ===== STEP 1: SELECT RECIPIENT WITH BANNER =====
            const embed = new EmbedBuilder()
                .setColor(0x6C2BD9)
                .setImage(BANNER_URL)
                .setTitle('📨 Send a Whisper')
                .setDescription('Select a server member to send an anonymous message to.')
                .addFields(
                    { name: '💬 Quote', value: getRandomQuote(), inline: false }
                )
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

            await interaction.reply({
                embeds: [embed],
                components: [row, cancelRow],
                ephemeral: true
            });
        }

        if (interaction.commandName === 'admin') {
            const subcommand = interaction.options.getSubcommand();
            
            if (!interaction.member.permissions.has('Administrator')) {
                return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
            }

            if (subcommand === 'find') {
                const messageId = interaction.options.getString('message_id');
                
                db.get(
                    `SELECT sender_id, content, is_image, sent_at FROM messages WHERE id = ?`,
                    [messageId],
                    async (err, row) => {
                        if (err || !row) {
                            return interaction.reply({ content: '❌ Message not found.', ephemeral: true });
                        }
                        
                        try {
                            const user = await client.users.fetch(row.sender_id);
                            const embed = new EmbedBuilder()
                                .setColor(0x6C2BD9)
                                .setTitle('🔍 Message Sender')
                                .addFields(
                                    { name: 'User', value: `${user.tag}`, inline: true },
                                    { name: 'ID', value: user.id, inline: true },
                                    { name: 'Content', value: row.content || '[Image]', inline: false },
                                    { name: 'Sent', value: new Date(row.sent_at).toLocaleString(), inline: true }
                                )
                                .setTimestamp();
                            
                            await interaction.reply({ embeds: [embed], ephemeral: true });
                        } catch (error) {
                            interaction.reply({ content: '❌ User not found.', ephemeral: true });
                        }
                    }
                );
            }
        }
    }

    // ----- CANCEL -----
    if (interaction.isButton() && interaction.customId === 'cancel_whisper') {
        await interaction.deleteReply();
    }

    // ----- SELECT RECIPIENT -----
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_recipient') {
        const targetId = interaction.values[0];
        
        try {
            const target = await client.users.fetch(targetId);
            
            // ===== STEP 2: WRITE MESSAGE WITH BANNER =====
            const embed = new EmbedBuilder()
                .setColor(0x6C2BD9)
                .setImage(BANNER_URL)
                .setTitle(`📝 Message to ${target.username}`)
                .setDescription(`⚠️ This form will be sent to Vegas Whispers. Do not share passwords or sensitive information.\n\n✍️ Write your message below.\n\n**Rules:**\n• Max **3 paragraphs**\n• Max **2000 characters**`)
                .addFields(
                    { name: '💬 Quote', value: getRandomQuote(), inline: false }
                )
                .setFooter({ text: 'Vegas Whispers • Your identity is safe' })
                .setTimestamp();

            // We use a button to open a modal for the message
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`open_modal_${targetId}`)
                        .setLabel('✍️ Write Message')
                        .setStyle(ButtonStyle.Primary)
                );

            await interaction.update({
                embeds: [embed],
                components: [row]
            });

        } catch (error) {
            await interaction.reply({ content: '❌ User not found.', ephemeral: true });
        }
    }

    // ----- OPEN MODAL (this is where the text input happens) -----
    if (interaction.isButton() && interaction.customId.startsWith('open_modal_')) {
        const targetId = interaction.customId.split('_')[2];
        const target = await client.users.fetch(targetId);
        
        // This is the modal - Discord doesn't allow banners here
        const modal = new ModalBuilder()
            .setCustomId(`send_message_${targetId}`)
            .setTitle(`📝 Message to ${target.username}`);

        const input = new TextInputBuilder()
            .setCustomId('message_content')
            .setLabel('Your message (max 3 paragraphs) *')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Type your anonymous message here...\n\nUse double Enter for new paragraph.')
            .setRequired(true)
            .setMaxLength(2000);

        const row = new ActionRowBuilder().addComponents(input);
        modal.addComponents(row);

        await interaction.showModal(modal);
    }

    // ----- SEND MESSAGE (after modal submit) -----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('send_message_')) {
        const targetId = interaction.customId.split('_')[2];
        const messageContent = interaction.fields.getTextInputValue('message_content');
        const sender = interaction.user;

        const paragraphs = messageContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        const charCount = messageContent.length;

        if (paragraphs.length > 3) {
            return interaction.reply({ 
                content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3. Please shorten your message.`,
                ephemeral: true 
            });
        }

        const target = await client.users.fetch(targetId);

        getOrCreateConversation(sender.id, target.id, async (err, conversation) => {
            if (err) {
                if (err.message === 'Conversation is blocked') {
                    return interaction.reply({ content: '❌ This conversation is blocked.', ephemeral: true });
                }
                console.error(err);
                return interaction.reply({ content: '❌ Error.', ephemeral: true });
            }

            const senderPseudo = getUserPseudo(conversation, sender.id);
            
            if (!senderPseudo) {
                // ===== STEP 3: PSEUDO SELECTION WITH BANNER =====
                const embed = new EmbedBuilder()
                    .setColor(0x6C2BD9)
                    .setImage(BANNER_URL)
                    .setTitle('🔮 Choose Your Identity')
                    .setDescription('Select a name for this conversation. This will be shown instead of your real name.')
                    .addFields(
                        { name: '💬 Quote', value: getRandomQuote(), inline: false }
                    )
                    .setFooter({ text: 'Vegas Whispers' })
                    .setTimestamp();

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`pseudo_${conversation.id}_shadow`)
                            .setLabel('👤 Shadow')
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(`pseudo_${conversation.id}_admirer`)
                            .setLabel('❤️ Secret Admirer')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`pseudo_${conversation.id}_friendly`)
                            .setLabel('🤝 Friendly Curious')
                            .setStyle(ButtonStyle.Success)
                    );

                await interaction.reply({
                    embeds: [embed],
                    components: [row],
                    ephemeral: true
                });
                return;
            }

            saveMessage(conversation.id, sender.id, target.id, messageContent, false, null, async (err, message) => {
                if (err) {
                    console.error(err);
                    return interaction.reply({ content: '❌ Error saving message.', ephemeral: true });
                }

                const imagesUnlocked = conversation.user_a_id === sender.id ? 
                    conversation.images_unlocked_a : conversation.images_unlocked_b;

                await interaction.reply({ 
                    content: `✅ **Sent!** ${charCount} characters • ${paragraphs.length} paragraphs\n${imagesUnlocked ? '📸 Images unlocked!' : ''}`,
                    ephemeral: true 
                });

                try {
                    const embedMsg = new EmbedBuilder()
                        .setColor(0x6C2BD9)
                        .setImage(BANNER_URL)
                        .setAuthor({ name: `💬 ${senderPseudo}` })
                        .setDescription(messageContent)
                        .setFooter({ text: `ID: ${message.id}` })
                        .setTimestamp();

                    const row1 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`reply_${message.id}_${sender.id}`)
                                .setLabel('💬 Reply')
                                .setStyle(ButtonStyle.Primary),
                            new ButtonBuilder()
                                .setCustomId(`like_${message.id}`)
                                .setLabel('👍')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId(`heart_${message.id}`)
                                .setLabel('❤️')
                                .setStyle(ButtonStyle.Danger),
                            new ButtonBuilder()
                                .setCustomId(`fire_${message.id}`)
                                .setLabel('🔥')
                                .setStyle(ButtonStyle.Secondary),
                            new ButtonBuilder()
                                .setCustomId(`dislike_${message.id}`)
                                .setLabel('👎')
                                .setStyle(ButtonStyle.Secondary)
                        );

                    const row2 = new ActionRowBuilder()
                        .addComponents(
                            new ButtonBuilder()
                                .setCustomId(`block_${conversation.id}_${sender.id}`)
                                .setLabel('🚫 Block Sender')
                                .setStyle(ButtonStyle.Danger)
                        );

                    await target.send({
                        content: `👋 **You received a whisper:**`,
                        embeds: [embedMsg],
                        components: [row1, row2]
                    });

                    console.log(`✅ Message sent from ${sender.username} to ${target.username}`);
                } catch (error) {
                    console.error(`❌ Error sending DM:`, error);
                }
            });
        });
    }

    // ----- PSEUDO SELECTION -----
    if (interaction.isButton() && interaction.customId.startsWith('pseudo_')) {
        const parts = interaction.customId.split('_');
        const conversationId = parts[1];
        const pseudoType = parts[2];
        
        const pseudoMap = {
            'shadow': 'Shadow',
            'admirer': 'Secret Admirer',
            'friendly': 'Friendly Curious'
        };
        const pseudo = pseudoMap[pseudoType];

        setUserPseudo(conversationId, interaction.user.id, pseudo, async (err) => {
            if (err) {
                return interaction.reply({ content: '❌ Error.', ephemeral: true });
            }

            const embed = new EmbedBuilder()
                .setColor(0x57F287)
                .setImage(BANNER_URL)
                .setTitle(`✅ You are now "${pseudo}"`)
                .setDescription(`Use **/whisper** again to send your message with this identity.`)
                .addFields(
                    { name: '💬 Quote', value: getRandomQuote(), inline: false }
                )
                .setFooter({ text: 'Vegas Whispers' })
                .setTimestamp();

            await interaction.update({
                embeds: [embed],
                components: []
            });
        });
    }

    // ----- REACTIONS -----
    if (interaction.isButton() && ['like_', 'heart_', 'fire_', 'dislike_'].some(prefix => interaction.customId.startsWith(prefix))) {
        const parts = interaction.customId.split('_');
        const type = parts[0];
        const messageId = parts[1];
        const userId = interaction.user.id;

        db.get(
            `SELECT * FROM reactions WHERE message_id = ? AND user_id = ?`,
            [messageId, userId],
            async (err, existing) => {
                if (err) return interaction.reply({ content: '❌ Error.', ephemeral: true });
                if (existing) {
                    return interaction.reply({ content: '⚠️ Already reacted!', ephemeral: true });
                }

                addReaction(messageId, userId, type, async (err) => {
                    if (err) return interaction.reply({ content: '❌ Error.', ephemeral: true });

                    getReactionCounts(messageId, async (err, rows) => {
                        let likeCount = 0, dislikeCount = 0, heartCount = 0, fireCount = 0;
                        rows.forEach(row => {
                            if (row.type === 'like') likeCount = row.count;
                            if (row.type === 'dislike') dislikeCount = row.count;
                            if (row.type === 'heart') heartCount = row.count;
                            if (row.type === 'fire') fireCount = row.count;
                        });

                        await interaction.reply({
                            content: `✅ 👍${likeCount} ❤️${heartCount} 🔥${fireCount} 👎${dislikeCount}`,
                            ephemeral: true
                        });
                    });
                });
            }
        );
    }

    // ----- REPLY -----
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
    }

    // ----- REPLY MODAL -----
    if (interaction.isModalSubmit() && interaction.customId.startsWith('reply_modal_')) {
        const parts = interaction.customId.split('_');
        const messageId = parts[2];
        const senderId = parts[3];
        const replyContent = interaction.fields.getTextInputValue('reply_content');
        const replier = interaction.user;

        const paragraphs = replyContent.split(/\n\s*\n/).filter(p => p.trim().length > 0);
        if (paragraphs.length > 3) {
            return interaction.reply({ 
                content: `❌ **${paragraphs.length} paragraphs** detected. Maximum is 3.`,
                ephemeral: true 
            });
        }

        getMessageById(messageId, async (err, originalMessage) => {
            if (err || !originalMessage) {
                return interaction.reply({ content: '❌ Message not found.', ephemeral: true });
            }

            if (originalMessage.receiver_id !== replier.id) {
                return interaction.reply({ content: '❌ Not authorized.', ephemeral: true });
            }

            getOrCreateConversation(replier.id, senderId, async (err, conversation) => {
                if (err) {
                    console.error(err);
                    return interaction.reply({ content: '❌ Error.', ephemeral: true });
                }

                saveMessage(conversation.id, replier.id, senderId, replyContent, false, null, async (err, savedMessage) => {
                    if (err) {
                        console.error(err);
                        return interaction.reply({ content: '❌ Error.', ephemeral: true });
                    }

                    await interaction.reply({ 
                        content: '✅ Reply sent!',
                        ephemeral: true 
                    });

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

                        const row1 = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`reply_${savedMessage.id}_${replier.id}`)
                                    .setLabel('💬 Reply')
                                    .setStyle(ButtonStyle.Primary),
                                new ButtonBuilder()
                                    .setCustomId(`like_${savedMessage.id}`)
                                    .setLabel('👍')
                                    .setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder()
                                    .setCustomId(`heart_${savedMessage.id}`)
                                    .setLabel('❤️')
                                    .setStyle(ButtonStyle.Danger),
                                new ButtonBuilder()
                                    .setCustomId(`fire_${savedMessage.id}`)
                                    .setLabel('🔥')
                                    .setStyle(ButtonStyle.Secondary),
                                new ButtonBuilder()
                                    .setCustomId(`dislike_${savedMessage.id}`)
                                    .setLabel('👎')
                                    .setStyle(ButtonStyle.Secondary)
                            );

                        const row2 = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId(`block_${conversation.id}_${replier.id}`)
                                    .setLabel('🚫 Block Sender')
                                    .setStyle(ButtonStyle.Danger)
                            );

                        await sender.send({
                            content: `👋 **Someone replied to your whisper:**`,
                            embeds: [embed],
                            components: [row1, row2]
                        });

                        console.log(`✅ Reply sent from ${replier.username}`);
                    } catch (error) {
                        console.error(`❌ Error sending reply:`, error);
                    }
                });
            });
        });
    }

    // ----- BLOCK -----
    if (interaction.isButton() && interaction.customId.startsWith('block_')) {
        const parts = interaction.customId.split('_');
        const conversationId = parts[1];
        const senderId = parts[2];

        db.get(
            `SELECT * FROM conversations WHERE id = ?`,
            [conversationId],
            async (err, conversation) => {
                if (err || !conversation) {
                    return interaction.reply({ content: '❌ Not found.', ephemeral: true });
                }

                if (conversation.user_a_id !== interaction.user.id && conversation.user_b_id !== interaction.user.id) {
                    return interaction.reply({ content: '❌ Not part of this conversation.', ephemeral: true });
                }

                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId(`confirm_block_${conversationId}_${senderId}`)
                            .setLabel('✅ Yes, Block')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`cancel_block_${conversationId}`)
                            .setLabel('❌ Cancel')
                            .setStyle(ButtonStyle.Secondary)
                    );

                await interaction.reply({
                    content: `⚠️ **Block this sender?** You will no longer receive messages.`,
                    components: [row],
                    ephemeral: true
                });
            }
        );
    }

    // ----- CONFIRM BLOCK -----
    if (interaction.isButton() && interaction.customId.startsWith('confirm_block_')) {
        const parts = interaction.customId.split('_');
        const conversationId = parts[2];
        const senderId = parts[3];

        blockConversation(conversationId, interaction.user.id, async (err) => {
            if (err) {
                return interaction.reply({ content: '❌ Error blocking.', ephemeral: true });
            }

            await interaction.update({
                content: `✅ **Blocked.**`,
                components: []
            });

            try {
                const sender = await client.users.fetch(senderId);
                await sender.send({
                    content: `🚫 **You have been blocked.**`
                });
            } catch (error) {}
        });
    }

    // ----- CANCEL BLOCK -----
    if (interaction.isButton() && interaction.customId.startsWith('cancel_block_')) {
        await interaction.update({
            content: `❌ Cancelled.`,
            components: []
        });
    }
});

client.login(process.env.TOKEN);