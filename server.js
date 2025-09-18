// server.js - updated with transactions and ban system
require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const stringify = require('csv-stringify').stringify;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET","POST"] }
});

const MONGO = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/trading_sim';
const JWT_SECRET = process.env.JWT_SECRET || 'devsecret';
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

mongoose.connect(MONGO, { useNewUrlParser:true, useUnifiedTopology:true })
  .then(()=>console.log('MongoDB connected'))
  .catch(err=>console.error('Mongo err', err));

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  passwordHash: String,
  banned: { type: Boolean, default: false },
  balances: {
    EUR: { type: Number, default: 0 },
    BTC: { type: Number, default: 0 },
    ETH: { type: Number, default: 0 },
    USDT: { type: Number, default: 0 },
    XRP: { type: Number, default: 0 },
    LTC: { type: Number, default: 0 },
  },
  history: { type: Array, default: [] }
}, { timestamps:true });

const chatSchema = new mongoose.Schema({
  user: String,
  messages: [{ from: String, text: String, time: Date }]
}, { timestamps:true });

const txSchema = new mongoose.Schema({
  username: String,
  type: String, // deposit, withdrawal, buy, sell, admin-adjust
  pair: String,
  amount: Number,
  currency: String,
  side: String,
  valueEUR: Number,
  timestamp: { type: Date, default: Date.now }
}, { timestamps:true });

const User = mongoose.model('User', userSchema);
const Chat = mongoose.model('Chat', chatSchema);
const Transaction = mongoose.model('Transaction', txSchema);

function sanitizeUser(u){
  if(!u) return null;
  return {
    username: u.username,
    balances: u.balances,
    history: u.history,
    banned: u.banned,
    id: u._id
  };
}

app.post('/api/register', async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({error:'missing'});
  if(username === 'admin') return res.status(400).json({error:'username unavailable'});
  try{
    const exists = await User.findOne({username});
    if(exists) return res.status(400).json({error:'user exists'});
    const hash = await bcrypt.hash(password, 10);
    const u = new User({ username, passwordHash: hash });
    await u.save();
    await Chat.create({ user: username, messages: [] });
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn:'7d' });
    return res.json({ token, user: sanitizeUser(u) });
  }catch(err){ console.error(err); return res.status(500).json({error:'server'}); }
});

app.post('/api/login', async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.status(400).json({error:'missing'});
  try{
    if(username === 'admin'){
      const adminPass = process.env.ADMIN_PASS || '12041998avril1999A';
      if(password !== adminPass) return res.status(401).json({error:'invalid'});
      const token = jwt.sign({ username:'admin', admin:true }, JWT_SECRET, { expiresIn:'7d' });
      return res.json({ token, user: { username:'admin', admin:true } });
    }
    const u = await User.findOne({ username });
    if(!u) return res.status(401).json({error:'invalid'});
    if(u.banned) return res.status(403).json({ error: 'Your account has been banned by admin.' });
    const ok = await bcrypt.compare(password, u.passwordHash);
    if(!ok) return res.status(401).json({error:'invalid'});
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn:'7d' });
    return res.json({ token, user: sanitizeUser(u) });
  }catch(err){ console.error(err); return res.status(500).json({error:'server'}); }
});

const authMiddleware = (req,res,next)=>{
  const h = req.headers.authorization;
  if(!h) return res.status(401).json({error:'no auth'});
  const token = h.split(' ')[1];
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch(e){ return res.status(401).json({error:'invalid token'}); }
};

app.get('/api/admin/users', authMiddleware, async (req,res)=>{
  if(!req.user || req.user.username !== 'admin') return res.status(403).json({error:'forbidden'});
  const users = await User.find({}, '-passwordHash').lean();
  res.json(users);
});

app.post('/api/admin/set-balance', authMiddleware, async (req,res)=>{
  if(!req.user || req.user.username !== 'admin') return res.status(403).json({error:'forbidden'});
  const { username, currency, amount } = req.body;
  if(!username || !currency || typeof amount !== 'number') return res.status(400).json({error:'missing'});
  const user = await User.findOne({ username });
  if(!user) return res.status(404).json({error:'not found'});
  user.balances[currency] = amount;
  user.history.push({type:'admin-adjust', currency, amount, date: new Date(), by:'admin'});
  await user.save();
  await Transaction.create({ username, type:'admin-adjust', currency, amount, valueEUR: null });
  io.to(username).emit('balance_updated', { username, currency, amount, balances: user.balances });
  await Chat.findOneAndUpdate({ user: username }, { $push: { messages: { from:'admin', text:`Your ${currency} balance set to ${amount}`, time:new Date() } } }, { upsert:true });
  io.to(username).emit('chat_message', { user: username, from:'admin', text:`Your ${currency} balance set to ${amount}`, time:new Date() });
  res.json({ ok:true });
});

