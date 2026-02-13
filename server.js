/******************************
 LIWZ – FINAL FULL SERVER
******************************/
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const { Server } = require("socket.io");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const User = require("./models/User");
const Conversation = require("./models/Conversation");
const Message = require("./models/Message");

const app = express();
const server = http.createServer(app);

/* ================= LOAD ADMIN ================= */
/* LOAD ONLY ONCE — NOT INSIDE SOCKET */
require("./admin-server")(app, server, mongoose);

/* ================= SOCKET ================= */

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.engine.on("connection_error", (err) => {
  console.log("❌ Engine connection error");
  console.log(err.code);
  console.log(err.message);
  console.log(err.context);
});

const onlineUsers = new Map();

/* ================= SOCKET CONNECTION ================= */

io.on("connection", (socket) => {

  console.log("🟢 Socket connected:", socket.id);

  /* ================= ONLINE ================= */

  socket.on("online", async (userId) => {
    try {

      if (!userId) return;

      userId = userId.toString();

      onlineUsers.set(userId, socket.id);

      await User.findByIdAndUpdate(userId, {
        online: true,
        lastActive: new Date()
      });

      socket.broadcast.emit("userOnline", userId);

    } catch (err) {
      console.log("❌ Online error:", err);
    }
  });

  /* ================= DISCONNECT ================= */

  socket.on("disconnect", async () => {
    try {

      console.log("🔴 Socket disconnected:", socket.id);

      // Remove offline user
      for (const [userId, sockId] of onlineUsers.entries()) {
        if (sockId === socket.id) {

          onlineUsers.delete(userId);

          await User.findByIdAndUpdate(userId, {
            online: false,
            lastActive: new Date()
          });

          socket.broadcast.emit("userOffline", userId);
          break;
        }
      }

    } catch (err) {
      console.log("Disconnect error:", err);
    }
  });

  /* ================= JOIN ROOM ================= */

  socket.on("joinRoom", async ({ roomId, userId }) => {
    try {

      socket.join(roomId.toString());

      if (userId) {
        await User.findByIdAndUpdate(userId, {
          unreadCount: 0
        });
      }

      socket.emit("unreadUpdate");

    } catch (err) {
      console.log("Join room error:", err);
    }
  });

  /* ================= TYPING ================= */

  socket.on("typing", ({ roomId, userId }) => {
    socket.to(roomId).emit("typing", { userId });
  });

  socket.on("stopTyping", ({ roomId, userId }) => {
    socket.to(roomId).emit("stopTyping", { userId });
  });

  /* ================= SEND MESSAGE ================= */

  socket.on("sendMessage", async data => {
    try {
      const msg = await Message.create({
        conversation: data.roomId,
        sender: data.sender,
        text: data.text,      // text, image html, or audio html
        seen: false,
        edited: false
      });

      await Conversation.findByIdAndUpdate(data.roomId, {
        lastMessage: msg._id,
        updatedAt: new Date()
      });

      io.to(data.roomId).emit("newMessage", {
        _id: msg._id,
        text: msg.text,
        sender: data.sender,
        createdAt: msg.createdAt,
        seen: false,
        edited: false
      });

      if (data.receiver) {
        await User.findByIdAndUpdate(data.receiver, {
          $inc: { unreadCount: 1 }
        });

        const receiverSocket = onlineUsers.get(data.receiver.toString());

        if (receiverSocket) {
          io.to(receiverSocket).emit("unreadUpdate");
          io.to(receiverSocket).emit("delivered", {
            messageId: msg._id,
            roomId: data.roomId
          });
        }
      }

    } catch (err) {
      console.log("❌ Send message error:", err);
    }
  });

/* ================= MATCH REALTIME ================= */

socket.on("matchCreated", ({ toUserId, fromUser }) => {
  const receiverSocket = onlineUsers.get(toUserId.toString());

  if (receiverSocket) {
    io.to(receiverSocket).emit("newMatch", {
      name: fromUser.name,
      photo: fromUser.photo,
      userId: fromUser._id
    });
  }
});

  /* ================= EDIT MESSAGE ================= */

  socket.on("editMessage", async ({ messageId, newText, roomId }) => {
    try {
      const msg = await Message.findByIdAndUpdate(
        messageId,
        { text: newText, edited: true },
        { new: true }
      );

      io.to(roomId).emit("messageEdited", {
        messageId,
        newText,
        edited: true
      });

    } catch (err) {
      console.log("❌ Edit error:", err);
    }
  });

  /* ================= DELETE MESSAGE ================= */

  socket.on("deleteMessage", async ({ messageId, roomId }) => {
    try {
      await Message.findByIdAndDelete(messageId);

      io.to(roomId).emit("messageDeleted", {
        messageId
      });

    } catch (err) {
      console.log("❌ Delete error:", err);
    }
  });

  /* ================= SEEN ================= */

  socket.on("seen", async ({ roomId, userId }) => {
    try {
      await Message.updateMany(
        {
          conversation: roomId,
          sender: { $ne: userId },
          seen: false
        },
        { seen: true }
      );

      socket.to(roomId).emit("seen");

    } catch (err) {
      console.log("❌ Seen error:", err);
    }
  });

  /* ================= DISCONNECT ================= */

  socket.on("disconnect", async () => {
    for (let [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id) {

        onlineUsers.delete(userId);

        await User.findByIdAndUpdate(userId, {
          online: false,
          lastActive: new Date()
        });

        socket.broadcast.emit("userOffline", userId);
        break;
      }
    }
  });

});

