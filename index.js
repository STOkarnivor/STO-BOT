// ========================================
// DISCORD BOT - Voice Announcement Bot
// ========================================

const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus, entersState } = require('@discordjs/voice');
const https = require('https');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Create HTTP server to satisfy Render's port requirement
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Discord bot is running!\n');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_URL = process.env.API_URL || 'https://182a5878-23b3-4680-8feb-f8d982648ab0.web.createdevserver.com';

if (!DISCORD_BOT_TOKEN) {
  console.error('❌ Missing DISCORD_BOT_TOKEN');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});
// Diagnostic: Check voice dependencies
console.log('🔍 Checking voice dependencies...');
try {
  require('@discordjs/opus');
  console.log('✅ @discordjs/opus found');
} catch (e) {
  console.log('❌ @discordjs/opus missing:', e.message);
}

try {
  require('sodium-native');
  console.log('✅ sodium-native found');
} catch (e) {
  console.log('❌ sodium-native missing:', e.message);
}

try {
  const { getVoiceConnection } = require('@discordjs/voice');
  console.log('✅ @discordjs/voice loaded');
} catch (e) {
  console.log('❌ @discordjs/voice error:', e.message);
}
let currentConnection = null;
let announcementCheckInterval = null;
let lastAnnouncedMinute = -1;

const commands = [
  new SlashCommandBuilder()
    .setName('timer')
    .setDescription('Start a match timer')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Timer name')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the current timer'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check timer status'),
].map(cmd => cmd.toJSON());

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_BOT_TOKEN);
  try {
    console.log('📝 Registering commands...');
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, guildId),
      { body: commands }
    );
    console.log('✅ Commands registered!');
  } catch (error) {
    console.error('❌ Command registration failed:', error);
  }
}

async function downloadAudio(url, filePath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

async function checkAndPlayAnnouncements() {
  try {
    const res = await fetch(`${API_URL}/api/match/active`);
    const match = await res.json();
    
    if (!match || !match.is_running || !currentConnection) {
      return;
    }

    const currentMinute = match.elapsed_minutes;
    console.log(`⏱️ Minute ${currentMinute}`);
    
    if (currentMinute !== lastAnnouncedMinute) {
      const announceRes = await fetch(`${API_URL}/api/timer-announcements?timer_id=${match.timer_id}&minute=${currentMinute}`);
      const announcements = await announceRes.json();
      
      console.log(`📋 ${announcements.length} announcements`);
      
      if (announcements && announcements.length > 0) {
        for (const announcement of announcements) {
          console.log(`🎵 "${announcement.message_text}"`);
          await playAnnouncement(announcement.audio_url);
        }
        lastAnnouncedMinute = currentMinute;
      }
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

async function playAnnouncement(audioUrl) {
  if (!currentConnection) return;
  
  try {
    await entersState(currentConnection, VoiceConnectionStatus.Ready, 30_000);
    
    const tempFile = path.join(__dirname, `temp_${Date.now()}.mp3`);
    await downloadAudio(audioUrl, tempFile);
    
    const stats = fs.statSync(tempFile);
    if (stats.size < 100) {
      fs.unlinkSync(tempFile);
      return;
    }
    
    const player = createAudioPlayer();
    const resource = createAudioResource(tempFile, { inlineVolume: true });
    resource.volume.setVolume(0.5);
    
    console.log('▶️ Playing...');
    player.play(resource);
    currentConnection.subscribe(player);
    
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        player.stop();
        resolve();
      }, 30000);
      
      player.on(AudioPlayerStatus.Idle, () => {
        clearTimeout(timeout);
        console.log('✅ Done');
        try { fs.unlinkSync(tempFile); } catch (e) {}
        resolve();
      });
      
      player.on('error', error => {
        clearTimeout(timeout);
        console.error('❌ Player error:', error);
        try { fs.unlinkSync(tempFile); } catch (e) {}
        resolve();
      });
    });
  } catch (error) {
    console.error('❌ Play error:', error.message);
  }
}

function startAnnouncementChecking() {
  if (announcementCheckInterval) clearInterval(announcementCheckInterval);
  announcementCheckInterval = setInterval(checkAndPlayAnnouncements, 5000);
  lastAnnouncedMinute = -1;
}

function stopAnnouncementChecking() {
  if (announcementCheckInterval) {
    clearInterval(announcementCheckInterval);
    announcementCheckInterval = null;
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  for (const [guildId] of client.guilds.cache) {
    await registerCommands(guildId);
  }
  
  setInterval(async () => {
    try {
      await fetch(`${API_URL}/api/bot-heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_online: true })
      });
    } catch (e) {}
  }, 30000);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  
  // DEFER IMMEDIATELY to prevent timeout
  try {
    await interaction.deferReply();
  } catch (error) {
    console.error('❌ Failed to defer reply:', error.message);
    return;
  }
  
  const hasPermission = 
    interaction.member.permissions.has('Administrator') ||
    interaction.member.roles.cache.some(role => role.name === 'GVG SHOT-CALLER');
  
  if (!hasPermission) {
    return interaction.editReply('❌ You need "GVG SHOT-CALLER" role or admin.');
  }

  try {
    if (interaction.commandName === 'timer') {
      const timerName = interaction.options.getString('name');
      const voiceChannel = interaction.member.voice.channel;
      
      if (!voiceChannel) {
        return interaction.editReply('❌ Join a voice channel first!');
      }
      
      const res = await fetch(`${API_URL}/api/match/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          timer_name: timerName,
          voice_channel_id: voiceChannel.id 
        })
      });
      
      if (res.ok) {
        if (currentConnection) currentConnection.destroy();
        
        currentConnection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guildId,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });
        
        currentConnection.on(VoiceConnectionStatus.Ready, () => {
          console.log('🎤 Voice ready');
        });
        
        currentConnection.on('error', error => {
          console.error('❌ Voice error:', error.message);
        });
        
        try {
          await entersState(currentConnection, VoiceConnectionStatus.Ready, 20_000);
          startAnnouncementChecking();
          await interaction.editReply(`✅ **${timerName}** started! 🎤`);
        } catch (error) {
          console.error('❌ Voice connection failed:', error.message);
          await interaction.editReply(`❌ Voice failed: ${error.message}`);
          if (currentConnection) {
            currentConnection.destroy();
            currentConnection = null;
          }
        }
      } else {
        const error = await res.json();
        await interaction.editReply(`❌ ${error.error || 'Failed to start timer'}`);
      }
    }
    
    else if (interaction.commandName === 'stop') {
      await fetch(`${API_URL}/api/match/stop`, { method: 'POST' });
      stopAnnouncementChecking();
      if (currentConnection) {
        currentConnection.destroy();
        currentConnection = null;
      }
      await interaction.editReply('⏹️ Timer stopped!');
    }
    
    else if (interaction.commandName === 'status') {
      const res = await fetch(`${API_URL}/api/match/active`);
      const data = await res.json();
      
      if (data && data.is_running) {
        await interaction.editReply(`⏱️ **${data.timer_name}** - ${data.elapsed_minutes} minutes elapsed`);
      } else {
        await interaction.editReply('ℹ️ No active timer');
      }
    }
  } catch (error) {
    console.error('❌ Command error:', error.message);
    try {
      await interaction.editReply(`❌ Error: ${error.message}`);
    } catch (e) {
      console.error('❌ Could not send error message:', e.message);
    }
  }
});

client.login(DISCORD_BOT_TOKEN);
console.log('🚀 Starting bot...');