// Admin ban/unban
app.post('/api/admin/ban', authMiddleware, async (req,res)=>{
  if(!req.user || req.user.username !== 'admin') return res.status(403).json({error:'forbidden'});
  const { username, ban } = req.body;
  if(!username || typeof ban !== 'boolean') return res.status(400).json({error:'missing'});
  const user = await User.findOne({ username });
  if(!user) return res.status(404).json({error:'not found'});
  user.banned = ban;
  await user.save();
  // notify user (if connected)
  io.to(username).emit('banned', { banned: ban, message: ban ? 'You have been banned by admin.' : 'You have been unbanned by admin.' });
  res.json({ ok:true });
});

app.get('/api/admin/chat/:username', authMiddleware, async (req,res)=>{
  if(!req.user || req.user.username !== 'admin') return res.status(403).json({error:'forbidden'});
  const username = req.params.username;
  const doc = await Chat.findOne({ user: username }).lean();
  res.json(doc ? doc.messages : []);
});

// Export transactions as CSV
app.get('/api/transactions/export', authMiddleware, async (req,res)=>{
  // admin can export all, user can export only their own
  const requester = req.user;
  const { username } = req.query; // optional, admin may pass username
  let filter = {};
  if(requester.username === 'admin'){
    if(username) filter.username = username;
  } else {
    // user must export their own
    filter.username = requester.username;
  }
  const txs = await Transaction.find(filter).sort({ timestamp: -1 }).lean();
  // convert to CSV
  const records = txs.map(t=>({ username: t.username, type: t.type, pair: t.pair||'', amount: t.amount||'', currency: t.currency||'', side: t.side||'', valueEUR: t.valueEUR||'', timestamp: t.timestamp }));
  res.setHeader('Content-Disposition', `attachment; filename="transactions_${filter.username||'all'}.csv"`);
  res.setHeader('Content-Type','text/csv');
  stringify(records, { header:true }).pipe(res);
});

app.get('/api/prices', (req,res)=>{
  res.json(serverPriceSnapshot());
});

// --- In-memory market simulation ---
const PAIRS = {
  'BTC/EUR': { symbol:'BTC', price:25000, vol:0.03 },
  'ETH/EUR': { symbol:'ETH', price:1500, vol:0.04 },
  'USDT/EUR': { symbol:'USDT', price:1, vol:0.001 },
  'XRP/EUR': { symbol:'XRP', price:0.5, vol:0.06 },
  'LTC/EUR': { symbol:'LTC', price:80, vol:0.05 }
};
const priceSeries = {};
Object.keys(PAIRS).forEach(k=>priceSeries[k]=[PAIRS[k].price]);

function stepMarket(){
  Object.keys(PAIRS).forEach(pair=>{
    const meta = PAIRS[pair];
    const last = priceSeries[pair].length ? priceSeries[pair][ priceSeries[pair].length -1 ] : meta.price;
    const shock = (Math.random()-0.5)*2 * meta.vol;
    const drift = (Math.random()-0.5) * 0.001;
    const next = Math.max(0.0000001, last * (1 + shock + drift));
    priceSeries[pair].push(next);
    if(priceSeries[pair].length > 300) priceSeries[pair].shift();
  });
  io.emit('prices', serverPriceSnapshot());
}

function serverPriceSnapshot(){
  const out = {};
  Object.keys(priceSeries).forEach(pair=>{
    out[pair] = priceSeries[pair][priceSeries[pair].length-1];
  });
  return out;
}
setInterval(stepMarket, 1000);

