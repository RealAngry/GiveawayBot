const { Client, IntentsBitField, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, PermissionsBitField, Collection, REST, Routes } = require('discord.js');
const fs = require('fs');
const config = require('./config.json');

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.MessageContent
    ]
});

const giveaways = new Map();
const giveawayFile = './giveaways.json';
const blacklist = new Set();
const blacklistFile = './blacklist.json';
const giveawayTimeouts = new Collection();

const rest = new REST({ version: '10' }).setToken(config.token);

// Load saved data
function loadData() {
    if (fs.existsSync(giveawayFile)) {
        const data = fs.readFileSync(giveawayFile);
        const loadedGiveaways = JSON.parse(data);
        for (const [id, giveaway] of Object.entries(loadedGiveaways)) {
            giveaways.set(id, giveaway);
        }
    }
    if (fs.existsSync(blacklistFile)) {
        const data = fs.readFileSync(blacklistFile);
        blacklist.clear();
        JSON.parse(data).forEach(id => blacklist.add(id));
    }
}

function saveData() {
    fs.writeFileSync(giveawayFile, JSON.stringify(Object.fromEntries(giveaways)));
    fs.writeFileSync(blacklistFile, JSON.stringify([...blacklist]));
}

// Utility function to create standardized embeds
function createEmbed(title, description, color = '#00ff00', fields = []) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields(fields)
        .setTimestamp();
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    loadData();
    loadGiveaways();
    await registerSlashCommands();
});

async function registerSlashCommands(force = false) {
    const commands = [
        { name: 'giveaway', description: 'Create a giveaway', options: [
            { name: 'duration', description: 'Duration in minutes', type: 4, required: true },
            { name: 'winners', description: 'Number of winners', type: 4, required: true },
            { name: 'prize', description: 'Prize to win', type: 3, required: true },
            { name: 'role', description: 'Required role', type: 8, required: false },
            { name: 'channel', description: 'Channel to post', type: 7, required: false }
        ]},
        { name: 'giveaway_end', description: 'End a giveaway', options: [{ name: 'message_id', description: 'Giveaway message ID', type: 3, required: true }]},
        { name: 'giveaway_reroll', description: 'Reroll a giveaway', options: [{ name: 'message_id', description: 'Giveaway message ID', type: 3, required: true }]},
        { name: 'giveaway_list', description: 'List active giveaways' },
        { name: 'giveaway_cancel', description: 'Cancel a giveaway', options: [{ name: 'message_id', description: 'Giveaway message ID', type: 3, required: true }]},
        { name: 'drop', description: 'Create a drop giveaway', options: [
            { name: 'prize', description: 'Prize to win', type: 3, required: true },
            { name: 'channel', description: 'Channel to post', type: 7, required: false },
            { name: 'delay', description: 'Delay in seconds', type: 4, required: false }
        ]},
        { name: 'giveaway_blacklist_add', description: 'Blacklist a user', options: [{ name: 'user', description: 'User to blacklist', type: 6, required: true }]},
        { name: 'giveaway_blacklist_remove', description: 'Remove user from blacklist', options: [{ name: 'user', description: 'User to remove', type: 6, required: true }]},
        { name: 'help', description: 'Show help menu' },
        { name: 'reload_commands', description: 'Force reload slash commands (Admin only)' }
    ];

    try {
        if (force) {
            console.log('Forcing slash command reload...');
            await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
            console.log('Slash commands reloaded successfully!');
        } else {
            const existingCommands = await rest.get(Routes.applicationCommands(client.user.id));
            if (JSON.stringify(existingCommands) !== JSON.stringify(commands)) {
                await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
                console.log('Slash commands updated!');
            }
        }
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
}

function createGiveawayEmbed(giveaway, isDrop = false) {
    return createEmbed(
        isDrop ? '🎁 Drop Giveaway!' : '🎉 New Giveaway!',
        isDrop ? `
            **Prize:** ${giveaway.prize}
            **Hosted by:** <@${giveaway.host}>
            ${giveaway.delay ? `**Available in:** <t:${Math.floor((Date.now() + giveaway.delay) / 1000)}:R>` : 'Click 🎁 to claim!'}
        ` : `
            **Prize:** ${giveaway.prize}
            **Winners:** ${giveaway.winners}
            **Ends:** <t:${Math.floor(giveaway.endTime / 1000)}:R>
            **Hosted by:** <@${giveaway.host}>
            **Entries:** ${giveaway.entries.length}
            ${giveaway.requiredRole ? `**Required Role:** <@&${giveaway.requiredRole}>` : ''}

            Click 🎉 to enter!
        `,
        isDrop ? '#FFD700' : '#00ff00',
        [{ name: 'Giveaway ID', value: giveaway.messageId, inline: true }]
    );
}

function createButtons(isDrop = false, disabled = false) {
    const row = new ActionRowBuilder();
    if (isDrop) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('claim_drop')
                .setLabel('Claim Prize')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎁')
                .setDisabled(disabled)
        );
    } else {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId('enter_giveaway')
                .setLabel('Enter Giveaway')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🎉')
                .setDisabled(disabled)
        );
    }
    return row;
}