/* ================= DATABASE ================= */
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected");

    // 🔥 FIX NOTIFICATIONS (string → object)
    await mongoose.connection.collection("users").updateMany(
      { "notifications.0": { $type: "string" } },
      [
        {
          $set: {
            notifications: {
              $map: {
                input: "$notifications",
                as: "n",
                in: {
                  text: "$$n",
                  link: "/notifications",
                  read: true,
                  date: "$$NOW"
                }
              }
            }
          }
        }
      ]
    );

    // 🔥 FIX PHOTOS (string → object)
    await mongoose.connection.collection("users").updateMany(
      { "photos.0": { $type: "string" } },
      [
        {
          $set: {
            photos: {
              $map: {
                input: "$photos",
                as: "p",
                in: {
                  url: "$$p",
                  likes: []
                }
              }
            }
          }
        }
      ]
    );

  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });

/* ================= MIDDLEWARE ================= */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "liwz_secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

/* ================= AUTH ================= */
const requireLogin = async (req, res, next) => {
  try {

    if (!req.session.userId) return res.redirect("/login");

    const user = await User.findById(req.session.userId).select("banned deleted");

    if (!user) {
      req.session.destroy();
      return res.redirect("/login");
    }

    // 🚫 BANNED USER BLOCK
    if (user.banned === true) {
      req.session.destroy();
      return res.send("Your account has been banned.");
    }

    // 🚫 DELETED USER BLOCK
    if (user.deleted === true) {
      req.session.destroy();
      return res.redirect("/login");
    }

    next();

  } catch (err) {
    return res.redirect("/login");
  }
};

/* ================= UPLOAD ================= */
const storage = multer.diskStorage({
  destination: "uploads",
  filename: (_, file, cb) =>
    cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });

/* ================= BASE PAGE ================= */
const basePage = (title, body, nav = false) => `
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body{margin:0;font-family:Arial;background:linear-gradient(135deg,#ff4fa3,#4facfe);color:white}
.center{min-height:100vh;display:flex;justify-content:center;align-items:center;padding-bottom:${nav?"90px":"0"}}
.card{background:white;color:#333;width:380px;padding:25px;border-radius:25px;text-align:center}
input,select{width:100%;height:50px;margin-bottom:15px;border-radius:25px;border:1px solid #ddd;padding:0 15px}
.btn{width:100%;height:50px;border:none;border-radius:25px;background:#ff4fa3;color:white;font-weight:bold;margin-bottom:10px}
.btn.alt{background:white;color:#ff4fa3;border:2px solid #ff4fa3}
.avatar{width:100px;height:100px;border-radius:50%;object-fit:cover;border:3px solid #ff4fa3}
.bottom{position:fixed;bottom:0;width:100%;display:flex;justify-content:space-around;background:rgba(255,255,255,.25);padding:12px 0}
.nav{width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;font-size:24px;color:white;text-decoration:none}
</style>
</head>
<body>
${body}
${nav ? `
<div class="bottom">
<a class="nav" href="/profile">👤</a>
<a class="nav" href="/discover">❤️</a>
<a class="nav" href="/messages">💬</a>
<a class="nav" href="/notifications">🔔</a>
<a class="nav" href="/menu">☰</a>
</div>` : ""}
</body>
</html>
`;

/* ================= AUTH ================= */
app.get("/", (req,res)=>{
  if(req.session.userId) return res.redirect("/discover");
  res.send(basePage("Welcome",`
  <div class="center"><div class="card">
  <h1>Liwz 💖</h1>
  <a href="/signup"><button class="btn">Sign Up</button></a>
  <a href="/login"><button class="btn alt">Login</button></a>
  </div></div>`));
});

app.get("/signup",(_,res)=>{
  res.send(basePage("Signup",`
  <div class="center"><form class="card" method="POST">
  <input name="email" placeholder="Email" required>
  <input type="password" name="password" placeholder="Password" required>
  <button class="btn">Sign Up</button>
  </form></div>`));
});

app.post("/signup", async (req,res)=>{
  if(await User.findOne({email:req.body.email})) return res.send("Email exists");
  const user = await new User({
    email:req.body.email,
    password:await bcrypt.hash(req.body.password,10),
    likes:[],
    followers:[],
    following:[],
    matches:[],
    notifications:[]
  }).save();
  req.session.userId=user._id;
  res.redirect("/setup-profile");
});

app.get("/login",(_,res)=>{
  res.send(basePage("Login",`
  <div class="center"><form class="card" method="POST">
  <input name="email" placeholder="Email" required>
  <input type="password" name="password" placeholder="Password" required>
  <button class="btn">Login</button>
  </form></div>`));
});

app.post("/login",async(req,res)=>{
  const u=await User.findOne({email:req.body.email});
  if(!u || !(await bcrypt.compare(req.body.password,u.password)))
    return res.send("Invalid login");
  req.session.userId=u._id;
  res.redirect("/discover");
});

/* ================= SETUP ================= */
app.get("/setup-profile",requireLogin,(_,res)=>{
  res.send(basePage("Setup",`
  <div class="center"><form class="card" method="POST">
  <input name="name" placeholder="Name" required>
  <input type="date" name="dob" required>
  <select name="gender" required>
    <option value="">Gender</option>
    <option>male</option>
    <option>female</option>
    <option>other</option>
  </select>
  <button class="btn">Continue</button>
  </form></div>`));
});

app.post("/setup-profile",requireLogin,async(req,res)=>{
  const u=await User.findById(req.session.userId);
  Object.assign(u,req.body);
  await u.save();
  res.redirect("/interests");
});