// Socket.io
io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);

  socket.on('auth', async ({ token })=>{
    try{
      const payload = jwt.verify(token, JWT_SECRET);
      socket.user = payload;
      if(payload.username === 'admin'){
        socket.join('admins');
        socket.emit('prices', serverPriceSnapshot());
      } else {
        socket.join(payload.username);
        const user = await User.findOne({ username: payload.username }).lean();
        if(user && user.banned){
          socket.emit('banned', { banned:true, message:'Your account is banned.' });
          socket.disconnect(true);
          return;
        }
        socket.emit('auth_ok', { user: sanitizeUser(user) });
        const chat = await Chat.findOne({ user: payload.username }).lean();
        socket.emit('chat_history', chat ? chat.messages : []);
      }
    }catch(e){
      socket.emit('auth_error', { msg:'invalid token' });
    }
  });

  socket.on('send_chat', async ({ token, text })=>{
    try{
      const payload = jwt.verify(token, JWT_SECRET);
      const username = payload.username;
      const user = await User.findOne({ username });
      if(user && user.banned) return socket.emit('banned', { banned:true, message:'Your account is banned.' });
      await Chat.findOneAndUpdate({ user: username }, { $push: { messages: { from: username, text, time: new Date() } } }, { upsert:true });
      io.to('admins').emit('chat_message', { user: username, from: username, text, time: new Date() });
      io.to(username).emit('chat_message', { user: username, from: username, text, time: new Date() });
    }catch(e){ console.error('send_chat err', e); }
  });

  socket.on('admin_reply', async ({ token, username, text })=>{
    try{
      const payload = jwt.verify(token, JWT_SECRET);
      if(payload.username !== 'admin') return;
      await Chat.findOneAndUpdate({ user: username }, { $push: { messages: { from: 'admin', text, time: new Date() } } }, { upsert:true });
      io.to(username).emit('chat_message', { user: username, from: 'admin', text, time: new Date() });
      io.to('admins').emit('chat_message', { user: username, from: 'admin', text, time: new Date() });
    }catch(e){ console.error('admin_reply err', e); }
  });

  socket.on('trade', async ({ token, pair, type, amountBase })=>{
    try{
      const payload = jwt.verify(token, JWT_SECRET);
      const username = payload.username;
      const meta = PAIRS[pair];
      if(!meta) return socket.emit('trade_result', { ok:false, reason:'invalid pair' });
      const user = await User.findOne({ username });
      if(user && user.banned) return socket.emit('trade_result', { ok:false, reason:'banned' });
      const currentPrice = serverPriceSnapshot()[pair];
      if(type === 'buy'){
        const cost = amountBase * currentPrice;
        if((user.balances.EUR||0) < cost) return socket.emit('trade_result', { ok:false, reason:'insufficient EUR' });
        user.balances.EUR -= cost;
        user.balances[meta.symbol] = (user.balances[meta.symbol]||0) + amountBase;
        user.history.push({ type:'buy', pair, amountBase, price: currentPrice, date: new Date() });
        await Transaction.create({ username, type:'buy', pair, amount: amountBase, currency: meta.symbol, valueEUR: cost, timestamp: new Date() });
      } else {
        if((user.balances[meta.symbol]||0) < amountBase) return socket.emit('trade_result', { ok:false, reason:'insufficient asset' });
        user.balances[meta.symbol] -= amountBase;
        const proceeds = amountBase * currentPrice;
        user.balances.EUR = (user.balances.EUR||0) + proceeds;
        user.history.push({ type:'sell', pair, amountBase, price: currentPrice, date: new Date() });
        await Transaction.create({ username, type:'sell', pair, amount: amountBase, currency: meta.symbol, valueEUR: proceeds, timestamp: new Date() });
      }
      await user.save();
      socket.emit('trade_result', { ok:true, balances: user.balances });
      io.to('admins').emit('user_update', { username, balances: user.balances });
    }catch(e){ console.error('trade err', e); socket.emit('trade_result', { ok:false, reason:'server' }); }
  });

  socket.on('disconnect', ()=>{ /* nothing */ });
});

// Export CSV helper endpoint for admin/all users handled above
// (Transaction export endpoint already implemented)

// seed
async function seedAdmin(){
  const exists = await User.findOne({ username:'admin' });
  if(!exists){
    const admin = new User({ username:'admin', passwordHash:'', balances:{EUR:0,BTC:0,ETH:0,USDT:0,XRP:0,LTC:0}, history:[] });
    await admin.save().catch(()=>{});
  }
}
seedAdmin().catch(()=>{});

server.listen(PORT, ()=>console.log('Server started on', PORT));