async function endGiveaway(messageId, manual = false) {
    const giveaway = giveaways.get(messageId);
    if (!giveaway || giveaway.isDrop || giveaway.ended) return; // Skip if already ended

    const channel = client.channels.cache.get(giveaway.channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;

    const winners = selectWinners(giveaway.entries, giveaway.winners);
    giveaway.lastWinners = winners;

    const endEmbed = createEmbed(
        '🎉 Giveaway Ended!',
        `
            **Prize:** ${giveaway.prize}
            **Winners:** ${winners.map(w => `<@${w}>`).join(', ') || 'No winners'}
            **Hosted by:** <@${giveaway.host}>
            **Total Entries:** ${giveaway.entries.length}
        `,
        '#ff0000',
        [{ name: 'Giveaway ID', value: messageId, inline: true }]
    );

    await message.edit({ embeds: [endEmbed], components: [createButtons(false, true)] });

    // Always announce winners, whether manual or automatic
    if (winners.length > 0) {
        await channel.send({ embeds: [createEmbed(
            '🎉 Giveaway Winners!',
            `Congratulations ${winners.map(w => `<@${w}>`).join(', ')}! You won **${giveaway.prize}**!`,
            '#00ff00'
        )] });
    }

    giveaway.ended = true;
    if (giveawayTimeouts.has(messageId)) clearTimeout(giveawayTimeouts.get(messageId)); // Clear timeout if it exists
    giveawayTimeouts.delete(messageId);
    saveData();
}

function selectWinners(entries, count) {
    const shuffled = [...entries].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, entries.length));
}

function scheduleGiveawayEnd(messageId, giveaway) {
    if (giveaway.isDrop || giveaway.ended) return; // Skip if already ended
    const timeLeft = giveaway.endTime - Date.now();
    if (timeLeft > 0) {
        const timeout = setTimeout(() => endGiveaway(messageId), timeLeft);
        giveawayTimeouts.set(messageId, timeout);
    } else {
        endGiveaway(messageId);
    }
}

function loadGiveaways() {
    for (const [messageId, giveaway] of giveaways) {
        if (!giveaway.isDrop && !giveaway.ended && giveaway.endTime > Date.now()) {
            scheduleGiveawayEnd(messageId, giveaway);
        }
    }
}

async function checkAdmin(interactionOrMessage) {
    const member = interactionOrMessage.member || interactionOrMessage.author;
    const channel = interactionOrMessage.channel;
    const hasAdmin = channel.type === 'DM' ? false : member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!hasAdmin) {
        const embed = createEmbed('❌ Permission Denied', 'You need Administrator permission to use this command!', '#ff0000');
        if (interactionOrMessage.isCommand?.()) {
            await interactionOrMessage.reply({ embeds: [embed], ephemeral: true });
        } else {
            await interactionOrMessage.reply({ embeds: [embed] });
        }
    }
    return hasAdmin;
}