app.get("/interests",requireLogin,(_,res)=>{
  res.send(basePage("Interests",`
  <div class="center"><form class="card" method="POST">
  <label><input type="radio" name="interestedIn" value="male" required> Men</label><br><br>
  <label><input type="radio" name="interestedIn" value="female"> Women</label><br><br>
  <label><input type="radio" name="interestedIn" value="both"> Both</label><br><br>
  <button class="btn">Continue</button>
  </form></div>`));
});

app.post("/interests",requireLogin,async(req,res)=>{
  const u=await User.findById(req.session.userId);
  u.interestedIn=req.body.interestedIn;
  await u.save();
  res.redirect("/upload-photo");
});

app.get("/upload-photo",requireLogin,(_,res)=>{
  res.send(basePage("Photo",`
  <div class="center"><form class="card" method="POST" enctype="multipart/form-data">
  <input type="file" name="photo" required>
  <button class="btn">Finish</button>
  </form></div>`));
});

app.post("/upload-photo",requireLogin,upload.single("photo"),async(req,res)=>{
  const u=await User.findById(req.session.userId);
  u.photo="/uploads/"+req.file.filename;
  await u.save();
  res.redirect("/discover");
});

/* ================= DISCOVER ================= */
app.get("/discover", requireLogin, async (req, res) => {

  const me = await User.findById(req.session.userId);
  me.likes = me.likes || [];

  const users = await User.find({
    _id: { $ne: me._id },
    photo: { $exists: true }
  });

  const availableUsers = users.filter(u => !me.likes.includes(u._id));

  if (availableUsers.length === 0) {
    return res.send(basePage(
      "Discover",
      "<div style='text-align:center;margin-top:80px'>No more users</div>",
      true
    ));
  }

  res.send(basePage("Discover", `

<style>
/* ================= STYLES ================= */
body{
  margin:0;
  font-family:Arial;
  background:linear-gradient(135deg,#ff4fa3,#4f7bff);
  overflow:hidden;
}

.discover-wrapper{
  height:100vh;
  display:flex;
  align-items:flex-start;
  justify-content:center;
  padding-top:60px;
  position:relative;
}

.card{
  width:92%;
  max-width:400px;
  height:560px;
  border-radius:25px;
  position:absolute;
  overflow:hidden;
  box-shadow:0 25px 60px rgba(0,0,0,.4);
  transition:0.3s ease;
  background:#000;
}

.card img{
  width:100%;
  height:100%;
  object-fit:cover;
}

.card-info{
  position:absolute;
  bottom:0;
  width:100%;
  padding:25px;
  color:white;
  background:linear-gradient(transparent,rgba(0,0,0,.9));
}

.actions{
  position:absolute;
  bottom:40px;
  width:100%;
  display:flex;
  justify-content:center;
  gap:50px;
}

.circle-btn{
  width:75px;
  height:75px;
  border-radius:50%;
  border:none;
  font-size:28px;
  cursor:pointer;
  transition:0.2s;
  background:white;
}

.pass{ color:#ff4fa3; }
.like{ color:#4f7bff; }

.circle-btn:hover{
  transform:scale(1.1);
}

.match-popup{
  position:fixed;
  inset:0;
  background:rgba(0,0,0,.95);
  display:none;
  align-items:center;
  justify-content:center;
  flex-direction:column;
  text-align:center;
  color:white;
  z-index:9999;
}

.match-popup img{
  width:130px;
  height:130px;
  border-radius:50%;
  object-fit:cover;
  margin:20px 0;
  border:4px solid #ff4fa3;
}

.match-popup button{
  margin-top:15px;
  padding:12px 30px;
  border:none;
  border-radius:30px;
  background:linear-gradient(90deg,#ff4fa3,#4f7bff);
  color:white;
  cursor:pointer;
}
</style>

<div class="discover-wrapper" id="discoverWrapper"></div>

<div class="actions">
  <button class="circle-btn pass" onclick="forcePass()">✕</button>
  <button class="circle-btn like" onclick="forceLike()">❤</button>
</div>

<div class="match-popup" id="matchPopup">
  <h1>🎉 It's a Match!</h1>
  <img id="matchPhoto">
  <h2 id="matchName"></h2>
  <button onclick="goToChat()">Start Chat</button>
  <button onclick="closeMatch()">Keep Swiping</button>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
const users = ${JSON.stringify(availableUsers)};
const meId = "${me._id}";
let currentIndex = 0;
let startX = 0;

const wrapper = document.getElementById("discoverWrapper");

// Register user for notifications
socket.emit("register", meId);

socket.on("liked", (data) => {
  console.log("Someone liked you:", data.fromName);
  // Optional: show toast or small alert
});

socket.on("match", (user) => {
  showMatch(user);
});

function renderCards(){
  wrapper.innerHTML = "";

  if(currentIndex >= users.length){
    wrapper.innerHTML = "<h2 style='color:white'>No more users</h2>";
    return;
  }

  const user = users[currentIndex];

  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = \`
    <img src="\${user.photo}">
    <div class="card-info">
      <h2>\${user.name}</h2>
    </div>
  \`;

  wrapper.appendChild(card);

  // Swipe logic
  card.addEventListener("touchstart",e=>{
    startX = e.touches[0].clientX;
  });

  card.addEventListener("touchmove",e=>{
    const moveX = e.touches[0].clientX - startX;
    card.style.transform =
      "translateX("+moveX+"px) rotate("+(moveX/15)+"deg)";
  });

  card.addEventListener("touchend",e=>{
    const moveX = e.changedTouches[0].clientX - startX;

    if(moveX > 120){
      likeAction(user);
    }
    else if(moveX < -120){
      nextCard();
    }
    else{
      card.style.transform = "";
    }
  });
}

function nextCard(){
  currentIndex++;
  renderCards();
}

function forcePass(){
  nextCard();
}

function forceLike(){
  if(currentIndex >= users.length) return;
  likeAction(users[currentIndex]);
}

function likeAction(user){
  fetch("/like/" + user._id, { method:"POST" })
  .then(res => res.json())
  .then(data => {
    if(data.match){
      showMatch(user);
    }
    nextCard();
  });
}

function showMatch(user){
  document.getElementById("matchPopup").style.display="flex";
  document.getElementById("matchPhoto").src=user.photo;
  document.getElementById("matchName").innerText=user.name;
}

function goToChat(){
  const matchedUser = users[currentIndex-1];
  if(matchedUser) window.location="/chat/"+matchedUser._id;
}

function closeMatch(){
  document.getElementById("matchPopup").style.display="none";
}

renderCards();
</script>

`, true));
});

