const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { useSupabaseAuthState } = require('./supabaseAuth');

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

let sock = null;
let connectionStatus = 'connecting'; // connecting | need_qr | connected | disconnected
let latestQR = null;
let authHandle = null; // saveCreds/clearSession রাখার জন্য, disconnect হ্যান্ডলারে দরকার হয়

async function connectToWhatsApp() {
  authHandle = await useSupabaseAuthState(
    process.env.DATABASE_URL,
    process.env.WHATSAPP_SESSION_ID || 'main'
  );
  const { state, saveCreds } = authHandle;

  // সর্বশেষ WhatsApp Web প্রোটোকল ভার্সন জানার চেষ্টা করা হয়, না পেলে Baileys-এর ডিফল্ট ভার্সন ব্যবহার হবে
  let version;
  try {
    version = (await fetchLatestBaileysVersion()).version;
  } catch (e) {
    console.warn('সর্বশেষ WhatsApp ভার্সন জানা যায়নি, ডিফল্ট ভার্সন দিয়ে চেষ্টা হচ্ছে।');
  }

  sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['OTP Gateway', 'Chrome', '1.0.0'],
    ...(version ? { version } : {}),
  });

  // নতুন session key তৈরি হলেই Supabase-এ সেভ হবে
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      connectionStatus = 'need_qr';
      console.log('নতুন QR কোড তৈরি হয়েছে — /qr এন্ডপয়েন্টে গিয়ে স্ক্যান করুন');
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output?.statusCode
          : null;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log(
          '❌ WhatsApp থেকে logged out করা হয়েছে। Supabase-এ থাকা পুরনো session সাফ করে নতুন QR তৈরি করা হচ্ছে।'
        );
        if (authHandle?.clearSession) await authHandle.clearSession();
        setTimeout(connectToWhatsApp, 1000);
      } else {
        console.log('⚠️ কানেকশন বিচ্ছিন্ন হয়েছে, ৩ সেকেন্ড পর আবার চেষ্টা হচ্ছে...');
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      connectionStatus = 'connected';
      latestQR = null;
      console.log('✅ WhatsApp কানেক্টেড এবং মেসেজ পাঠানোর জন্য প্রস্তুত (session Supabase-এ সেভ আছে)');
    }
  });

  return sock;
}

function getStatus() {
  return connectionStatus;
}

function getLatestQR() {
  return latestQR;
}

// "8801XXXXXXXXX", "+8801XXXXXXXXX", "8801XXXXXXXXX@s.whatsapp.net" — সবগুলোকেই সঠিক JID ফরম্যাটে আনে
function normalizePhoneToJid(phone) {
  if (phone.includes('@s.whatsapp.net')) return phone;
  const digitsOnly = phone.replace(/[^0-9]/g, '');
  return `${digitsOnly}@s.whatsapp.net`;
}

async function sendWhatsAppMessage(phone, message) {
  if (!sock) {
    throw new Error('WhatsApp socket এখনো initialize হয়নি');
  }
  const jid = normalizePhoneToJid(phone);
  return sock.sendMessage(jid, { text: message });
}

// PDF/ছবির মতো ফাইল (base64) কে WhatsApp ডকুমেন্ট হিসেবে পাঠায় — যেমন ইনভয়েস PDF।
// কোনো Puppeteer/হেডলেস ব্রাউজার লাগে না, তাই ফ্রি-টায়ারের সীমিত RAM-এও নিরাপদ।
async function sendWhatsAppDocument(phone, base64Data, fileName, caption) {
  if (!sock) {
    throw new Error('WhatsApp socket এখনো initialize হয়নি');
  }
  const jid = normalizePhoneToJid(phone);
  const buffer = Buffer.from(base64Data, 'base64');
  return sock.sendMessage(jid, {
    document: buffer,
    fileName: fileName || 'document.pdf',
    mimetype: 'application/pdf',
    ...(caption ? { caption } : {}),
  });
}

module.exports = {
  connectToWhatsApp,
  getStatus,
  getLatestQR,
  sendWhatsAppMessage,
  sendWhatsAppDocument,
};
