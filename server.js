import express from "express";
import http from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "secret";
const ADMIN_PASS = process.env.ADMIN_PASS || "adminpass";

app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// User schema
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true },
  password: String,
  balances: { type: Map, of: Number, default: {} },
  banned: { type: Boolean, default: false }
});

const User = mongoose.model("User", userSchema);

// Transaction schema
const transactionSchema = new mongoose.Schema({
  username: String,
  type: String, // deposit, withdraw, trade, adjustment
  currency: String,
  amount: Number,
  date: { type: Date, default: Date.now }
});

const Transaction = mongoose.model("Transaction", transactionSchema);

// JWT middleware
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"];
  if (!token) return res.status(401).json({ error: "No token" });
  try {
    const decoded = jwt.verify(token.split(" ")[1], JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: "Invalid token" });
  }
}

// Auth routes
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  try {
    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashed });
    await user.save();
    res.json({ message: "User registered" });
  } catch (err) {
    res.status(400).json({ error: "User already exists" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === "admin") {
    if (password === ADMIN_PASS) {
      const token = jwt.sign({ username: "admin", role: "admin" }, JWT_SECRET);
      return res.json({ token, role: "admin" });
    } else return res.status(403).json({ error: "Wrong admin password" });
  }
  const user = await User.findOne({ username });
  if (!user) return res.status(403).json({ error: "User not found" });
  if (user.banned) return res.status(403).json({ error: "Your account has been banned by admin." });
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(403).json({ error: "Invalid credentials" });
  const token = jwt.sign({ username: user.username, role: "user" }, JWT_SECRET);
  res.json({ token, role: "user" });
});

// Admin ban/unban
app.post("/api/admin/ban", authMiddleware, async (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  const { username, banned } = req.body;
  const user = await User.findOneAndUpdate({ username }, { banned }, { new: true });
  if (!user) return res.status(404).json({ error: "User not found" });
  io.to(username).emit("banned");
  res.json({ message: `User ${banned ? "banned" : "unbanned"}` });
});

// Export transactions as CSV
import { stringify } from "csv-stringify";
app.get("/api/transactions/export", authMiddleware, async (req, res) => {
  let query = {};
  if (req.user.role !== "admin") {
    query.username = req.user.username;
  } else if (req.query.username) {
    query.username = req.query.username;
  }
  const txs = await Transaction.find(query).lean();
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=transactions.csv");
  stringify(txs, { header: true }).pipe(res);
});

// Socket.io auth
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("No token"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  const { username, role } = socket.user;
  socket.join(username);
  if (role === "admin") socket.join("admins");

  socket.on("chat", (msg) => {
    if (role === "user") {
      io.to("admins").emit("chat", { from: username, text: msg });
    } else {
      const { to, text } = msg;
      io.to(to).emit("chat", { from: "admin", text });
    }
  });
});

// Static serving for Render
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Health check route for Render
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