/* ================= LIKE ROUTE ================= */
app.post("/like/:id", requireLogin, async (req, res) => {

  const me = await User.findById(req.session.userId);
  const likedUser = await User.findById(req.params.id);

  if (!likedUser) return res.json({ match: false });

  me.likes = me.likes || [];
  likedUser.likes = likedUser.likes || [];
  me.matches = me.matches || [];
  likedUser.matches = likedUser.matches || [];
  me.chatUsers = me.chatUsers || [];
  likedUser.chatUsers = likedUser.chatUsers || [];
  likedUser.notifications = likedUser.notifications || [];

  // Prevent duplicate likes
  if (!me.likes.some(id => id.toString() === likedUser._id.toString())) {
    me.likes.push(likedUser._id);
    await me.save();
  }

  // 🔔 Add LIKE notification for the liked user
  likedUser.notifications.push({
    type: "like",
    text: `${me.name} liked you!`,
    link: "/discover",
    date: new Date(),
    read: false
  });
  await likedUser.save();

  // 🔔 LIVE LIKE NOTIFICATION
  const targetSocketId = onlineUsers.get(likedUser._id.toString());
  if (targetSocketId) {
    io.to(targetSocketId).emit("liked", {
      fromId: me._id,
      fromName: me.name
    });
  }

  // 🔥 CHECK FOR MUTUAL MATCH
  const isMatch = likedUser.likes.some(id => id.toString() === me._id.toString());

  if (isMatch) {
    // Add each other to matches array (so message dashboard shows them)
    if (!me.matches.some(id => id.toString() === likedUser._id.toString())) {
      me.matches.push(likedUser._id);
    }
    if (!likedUser.matches.some(id => id.toString() === me._id.toString())) {
      likedUser.matches.push(me._id);
    }

    // Also add to chat users for dashboard
    if (!me.chatUsers.some(id => id.toString() === likedUser._id.toString())) {
      me.chatUsers.push(likedUser._id);
    }
    if (!likedUser.chatUsers.some(id => id.toString() === me._id.toString())) {
      likedUser.chatUsers.push(me._id);
    }

    await me.save();
    await likedUser.save();

    // Emit match to both users
    const mySocketId = onlineUsers.get(me._id.toString());

    if (mySocketId) {
      io.to(mySocketId).emit("match", {
        userId: likedUser._id,
        name: likedUser.name,
        photo: likedUser.photo
      });
    }

    if (targetSocketId) {
      io.to(targetSocketId).emit("match", {
        userId: me._id,
        name: me.name,
        photo: me.photo
      });
    }

    return res.json({ match: true });
  }

  res.json({ match: false });
});

/* ================= MESSAGES DASHBOARD ================= */
app.get("/messages", requireLogin, async (req, res) => {
  const me = await User.findById(req.session.userId);

  // Get existing conversations
  const convos = await Conversation.find({
    participants: req.session.userId
  })
    .populate("participants")
    .populate("lastMessage")
    .sort({ updatedAt: -1 });

  // Include matched users that don't have a conversation yet
  const matchedUsersWithoutConvo = [];
  if (me.chatUsers && me.chatUsers.length > 0) {
    for (let uId of me.chatUsers) {
      const hasConvo = convos.some(c =>
        c.participants.some(p => p._id.toString() === uId.toString())
      );
      if (!hasConvo) {
        const u = await User.findById(uId);
        if (u) matchedUsersWithoutConvo.push(u);
      }
    }
  }

  res.send(
    basePage(
      "Messages",
      `<div style="padding:20px">
  <h2 style="color:white;margin-bottom:15px">Chats</h2>

  ${
    convos.length === 0 && matchedUsersWithoutConvo.length === 0
      ? `<p style="color:white">No conversations yet</p>`
      : ""
  }

  ${
    convos
      .map(c => {
        const other = c.participants.find(
          p => p._id.toString() !== req.session.userId.toString()
        );
        if (!other) return "";

        const lastText = c.lastMessage
          ? c.lastMessage.text.includes("<img")
            ? "📷 Image"
            : c.lastMessage.text
          : "No messages yet";

        return `<a href="/chat/${other._id}" style="
  display:flex;
  align-items:center;
  background:white;
  color:#333;
  padding:15px;
  border-radius:22px;
  margin-bottom:12px;
  text-decoration:none;
">
  <img
    src="${other.photo || "/default.png"}"
    style="
      width:55px;
      height:55px;
      border-radius:50%;
      object-fit:cover;
      margin-right:15px;
    "
  >

  <div style="flex:1">
    <strong>${other.name}</strong>
    <div style="font-size:13px;color:#777;margin-top:4px;">
      ${lastText}
    </div>
  </div>
</a>`;
      })
      .join("")
  }

  ${
    matchedUsersWithoutConvo
      .map(u => {
        return `<a href="/chat/${u._id}" style="
  display:flex;
  align-items:center;
  background:white;
  color:#333;
  padding:15px;
  border-radius:22px;
  margin-bottom:12px;
  text-decoration:none;
">
  <img
    src="${u.photo || "/default.png"}"
    style="
      width:55px;
      height:55px;
      border-radius:50%;
      object-fit:cover;
      margin-right:15px;
    "
  >

  <div style="flex:1">
    <strong>${u.name}</strong>
    <div style="font-size:13px;color:#777;margin-top:4px;">
      No messages yet
    </div>
  </div>
</a>`;
      })
      .join("")
  }

</div>`,
      true
    )
  );
});