// Advanced Help Command
async function sendHelp(interactionOrMessage) {
    const prefix = config.prefix;
    const embed = createEmbed(
        '🎉 Giveaway Bot Help',
        `Prefix: \`${prefix}\` | Slash commands also available!`,
        '#00ff00',
        [
            { name: `${prefix}giveaway | /giveaway`, value: 'Create a giveaway\n`duration winners prize [role] [channel]`', inline: true },
            { name: `${prefix}drop | /drop`, value: 'Create a drop giveaway\n`prize [channel] [delay]`', inline: true },
            { name: `${prefix}giveaway_end | /giveaway_end`, value: 'End a giveaway\n`message_id`', inline: true },
            { name: `${prefix}giveaway_reroll | /giveaway_reroll`, value: 'Reroll a giveaway\n`message_id`', inline: true },
            { name: `${prefix}giveaway_list | /giveaway_list`, value: 'List active giveaways', inline: true },
            { name: `${prefix}giveaway_cancel | /giveaway_cancel`, value: 'Cancel a giveaway\n`message_id`', inline: true },
            { name: `${prefix}giveaway_blacklist_add | /giveaway_blacklist_add`, value: 'Blacklist a user\n`user`', inline: true },
            { name: `${prefix}giveaway_blacklist_remove | /giveaway_blacklist_remove`, value: 'Remove user from blacklist\n`user`', inline: true },
            { name: `${prefix}help | /help`, value: 'Show this help menu', inline: true },
            { name: `/reload_commands`, value: 'Force reload slash commands (Admin only)', inline: true }
        ]
    ).setFooter({ text: 'All commands require Administrator permission' });

    if (interactionOrMessage.isCommand?.()) {
        await interactionOrMessage.editReply({ embeds: [embed] });
    } else {
        await interactionOrMessage.reply({ embeds: [embed] });
    }
}

// Prefix Command Handler
client.on('messageCreate', async message => {
    if (!message.content.startsWith(config.prefix) || message.author.bot) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (!(await checkAdmin(message))) return;

    switch (command) {
        case 'giveaway': {
            const duration = parseInt(args[0]);
            const winners = parseInt(args[1]);
            const roleIndex = args.indexOf('-role');
            const channelIndex = args.indexOf('-channel');
            const roleId = roleIndex !== -1 ? args[roleIndex + 1]?.replace(/[<@&>]/g, '') : null;
            const channelId = channelIndex !== -1 ? args[channelIndex + 1]?.replace(/[<#>]/g, '') : null;
            const prizeArgs = (roleIndex !== -1 || channelIndex !== -1) ? args.slice(2, Math.min(roleIndex, channelIndex) === -1 ? undefined : Math.min(roleIndex, channelIndex)) : args.slice(2);
            const prize = prizeArgs.join(' ');
            if (isNaN(duration) || isNaN(winners) || !prize) {
                return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway <duration> <winners> <prize> [-role @role] [-channel #channel]`, '#ff0000')] });
            }
            await createGiveaway(channelId ? message.guild.channels.cache.get(channelId) : message.channel, duration, winners, prize, message.author.id, roleId);
            await message.reply({ embeds: [createEmbed('✅ Success', 'Giveaway created!', '#00ff00')] });
            break;
        }
        case 'drop': {
            const channelIndex = args.indexOf('-channel');
            const delayIndex = args.indexOf('-delay');
            const channelId = channelIndex !== -1 ? args[channelIndex + 1]?.replace(/[<#>]/g, '') : null;
            const delay = delayIndex !== -1 ? parseInt(args[delayIndex + 1]) * 1000 : 0;
            const prizeArgs = (channelIndex !== -1 || delayIndex !== -1) ? args.slice(0, Math.min(channelIndex, delayIndex) === -1 ? undefined : Math.min(channelIndex, delayIndex)) : args;
            const prize = prizeArgs.join(' ');
            if (!prize) {
                return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}drop <prize> [-channel #channel] [-delay seconds]`, '#ff0000')] });
            }
            await createDrop(channelId ? message.guild.channels.cache.get(channelId) : message.channel, prize, message.author.id, delay);
            await message.reply({ embeds: [createEmbed('✅ Success', 'Drop created!', '#00ff00')] });
            break;
        }
        case 'giveaway_end':
            if (!args[0]) return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway_end <message_id>`, '#ff0000')] });
            const giveaway = giveaways.get(args[0]);
            if (giveaway && giveaway.ended) {
                return message.reply({ embeds: [createEmbed('❌ Error', 'This giveaway has already ended!', '#ff0000')] });
            }
            await endGiveaway(args[0], true);
            await message.reply({ embeds: [createEmbed('✅ Success', 'Giveaway ended!', '#00ff00')] });
            break;
        case 'giveaway_reroll':
            if (!args[0]) return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway_reroll <message_id>`, '#ff0000')] });
            await rerollGiveaway(message, args[0]);
            break;
        case 'giveaway_list':
            await listGiveaways(message);
            break;
        case 'giveaway_cancel':
            if (!args[0]) return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway_cancel <message_id>`, '#ff0000')] });
            await cancelGiveaway(message, args[0]);
            break;
        case 'giveaway_blacklist_add':
            if (!args[0]) return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway_blacklist_add <user>`, '#ff0000')] });
            const userAdd = message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
            if (!userAdd) return message.reply({ embeds: [createEmbed('❌ Error', 'Invalid user!', '#ff0000')] });
            blacklist.add(userAdd.id);
            saveData();
            await message.reply({ embeds: [createEmbed('✅ Success', `Blacklisted <@${userAdd.id}>`, '#00ff00')] });
            break;
        case 'giveaway_blacklist_remove':
            if (!args[0]) return message.reply({ embeds: [createEmbed('❌ Error', `Usage: ${config.prefix}giveaway_blacklist_remove <user>`, '#ff0000')] });
            const userRemove = message.mentions.users.first() || await client.users.fetch(args[0]).catch(() => null);
            if (!userRemove) return message.reply({ embeds: [createEmbed('❌ Error', 'Invalid user!', '#ff0000')] });
            blacklist.delete(userRemove.id);
            saveData();
            await message.reply({ embeds: [createEmbed('✅ Success', `Removed <@${userRemove.id}> from blacklist`, '#00ff00')] });
            break;
        case 'help':
            await sendHelp(message);
            break;
    }
});

