require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const {
  connectToWhatsApp,
  getStatus,
  getLatestQR,
  sendWhatsAppMessage,
  sendWhatsAppDocument,
} = require('./whatsapp');

const app = express();
// ডিফল্ট 100kb limit base64 PDF-এর জন্য যথেষ্ট না, তাই বাড়ানো হলো
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const RATE_LIMIT_MAX = parseInt(process.env.MAX_MESSAGES_PER_MINUTE || '20', 10);

if (!API_KEY) {
  console.warn(
    '⚠️  .env এ API_KEY সেট নেই — API_KEY সেট না করা পর্যন্ত /send-message ও /qr সব রিকোয়েস্ট রিজেক্ট করবে।'
  );
}

// API key যাচাই — header (x-api-key) অথবা query (?key=) দুটোই সাপোর্ট করে, যাতে ব্রাউজারে সহজে /qr খোলা যায়
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

// সাধারণ সেফটি নেট — মূল App/Web-এর যেকোনো জায়গা থেকে এখন কল আসতে পারে, তাই কোনো bug/loop
// যদি বারবার একই মেসেজ পাঠাতে থাকে, সেটা পুরো নম্বরটাকে ban-এর ঝুঁকিতে ফেলার আগেই আটকানো
const sendTimestamps = [];
function checkRateLimit() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  while (sendTimestamps.length && sendTimestamps[0] < oneMinuteAgo) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= RATE_LIMIT_MAX) return false;
  sendTimestamps.push(now);
  return true;
}

app.get('/', (req, res) => {
  res.send('WhatsApp Message Gateway চলছে। স্ট্যাটাসের জন্য /health দেখুন।');
});

// Render কে জাগিয়ে রাখতে এখানে প্রতি ~১০ মিনিটে ping করুন — একইসাথে WhatsApp কানেকশনের অবস্থাও জানাবে
app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: getStatus() });
});

// প্রথমবার পেয়ার করতে বা সেশন হারালে আবার পেয়ার করতে QR কোড দেখার এন্ডপয়েন্ট
app.get('/qr', requireApiKey, async (req, res) => {
  const status = getStatus();
  if (status === 'connected') {
    return res.send('<h2>ইতিমধ্যে কানেক্টেড ✅ — নতুন QR দরকার নেই</h2>');
  }
  const qr = getLatestQR();
  if (!qr) {
    return res.send(
      '<meta http-equiv="refresh" content="3"><h2>QR এখনো তৈরি হয়নি, কয়েক সেকেন্ড পর রিফ্রেশ করুন</h2>'
    );
  }
  const dataUrl = await QRCode.toDataURL(qr);
  // Baileys প্রতি ~২০ সেকেন্ডে QR পাল্টে ফেলে — পেজ নিজে থেকে রিফ্রেশ না হলে
  // ততক্ষণে পুরনো/মৃত QR স্ক্যান হয়ে যায়, WhatsApp তখন লিংক না করে স্ক্যান পেজে ফেরত পাঠায়।
  // তাই ১৫ সেকেন্ড পরপর অটো-রিফ্রেশ যোগ করা হলো, QR সবসময় সতেজ থাকবে।
  res.send(
    `<meta http-equiv="refresh" content="15">
<div style="text-align:center;font-family:sans-serif">
  <h3>WhatsApp থেকে (Linked Devices) স্ক্যান করুন</h3>
  <img src="${dataUrl}" />
  <p style="color:#888">QR প্রতি ১৫ সেকেন্ডে অটো-রিফ্রেশ হয় — দেরি না করে স্ক্যান করুন</p>
</div>`
  );
});

// মূল App/Web যা কিছু WhatsApp-এ পাঠাতে চায় — OTP, অর্ডার কনফার্মেশন, রিমাইন্ডার, ডেলিভারি
// আপডেট, যেকোনো কিছু — সবই এই একই এন্ডপয়েন্ট দিয়ে যাবে। message-এর কনটেন্টে কোনো বাধা নেই।
// `type` ঐচ্ছিক — শুধু লগে কী ধরনের মেসেজ সেটা বোঝার জন্য, ভবিষ্যতে ডিবাগ/মনিটরিং সহজ করবে।
app.post('/send-message', requireApiKey, async (req, res) => {
  const { phone, message, type } = req.body || {};
  const label = type || 'general';

  if (!phone || !message) {
    return res.status(400).json({ error: 'phone এবং message দুটোই আবশ্যক' });
  }

  if (getStatus() !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp এখনো কানেক্টেড না — /qr চেক করুন' });
  }

  if (!checkRateLimit()) {
    console.warn(`⚠️ Rate limit ছুঁয়ে ফেলেছে (${RATE_LIMIT_MAX}/মিনিট) — রিকোয়েস্ট রিজেক্ট হলো [${label}] → ${phone}`);
    return res.status(429).json({ error: 'অনেক বেশি রিকোয়েস্ট আসছে, একটু পর আবার চেষ্টা করুন' });
  }

  try {
    await sendWhatsAppMessage(phone, message);
    console.log(`✅ [${label}] পাঠানো হয়েছে → ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ [${label}] পাঠাতে ব্যর্থ → ${phone}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// মূল App/Web থেকে PDF (যেমন ইনভয়েস) base64 আকারে পাঠালে সেটা WhatsApp ডকুমেন্ট হিসেবে ফরওয়ার্ড করে —
// কোনো Puppeteer/স্ক্রিনশট নেই, তাই ছোট আর হালকা; ফ্রি-টায়ারের 512MB RAM-এ নিরাপদে চলে
app.post('/send-document', requireApiKey, async (req, res) => {
  const { phone, base64Data, fileName, caption, type } = req.body || {};
  const label = type || 'document';

  if (!phone || !base64Data) {
    return res.status(400).json({ error: 'phone এবং base64Data দুটোই আবশ্যক' });
  }

  if (getStatus() !== 'connected') {
    return res.status(503).json({ error: 'WhatsApp এখনো কানেক্টেড না — /qr চেক করুন' });
  }

  if (!checkRateLimit()) {
    console.warn(`⚠️ Rate limit ছুঁয়ে ফেলেছে (${RATE_LIMIT_MAX}/মিনিট) — রিকোয়েস্ট রিজেক্ট হলো [${label}] → ${phone}`);
    return res.status(429).json({ error: 'অনেক বেশি রিকোয়েস্ট আসছে, একটু পর আবার চেষ্টা করুন' });
  }

  try {
    await sendWhatsAppDocument(phone, base64Data, fileName, caption);
    console.log(`✅ [${label}] ডকুমেন্ট পাঠানো হয়েছে → ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ [${label}] ডকুমেন্ট পাঠাতে ব্যর্থ → ${phone}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 সার্ভার চলছে পোর্ট ${PORT}-এ`);
  connectToWhatsApp();
});