/* ================= CHAT ================= */
app.get("/chat/:id", requireLogin, async (req, res) => {
  const me = req.session.userId.toString();
  const otherId = req.params.id;

  let convo = await Conversation.findOne({
    participants: { $all: [me, otherId] }
  });

  if (!convo) {
    convo = await Conversation.create({
      participants: [me, otherId]
    });
  }

  const msgs = await Message.find({ conversation: convo._id })
    .populate("sender")
    .sort({ createdAt: 1 });

  const otherUser = await User.findById(otherId);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chat</title>
<script src="/socket.io/socket.io.js"></script>

<style>
body{margin:0;font-family:Arial;background:white}
.header{padding:10px;background:#ff4fa3;color:white;display:flex;justify-content:space-between}
.header-left{display:flex;align-items:center;gap:10px;cursor:pointer}
.header img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.status{font-size:12px}
.online{color:#00ff88}
.offline{color:#ffdede}

.chat{padding:15px;height:calc(100vh - 170px);overflow-y:auto}

.msg{
  max-width:75%;
  margin-bottom:8px;
  padding:10px 14px;
  border-radius:18px;
  word-wrap:break-word;
  position:relative;
}

.waveform {
  display:flex;
  align-items:flex-end;
  gap:3px;
  height:20px;
}

.wave {
  width:3px;
  background:white;
  animation:wave 0.6s infinite ease-in-out;
}

.wave:nth-child(2){animation-delay:0.1s}
.wave:nth-child(3){animation-delay:0.2s}
.wave:nth-child(4){animation-delay:0.3s}
.wave:nth-child(5){animation-delay:0.4s}

@keyframes wave{
  0%{height:4px}
  50%{height:20px}
  100%{height:4px}
}

.me{background:#ff4fa3;color:white;margin-left:auto}
.them{background:#f1f1f1;color:black}

.meta{font-size:10px;margin-top:4px;opacity:0.8}
.typing{font-size:12px;padding:5px 15px;color:#888}

.chat-img{max-width:100%;max-height:300px;border-radius:12px;display:block}

audio{max-width:100%}

form{display:flex;gap:10px;padding:10px;border-top:1px solid #ddd}

input[type="text"]{
  flex:1;
  border-radius:20px;
  border:1px solid #ddd;
  padding:10px 14px;
}

button{
  border:none;
  background:#ff4fa3;
  color:white;
  border-radius:20px;
  padding:0 18px;
}
</style>
</head>

<body>

<div class="header">
  <div class="header-left" onclick="location.href='/profile/${otherUser._id}'">
    <img src="${otherUser.photo || "/default.png"}">
    <div>
      <div>${otherUser.name}</div>
      <div class="status ${otherUser.online ? "online" : "offline"}" id="status">
        ${otherUser.online ? "Online" : "Offline"}
      </div>
    </div>
  </div>
</div>

<div class="chat" id="chat">
  ${msgs.map(m => `
    <div class="msg ${m.sender._id.toString() === me ? "me" : "them"}" data-id="${m._id}">
      ${m.text}
      ${
        m.sender._id.toString() === me
          ? `<div class="meta">${m.seen ? "✓✓ Seen" : "✓ Delivered"}</div>`
          : ""
      }
    </div>
  `).join("")}
</div>

<div id="typing" class="typing"></div>
<div id="imagePreviewContainer" style="display:none;padding:10px;">
  <img id="imagePreview" style="max-width:100%;border-radius:12px;">
  <button type="button" onclick="cancelImage()" style="margin-top:5px;background:red;">Cancel</button>
</div>

<form onsubmit="sendMessage(event)">
  <input type="file" id="img" accept="image/*" hidden>
  <button type="button" onclick="img.click()">📷</button>
  <button type="button" id="recordBtn">🎤</button>
  <input type="text" id="msg" placeholder="Type a message…" oninput="typingEvent()">
  <button type="submit">Send</button>
</form>

<script>
const socket = io();
const myId = "${me}";
const otherId = "${otherId}";
const roomId = "${convo._id}";
const chat = document.getElementById("chat");
const img = document.getElementById("img");
const typingDiv = document.getElementById("typing");
const statusDiv = document.getElementById("status");

/* CONNECT */
socket.on("connect", () => {
  socket.emit("joinRoom", { roomId, userId: myId });
  socket.emit("online", myId);
});

/* RECEIVE MESSAGE */
socket.on("newMessage", msg => {
  addMessage(msg);
  if(msg.sender !== myId){
    socket.emit("seen", { roomId, userId: myId });
  }
});

/* SEEN */
socket.on("seen", () => {
  document.querySelectorAll(".me .meta")
    .forEach(m => m.innerText="✓✓ Seen");
});

/* ONLINE */
socket.on("userOnline", id=>{
  if(id===otherId){statusDiv.innerText="Online";statusDiv.className="status online";}
});
socket.on("userOffline", id=>{
  if(id===otherId){statusDiv.innerText="Offline";statusDiv.className="status offline";}
});

/* TYPING */
let typingTimeout;
function typingEvent(){
  socket.emit("typing",{roomId,userId:myId});
  clearTimeout(typingTimeout);
  typingTimeout=setTimeout(()=>{
    socket.emit("stopTyping",{roomId,userId:myId});
  },1000);
}
socket.on("typing",({userId})=>{
  if(userId!==myId) typingDiv.innerText="Typing...";
});
socket.on("stopTyping",()=>typingDiv.innerText="");

/* ADD MESSAGE FUNCTION */
function addMessage(msg){
  const div=document.createElement("div");
  div.className="msg "+(msg.sender===myId?"me":"them");
  div.dataset.id=msg._id;
  div.innerHTML=msg.text;

  if(msg.sender===myId){
    const meta=document.createElement("div");
    meta.className="meta";
    meta.innerText="✓ Delivered";
    div.appendChild(meta);
  }

  addLongPress(div,msg);
  chat.appendChild(div);
  chat.scrollTop=chat.scrollHeight;
}

/* LONG PRESS (EDIT / DELETE / COPY) */
function addLongPress(div,msg){
  let timer;

  div.addEventListener("touchstart",()=>{
    timer=setTimeout(()=>{
      if(msg.sender===myId){
        const action=prompt("Type: edit / delete / copy");
        if(action==="edit"){
          const newText=prompt("Edit message:",div.innerText);
          if(newText){
            socket.emit("editMessage",{messageId:msg._id,newText,roomId});
            div.innerHTML=newText+"<div class='meta'>(edited)</div>";
          }
        }
        if(action==="delete"){
          socket.emit("deleteMessage",{messageId:msg._id,roomId});
          div.remove();
        }
      }else{
        navigator.clipboard.writeText(div.innerText);
        alert("Copied");
      }
    },600);
  });

  div.addEventListener("touchend",()=>clearTimeout(timer));
}

/* IMAGE + TEXT SEND */
async function sendMessage(e) {
  e.preventDefault();

  const input = document.getElementById("msg");

  /* ================= IMAGE SEND ================= */
  if (img.files.length > 0) {

    const fd = new FormData();
    fd.append("image", img.files[0]);

    const res = await fetch("/chat-upload", {
      method: "POST",
      body: fd
    });

    const data = await res.json();

    socket.emit("sendMessage", {
      roomId,
      sender: myId,
      receiver: otherId,
      text: '<img src="' + data.url + '" class="chat-img">'
    });

    cancelImage();
    input.value = "";
    return;
  }

  /* ================= TEXT SEND ================= */
  if (!input.value.trim()) return;

  socket.emit("sendMessage", {
    roomId,
    sender: myId,
    receiver: otherId,
    text: input.value
  });

  input.value = "";
}

/* VOICE RECORD */
let mediaRecorder;
let audioChunks=[];
const recordBtn=document.getElementById("recordBtn");

recordBtn.addEventListener("click",async()=>{
  if(!mediaRecorder){

    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    mediaRecorder=new MediaRecorder(stream);

    audioChunks=[];

    mediaRecorder.ondataavailable=e=>audioChunks.push(e.data);

    mediaRecorder.onstop=async()=>{
      const blob=new Blob(audioChunks,{type:"audio/webm"});
      const url=URL.createObjectURL(blob);

      socket.emit("sendMessage",{
        roomId,
        sender:myId,
        receiver:otherId,
        text:\`
          <audio controls src="\${url}"></audio>
        \`
      });

      recordBtn.innerHTML="🎤";
      mediaRecorder=null;
    };

    mediaRecorder.start();

    // Show waveform animation
    recordBtn.innerHTML=\`
      <div class="waveform">
        <div class="wave"></div>
        <div class="wave"></div>
        <div class="wave"></div>
        <div class="wave"></div>
        <div class="wave"></div>
      </div>
    \`;

  }else{
    mediaRecorder.stop();
  }
});

</script>

</body>
</html>
`);
});

  /* ================= PROFILE ROUTES ================= */

// OWN PROFILE
app.get("/profile", requireLogin, async (req, res) => {
  return renderProfile(req, res, req.session.userId);
});

// VIEW OTHER USER PROFILE
app.get("/profile/:id", requireLogin, async (req, res) => {
  return renderProfile(req, res, req.params.id);
});

// EDIT PROFILE
app.post("/profile/edit", requireLogin, async (req, res) => {
  const u = await User.findById(req.session.userId);
  u.name = req.body.name;
  u.gender = req.body.gender;
  u.interestedIn = req.body.interestedIn;
  await u.save();
  res.redirect("/profile");
});

// UPLOAD PROFILE PHOTO
app.post(
  "/profile/photo",
  requireLogin,
  upload.single("photo"),
  async (req, res) => {
    const u = await User.findById(req.session.userId);
    u.photo = "/uploads/" + req.file.filename;
    await u.save();
    res.redirect("/profile");
  }
);

// UPLOAD GALLERY PHOTO
app.post(
  "/upload-gallery",
  requireLogin,
  upload.single("photo"),
  async (req, res) => {
    const u = await User.findById(req.session.userId);
    u.photos.push({
      url: "/uploads/" + req.file.filename,
      likes: [],
      comments: []
    });
    await u.save();
    res.redirect("/profile");
  }
);

// CHAT IMAGE UPLOAD
app.post(
  "/chat-upload",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    res.json({
      url: "/uploads/" + req.file.filename
    });
  }
);

/* ================= PROFILE RENDERER ================= */

async function renderProfile(req, res, profileId) {
  const viewerId = req.session.userId.toString();
  const isOwner = viewerId === profileId.toString();

  const u = await User.findById(profileId)
    .populate("followers")
    .populate("following")
    .populate("matches");

  if (!u) return res.send("User not found");

  res.send(
    basePage(
      "Profile",
      `
<div class="center">
  <div class="card" style="width:100%;max-width:420px">

    ${
      isOwner
        ? `
    <form method="POST" enctype="multipart/form-data" action="/profile/photo">
      <label style="cursor:pointer">
        <img src="${u.photo || "/default.png"}" class="avatar">
      </label>
      <input type="file" name="photo" hidden onchange="this.form.submit()">
    </form>
        `
        : `
    <img src="${u.photo || "/default.png"}" class="avatar">
        `
    }

    <h2>${u.name}</h2>
    <p>${u.gender || ""}</p>

    <div style="display:flex;justify-content:space-around;margin:15px 0">
      <a href="/profile/${u._id}/followers">
        <b>${u.followers.length}</b><br>Followers
      </a>
      <a href="/profile/${u._id}/following">
        <b>${u.following.length}</b><br>Following
      </a>
      ${isOwner ? `<div><b>${u.matches.length}</b><br>Matches</div>` : ""}
    </div>

    ${
      isOwner
        ? `
    <form method="POST" action="/profile/edit">
      <input name="name" value="${u.name}" placeholder="Name">
      <input name="gender" value="${u.gender || ""}" placeholder="Gender">
      <input name="interestedIn" value="${u.interestedIn || ""}" placeholder="Interested in">
      <button class="btn">Save Profile</button>
    </form>

    <form method="POST" enctype="multipart/form-data" action="/upload-gallery">
      <input type="file" name="photo" required>
      <button class="btn">Upload Photo</button>
    </form>
        `
        : `
    <a href="/report/${u._id}">
      <button class="btn alt">Report User</button>
    </a>
        `
    }

    <h3 style="margin-top:20px">Photos</h3>

    <div>
      ${
        u.photos.length === 0
          ? "<p>No photos yet</p>"
          : u.photos
              .map(
                p => `
      <div style="margin-bottom:15px">
        <img src="${p.url}" style="width:100%;border-radius:12px">
        <form method="POST" action="/photo/like/${u._id}/${p._id}">
          <button class="btn alt">❤️ ${p.likes.length}</button>
        </form>
      </div>
                `
              )
              .join("")
      }
    </div>

  </div>
</div>
`,
      true
    )
  );
}

// LIKE PHOTO
app.post("/photo/like/:userId/:photoId", requireLogin, async (req, res) => {
  const likerId = req.session.userId;
  const user = await User.findById(req.params.userId);

  const photo = user.photos.id(req.params.photoId);
  if (!photo.likes.includes(likerId)) {
    photo.likes.push(likerId);
    await user.save();
  }

  res.redirect("/profile/" + req.params.userId);
});

// FOLLOWERS
app.get("/profile/:id/followers", requireLogin, async (req, res) => {
  const u = await User.findById(req.params.id).populate("followers");

  res.send(
    basePage(
      "Followers",
      `
<div class="center">
  <div style="width:100%;max-width:420px">
    ${
      u.followers.length === 0
        ? "<p>No followers yet</p>"
        : u.followers.map(
            f => `
      <a href="/profile/${f._id}" style="text-decoration:none">
        <div class="card" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:10px">
          <img src="${f.photo || "/default.png"}" class="avatar">
          <h4 style="margin:0">${f.name}</h4>
        </div>
      </a>
            `
          ).join("")
    }
  </div>
</div>
`,
      true
    )
  );
});

// FOLLOWING
app.get("/profile/:id/following", requireLogin, async (req, res) => {
  const u = await User.findById(req.params.id).populate("following");

   res.send(
    basePage(
      "Following",
      `
<div class="center">
  <div style="width:100%;max-width:420px">
    ${
      u.following.length === 0
        ? "<p>Not following anyone yet</p>"
         : u.following.map(
           f => `
      <a href="/profile/${f._id}" style="text-decoration:none">
        <div class="card" style="display:flex;align-items:center;gap:12px;padding:12px;margin-bottom:10px">
          <img src="${f.photo || "/default.png"}" class="avatar">
          <h4 style="margin:0">${f.name}</h4>
        </div>
      </a>
            `
          ).join("")
    }
  </div>
</div>
`,
      true
    )
  );
});

/* ================= NOTIFICATIONS ================= */
app.get("/notifications", requireLogin, async (req, res) => {
  const u = await User.findById(req.session.userId);

  u.notifications.forEach(n => (n.read = true));
  await u.save();

  res.send(basePage("Notifications", `

<style>
body{
  background:linear-gradient(135deg,#ff4fa3,#4f7bff);
  margin:0;
  font-family:Arial;
}
.notif-wrapper{
  padding:20px;
}
.notif-card{
  background:white;
  border-radius:18px;
  padding:15px;
  margin-bottom:15px;
  box-shadow:0 8px 25px rgba(0,0,0,.15);
  transition:.2s;
}
.notif-card:hover{
  transform:scale(1.02);
}
.notif-card small{
  opacity:.6;
}
</style>

<div class="notif-wrapper">

${
  u.notifications.length === 0
    ? "<h3 style='text-align:center;color:white'>No notifications yet</h3>"
    : u.notifications.map(n => `
      <a href="${n.link || "#"}" style="text-decoration:none;color:black">
        <div class="notif-card">
          <p style="margin:0;font-weight:600">${n.text}</p>
          <small>${new Date(n.date).toLocaleString()}</small>
        </div>
      </a>
    `).join("")
}

</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const socket = io();
  socket.emit("register", "${u._id}");

  socket.on("newNotification", (notif) => {
    alert(notif.text); // optional popup
    const wrapperEl = document.querySelector(".notif-wrapper");
    if(wrapperEl){
      const notifEl = document.createElement("a");
      notifEl.href = notif.link || "#";
      notifEl.style.textDecoration = "none";
      notifEl.style.color = "black";
      notifEl.innerHTML = \`
        <div class="notif-card">
          <p style="margin:0;font-weight:600">\${notif.text}</p>
          <small>\${new Date(notif.date).toLocaleString()}</small>
        </div>
      \`;
      wrapperEl.prepend(notifEl);
    }
  });
</script>

`, true));
});

/* =====================================================
   FULL MENU + LEGAL + REPORT SYSTEM + ADMIN REPORT VIEW
===================================================== */


/* ================= MENU DASHBOARD ================= */
app.get("/menu", requireLogin, (req, res) => {
  res.send(basePage("Menu", `

<style>
body{
  margin:0;
  font-family:Arial;
  background:linear-gradient(135deg,#ff4fa3,#4f7bff);
}
.wrapper{
  padding:25px;
}
.card{
  background:white;
  border-radius:20px;
  padding:20px;
  margin-bottom:15px;
  box-shadow:0 10px 30px rgba(0,0,0,.2);
  text-align:center;
}
button{
  width:100%;
  padding:14px;
  border:none;
  border-radius:30px;
  font-size:16px;
  cursor:pointer;
  margin-top:10px;
  background:linear-gradient(90deg,#ff4fa3,#4f7bff);
  color:white;
}
.logout{
  background:#111;
}
h2{
  text-align:center;
  color:white;
}
</style>

<div class="wrapper">
  <h2>Settings & Information</h2>

  <div class="card">
    <a href="/privacy"><button>Privacy Policy</button></a>
  </div>

  <div class="card">
    <a href="/terms"><button>Terms of Service</button></a>
  </div>

  <div class="card">
    <p><strong>Contact Support</strong></p>
    <p>wsdmpresh@gmail.com</p>
  </div>

  <div class="card">
    <a href="/logout"><button class="logout">Logout</button></a>
  </div>
</div>

`, true));
});


/* ================= PRIVACY ================= */
app.get("/privacy", requireLogin, (req, res) => {
  res.send(basePage("Privacy Policy", `
  <div style="padding:20px;max-width:800px;margin:auto;line-height:1.6">
  <h1>Privacy Policy</h1>
  <p>We respect your privacy. We collect user data such as name, profile photo, messages, likes, matches and interactions solely to operate the platform.</p>
  <p>We do not sell user data. Security measures are implemented but no system is 100% secure.</p>
  <p>Users must be 18+. By using this platform you consent to data usage required for functionality.</p>
  <p>Contact: wsdmpresh@gmail.com</p>
  </div>
  `, true));
});


/* ================= TERMS ================= */
app.get("/terms", requireLogin, (req, res) => {
  res.send(basePage("Terms", `
  <div style="padding:20px;max-width:800px;margin:auto;line-height:1.6">
  <h1>Terms of Service</h1>
  <p>You must be 18 years or older to use this platform.</p>
  <p>No harassment, abuse, fraud, impersonation, illegal content, or explicit violations allowed.</p>
  <p>We reserve the right to suspend accounts that violate our rules.</p>
  <p>We are not responsible for user behavior or interactions.</p>
  <p>Contact: wsdmpresh@gmail.com</p>
  </div>
  `, true));
});


/* ================= LOGOUT ================= */
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});


/* =====================================================
   REPORT USER SYSTEM
===================================================== */


/* REPORT PAGE */
app.get("/report/:id", requireLogin, async (req, res) => {
  const reportedUser = await User.findById(req.params.id);

  if (!reportedUser) return res.redirect("/discover");

  res.send(basePage("Report User", `

  <div style="padding:20px;max-width:500px;margin:auto">
    <h2>Report ${reportedUser.name}</h2>

    <form method="POST" action="/report/${reportedUser._id}">
      <select name="reason" required style="width:100%;padding:12px;border-radius:10px;margin-bottom:15px">
        <option value="">Select Reason</option>
        <option>Fake Profile</option>
        <option>Spam</option>
        <option>Harassment</option>
        <option>Inappropriate Content</option>
        <option>Scam / Fraud</option>
        <option>Other</option>
      </select>

      <button style="width:100%;padding:14px;border:none;border-radius:25px;background:red;color:white">
        Submit Report
      </button>
    </form>
  </div>

  `, true));
});


/* HANDLE REPORT */
app.post("/report/:id", requireLogin, async (req, res) => {

  const reportedUser = await User.findById(req.params.id);
  const admin = await User.findOne({ role: "admin" });

  if (!reportedUser || !admin) return res.redirect("/discover");

  admin.reports.push({
    reportedUser: reportedUser._id,
    reportedBy: req.session.userId,
    reason: req.body.reason,
    date: new Date()
  });

  await admin.save();

  res.send(basePage("Reported", `
    <div style="text-align:center;margin-top:50px">
      <h2>Report Submitted</h2>
      <p>Our team will review this user.</p>
      <a href="/discover"><button style="padding:12px 25px;border:none;border-radius:25px;background:#4f7bff;color:white">Back</button></a>
    </div>
  `, true));
});

/* ================= SERVER ================= */
server.listen(process.env.PORT || 5001, () => {
  console.log("🔥 Liwz running on port " + (process.env.PORT || 5001));
});