// Slash Command Handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand() && !interaction.isButton()) return;

    if (interaction.isCommand()) {
        if (!(await checkAdmin(interaction))) return;
        await interaction.deferReply();

        switch (interaction.commandName) {
            case 'giveaway':
                await createGiveaway(
                    interaction.options.getChannel('channel') || interaction.channel,
                    interaction.options.getInteger('duration'),
                    interaction.options.getInteger('winners'),
                    interaction.options.getString('prize'),
                    interaction.user.id,
                    interaction.options.getRole('role')?.id
                );
                await interaction.editReply({ embeds: [createEmbed('✅ Success', 'Giveaway created!', '#00ff00')] });
                break;
            case 'drop':
                await createDrop(
                    interaction.options.getChannel('channel') || interaction.channel,
                    interaction.options.getString('prize'),
                    interaction.user.id,
                    interaction.options.getInteger('delay') * 1000 || 0
                );
                await interaction.editReply({ embeds: [createEmbed('✅ Success', 'Drop created!', '#00ff00')] });
                break;
            case 'giveaway_end':
                const messageId = interaction.options.getString('message_id');
                const giveaway = giveaways.get(messageId);
                if (giveaway && giveaway.ended) {
                    await interaction.editReply({ embeds: [createEmbed('❌ Error', 'This giveaway has already ended!', '#ff0000')] });
                } else {
                    await endGiveaway(messageId, true);
                    await interaction.editReply({ embeds: [createEmbed('✅ Success', 'Giveaway ended!', '#00ff00')] });
                }
                break;
            case 'giveaway_reroll':
                await rerollGiveaway(interaction, interaction.options.getString('message_id'));
                break;
            case 'giveaway_list':
                await listGiveaways(interaction);
                break;
            case 'giveaway_cancel':
                await cancelGiveaway(interaction, interaction.options.getString('message_id'));
                break;
            case 'giveaway_blacklist_add':
                blacklist.add(interaction.options.getUser('user').id);
                saveData();
                await interaction.editReply({ embeds: [createEmbed('✅ Success', `Blacklisted <@${interaction.options.getUser('user').id}>`, '#00ff00')] });
                break;
            case 'giveaway_blacklist_remove':
                blacklist.delete(interaction.options.getUser('user').id);
                saveData();
                await interaction.editReply({ embeds: [createEmbed('✅ Success', `Removed <@${interaction.options.getUser('user').id}> from blacklist`, '#00ff00')] });
                break;
            case 'help':
                await sendHelp(interaction);
                break;
            case 'reload_commands':
                await registerSlashCommands(true);
                await interaction.editReply({ embeds: [createEmbed('✅ Success', 'Slash commands reloaded!', '#00ff00')] });
                break;
        }
    }

    if (interaction.isButton()) {
        const giveaway = giveaways.get(interaction.message.id);
        if (!giveaway) return;

        if (blacklist.has(interaction.user.id)) {
            return interaction.reply({ embeds: [createEmbed('❌ Error', 'You are blacklisted from giveaways!', '#ff0000')], ephemeral: true });
        }

        if (giveaway.requiredRole && !interaction.member.roles.cache.has(giveaway.requiredRole)) {
            return interaction.reply({ embeds: [createEmbed('❌ Error', 'You don\'t have the required role!', '#ff0000')], ephemeral: true });
        }

        if (interaction.customId === 'enter_giveaway' && !giveaway.isDrop && !giveaway.ended) {
            if (giveaway.entries.includes(interaction.user.id)) {
                giveaway.entries = giveaway.entries.filter(id => id !== interaction.user.id);
                await interaction.reply({ embeds: [createEmbed('✅ Success', 'You have left the giveaway!', '#00ff00')], ephemeral: true });
            } else {
                giveaway.entries.push(interaction.user.id);
                const updatedEmbed = createGiveawayEmbed(giveaway);
                await interaction.message.edit({ embeds: [updatedEmbed] });
                await interaction.reply({ embeds: [createEmbed('✅ Success', 'You have entered the giveaway!', '#00ff00')], ephemeral: true });
            }
            saveData();
        }

        if (interaction.customId === 'claim_drop' && giveaway.isDrop && !giveaway.claimed) {
            if (Date.now() < giveaway.enableTime) {
                return interaction.reply({ embeds: [createEmbed('❌ Error', 'Drop isn\'t available yet!', '#ff0000')], ephemeral: true });
            }
            giveaway.claimed = true;
            const embed = createEmbed(
                '🎁 Drop Claimed!',
                `**Prize:** ${giveaway.prize}\n**Winner:** <@${interaction.user.id}>`,
                '#ff0000'
            );
            await interaction.message.edit({ embeds: [embed], components: [] });
            await interaction.channel.send({ embeds: [createEmbed(
                '🎁 Drop Winner!',
                `Congratulations <@${interaction.user.id}>! You won **${giveaway.prize}**!`,
                '#00ff00'
            )] });
            giveaways.delete(interaction.message.id);
            saveData();
        }
    }
});

async function createGiveaway(channel, duration, winners, prize, host, requiredRole) {
    const endTime = Date.now() + (duration * 60 * 1000);
    const embed = createGiveawayEmbed({ prize, winners, endTime, host, requiredRole, entries: [], messageId: 'temp' });
    const buttons = createButtons();

    const message = await channel.send({ embeds: [embed], components: [buttons] });
    const giveawayData = { 
        channelId: channel.id, 
        prize, 
        winners, 
        endTime, 
        host, 
        entries: [], 
        requiredRole,
        messageId: message.id,
        ended: false,
        lastWinners: []
    };
    giveaways.set(message.id, giveawayData);
    embed.data.fields[0].value = message.id;
    await message.edit({ embeds: [embed] });
    saveData();
    scheduleGiveawayEnd(message.id, giveawayData);
}

async function createDrop(channel, prize, host, delay) {
    const enableTime = Date.now() + delay;
    const embed = createGiveawayEmbed({ prize, host, delay: delay, messageId: 'temp' }, true);
    const buttons = createButtons(true, delay > 0);

    const message = await channel.send({ embeds: [embed], components: [buttons] });
    const giveawayData = { 
        channelId: channel.id, 
        prize, 
        host, 
        isDrop: true, 
        claimed: false, 
        enableTime,
        messageId: message.id 
    };
    giveaways.set(message.id, giveawayData);
    embed.data.fields[0].value = message.id;
    await message.edit({ embeds: [embed] });

    if (delay > 0) {
        setTimeout(async () => {
            if (giveaways.has(message.id) && !giveawayData.claimed) {
                const updatedEmbed = createGiveawayEmbed(giveawayData, true);
                await message.edit({ embeds: [updatedEmbed], components: [createButtons(true)] });
            }
        }, delay);
    }
    saveData();
}

async function rerollGiveaway(interactionOrMessage, messageId) {
    const giveaway = giveaways.get(messageId);
    if (!giveaway || giveaway.isDrop) {
        const reply = createEmbed('❌ Error', 'Giveaway not found or is a drop!', '#ff0000');
        return interactionOrMessage.isCommand?.() 
            ? interactionOrMessage.editReply({ embeds: [reply] })
            : interactionOrMessage.reply({ embeds: [reply] });
    }
    if (!giveaway.ended) {
        const reply = createEmbed('❌ Error', 'This giveaway is still active! Please end it first with `giveaway_end`.', '#ff0000');
        return interactionOrMessage.isCommand?.() 
            ? interactionOrMessage.editReply({ embeds: [reply] })
            : interactionOrMessage.reply({ embeds: [reply] });
    }
    const winners = selectWinners(giveaway.entries, giveaway.winners);
    giveaway.lastWinners = winners;
    saveData();
    const embed = createEmbed(
        '🎉 Giveaway Rerolled!',
        `Rerolled winners for **${giveaway.prize}**: ${winners.map(w => `<@${w}>`).join(', ') || 'No winners'}`,
        '#00ff00'
    );
    if (interactionOrMessage.isCommand?.()) {
        await interactionOrMessage.editReply({ embeds: [embed] });
    } else {
        await interactionOrMessage.reply({ embeds: [embed] });
    }
}

async function listGiveaways(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const guildGiveaways = [...giveaways.entries()].filter(([_, g]) => guild.channels.cache.has(g.channelId) && !g.ended && !g.isDrop);
    const embed = createEmbed(
        '🎉 Active Giveaways',
        guildGiveaways.map(([id, g]) => {
            const channel = `<#${g.channelId}>`;
            return `🎉 [${g.prize}](https://discord.com/channels/${guild.id}/${g.channelId}/${id}) in ${channel} - Ends <t:${Math.floor(g.endTime / 1000)}:R>`;
        }).join('\n') || 'No active giveaways',
        '#00ff00'
    );

    if (interactionOrMessage.isCommand?.()) {
        await interactionOrMessage.editReply({ embeds: [embed] });
    } else {
        await interactionOrMessage.reply({ embeds: [embed] });
    }
}

async function cancelGiveaway(interactionOrMessage, messageId) {
    const giveaway = giveaways.get(messageId);
    if (!giveaway) {
        const reply = createEmbed('❌ Error', 'Giveaway not found!', '#ff0000');
        return interactionOrMessage.isCommand?.() 
            ? interactionOrMessage.editReply({ embeds: [reply] })
            : interactionOrMessage.reply({ embeds: [reply] });
    }
    const channel = client.channels.cache.get(giveaway.channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return;
    const embed = createEmbed(
        `${giveaway.isDrop ? '🎁' : '🎉'} ${giveaway.isDrop ? 'Drop' : 'Giveaway'} Cancelled!`,
        `**Prize:** ${giveaway.prize}\n**Hosted by:** <@${giveaway.host}>`,
        '#ff0000'
    );
    await message.edit({ embeds: [embed], components: [] });
    if (giveawayTimeouts.has(messageId)) clearTimeout(giveawayTimeouts.get(messageId));
    giveaways.delete(messageId);
    saveData();
    const reply = createEmbed('✅ Success', 'Giveaway cancelled!', '#00ff00');
    if (interactionOrMessage.isCommand?.()) {
        await interactionOrMessage.editReply({ embeds: [reply] });
    } else {
        await interactionOrMessage.reply({ embeds: [reply] });
    }
}

client.login(config.token);