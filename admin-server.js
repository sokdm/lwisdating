module.exports = function (app, server, mongoose) {

const express = require("express");
const session = require("express-session");
const { Server } = require("socket.io");
const User = require("./models/User");

/* ================= SOCKET ================= */

let io;
if (!server.io) {
io = new Server(server, { cors: { origin: "*" } });
server.io = io;

io.on("connection", async (socket) => {
console.log("Admin Connected");

try {

if(socket.handshake?.auth?.userId){
const u = await User.findById(socket.handshake.auth.userId);

if(u){
if(u.banned){
socket.emit("banned",{ reason: u.banReason || "Account banned" });
return socket.disconnect(true);
}

if(u.banExpires && new Date() > new Date(u.banExpires)){
u.banned = false;
u.banExpires = null;
await u.save();
}
}
}

const totalUsers = await User.countDocuments({ deleted: { $ne: true } });
const onlineUsers = await User.countDocuments({ online: true, deleted: { $ne: true } });

const totalMatchesAgg = await User.aggregate([
{ $match: { deleted: { $ne: true } } },
{ $project: { count: { $size: { $ifNull: ["$matches", []] } } } },
{ $group: { _id: null, total: { $sum: "$count" } } }
]);

const totalMatches = totalMatchesAgg[0]?.total || 0;

socket.emit("adminStatsUpdate", {
totalUsers,
onlineUsers,
totalMatches
});

} catch (e) {
console.log("Socket Stats Error");
}

});

} else {
io = server.io;
}

/* ================= REALTIME BROADCAST ================= */

async function broadcastAdminStats() {
try {

const totalUsers = await User.countDocuments({ deleted: { $ne: true } });
const onlineUsers = await User.countDocuments({ online: true, deleted: { $ne: true } });

const totalMatchesAgg = await User.aggregate([
{ $match: { deleted: { $ne: true } } },
{ $project: { count: { $size: { $ifNull: ["$matches", []] } } } },
{ $group: { _id: null, total: { $sum: "$count" } } }
]);

const totalMatches = totalMatchesAgg[0]?.total || 0;

io.emit("adminStatsUpdate", {
totalUsers,
onlineUsers,
totalMatches
});

} catch (err) {
console.log("Broadcast Stats Error");
}
}

/* ================= MIDDLEWARE ================= */

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
secret: "lwiz-admin-secret",
resave: false,
saveUninitialized: false,
cookie: {
secure: false,
httpOnly: true,
maxAge: 1000 * 60 * 60 * 2
}
}));

/* ================= ADMIN AUTH ================= */

function requireAdmin(req, res, next) {
if (!req.session.admin) return res.redirect("/admin-login");
next();
}

/* ================= GLOBAL ADMIN STYLE ================= */

function adminLayout(title, content){
return `

<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<style>
body{margin:0;font-family:Arial;background:#f5f6fa;}

.sidebar{
position:fixed;width:280px;height:100vh;
background:linear-gradient(180deg,#ff4fa3,#4f7bff);
padding:30px;color:white;font-size:20px;
}

.sidebar a{
display:block;color:white;text-decoration:none;margin:22px 0;font-size:18px;
}

.content{margin-left:300px;padding:50px;}

.cards{display:flex;gap:30px;flex-wrap:wrap;}

.card{
background:white;padding:35px;border-radius:24px;
flex:1;min-width:300px;
box-shadow:0 15px 35px rgba(0,0,0,.12);
}

.btn{
padding:12px 22px;border-radius:12px;border:none;
cursor:pointer;font-weight:bold;font-size:16px;margin-top:8px;
}

.btn-danger{ background:#ff4fa3;color:white; }
.btn-blue{ background:#4f7bff;color:white; }

/* 🔥 BIGGER CHART VISIBILITY */
canvas{
background:white;
padding:30px;
border-radius:24px;
box-shadow:0 15px 35px rgba(0,0,0,.1);
width:100% !important;
height:560px !important;
max-height:560px !important;
}
</style>

<div class="sidebar">
<h1>LWIZ ADMIN</h1>
<a href="/admin-dashboard">Dashboard</a>
<a href="/admin-users">Users</a>
<a href="/admin-reports">Reports</a>
<a href="/admin-photos">Photos</a>
<a href="/admin-logout">Logout</a>
</div>

<div class="content">
<h1>${title}</h1>
${content}
</div>
`;
}

/* ================= LOGIN ================= */

app.get("/admin-login",(req,res)=>{
res.send(`
<style>
body{
font-family:Arial;
background:linear-gradient(135deg,#ff4fa3,#4f7bff);
display:flex;justify-content:center;align-items:center;
height:100vh;color:white;
}
.card{
background:white;color:black;padding:60px;
border-radius:30px;width:420px;text-align:center;
}
input{
width:100%;padding:16px;margin:16px 0;
border-radius:12px;border:1px solid #ccc;
}
button{
width:100%;padding:16px;background:#ff4fa3;
color:white;border:none;border-radius:14px;
cursor:pointer;font-size:18px;
}
</style>

<div class="card">
<h2>LWIZ ADMIN</h2>
<form method="POST">
<input name="email" placeholder="Admin Email" required/>
<input name="password" type="password" placeholder="Password" required/>
<button>Login</button>
</form>
</div>
`);
});

app.post("/admin-login",(req,res)=>{
const {email,password}=req.body;

if(
email?.trim()===process.env.ADMIN_EMAIL?.trim() &&
password?.trim()===process.env.ADMIN_PASSWORD?.trim()
){
req.session.admin=true;
return res.redirect("/admin-dashboard");
}

res.send("Invalid Credentials");
});

/* ================= DASHBOARD ================= */

app.get("/admin-dashboard",requireAdmin,async(req,res)=>{
try{

const totalUsers=await User.countDocuments({deleted:{$ne:true}});
const onlineUsers=await User.countDocuments({online:true,deleted:{$ne:true}});

const totalMatchesAgg=await User.aggregate([
{$match:{deleted:{$ne:true}}},
{$project:{count:{$size:{$ifNull:["$matches",[]]}}}},
{$group:{_id:null,total:{$sum:"$count"}}}
]);

const totalMatches=totalMatchesAgg[0]?.total||0;

res.send(adminLayout("Dashboard Overview",`

<div class="cards">

<div class="card">
<h2>Total Users</h2>
<h1>${totalUsers}</h1>
</div>

<div class="card">
<h2>Online Users</h2>
<h1>${onlineUsers}</h1>
</div>

<div class="card">
<h2>Total Matches</h2>
<h1>${totalMatches}</h1>
</div>

</div>

<br><br>

<canvas id="chart"></canvas>

<script src="/socket.io/socket.io.js"></script>

<script>
const chart = new Chart(document.getElementById('chart'),{
type:'bar',
data:{
labels:['Users','Online','Matches'],
datasets:[{
label:'LWIZ Global Stats',
data:[${totalUsers},${onlineUsers},${totalMatches}],
borderWidth:2
}]
},
options:{
responsive:true,
maintainAspectRatio:false
}
});

const socket = io();

socket.on("adminStatsUpdate", (stats) => {

document.querySelectorAll(".card h1")[0].innerText = stats.totalUsers;
document.querySelectorAll(".card h1")[1].innerText = stats.onlineUsers;
document.querySelectorAll(".card h1")[2].innerText = stats.totalMatches;

chart.data.datasets[0].data = [
stats.totalUsers,
stats.onlineUsers,
stats.totalMatches
];

chart.update();
});
</script>

`));

}catch(err){
res.send("Dashboard Error");
}
});

/* ================= USERS ================= */

app.get("/admin-users",requireAdmin,async(req,res)=>{
try{

const users=await User.find({deleted:{$ne:true}}).limit(300).lean();

res.send(adminLayout("Users",`

<div class="cards">

${users.map(u=>`
<div class="card">

<b style="font-size:20px">${u.name||"No Name"}</b><br>
${u.email||"No Email"}<br><br>

${u.banned?
`<a href="/admin-unban/${u._id}">
<button class="btn btn-blue">Unban</button>
</a>`
:
`<a href="/admin-ban/${u._id}">
<button class="btn btn-danger">Ban</button>
</a>`
}

<br>

<a href="/admin-delete-user/${u._id}">
<button class="btn btn-danger">Delete</button>
</a>

</div>
`).join("")}

</div>

`));

}catch(err){
res.redirect("/admin-dashboard");
}
});

/* DELETE USER */
app.get("/admin-delete-user/:id",requireAdmin,async(req,res)=>{
try{
const user=await User.findById(req.params.id);
if(!user) return res.redirect("/admin-users");
if(user.role==="admin") return res.redirect("/admin-users");

await User.findByIdAndDelete(req.params.id);
await broadcastAdminStats();

res.redirect("/admin-users");
}catch{
res.redirect("/admin-users");
}
});

/* BAN */
app.get("/admin-ban/:id",requireAdmin,async(req,res)=>{
try{
await User.findByIdAndUpdate(req.params.id,{
banned:true,
banReason:"Banned by admin"
});
await broadcastAdminStats();
res.redirect("/admin-users");
}catch{
res.redirect("/admin-users");
}
});

/* UNBAN */
app.get("/admin-unban/:id",requireAdmin,async(req,res)=>{
try{
await User.findByIdAndUpdate(req.params.id,{
banned:false,
banReason:null,
banExpires:null
});
await broadcastAdminStats();
res.redirect("/admin-users");
}catch{
res.redirect("/admin-users");
}
});

/* ================= REPORTS ================= */

app.get("/admin-reports",requireAdmin,async(req,res)=>{
try{

const reported=await User.find({reports:{$exists:true,$ne:[]}}).lean();

res.send(adminLayout("Reports",`

<div class="cards">

${reported.length===0?"No Reports":
reported.map(u=>`
<div class="card">

<b>${u.name||"User"}</b><br><br>

<a href="/admin-ban/${u._id}">
<button class="btn btn-danger">Ban User</button>
</a>

<br>

<a href="/admin-clear-reports/${u._id}">
<button class="btn btn-blue">Clear Reports</button>
</a>

</div>
`).join("")}

</div>

`));

}catch{
res.redirect("/admin-dashboard");
}
});

/* CLEAR REPORTS */
app.get("/admin-clear-reports/:id",requireAdmin,async(req,res)=>{
try{
await User.findByIdAndUpdate(req.params.id,{reports:[]});
await broadcastAdminStats();
res.redirect("/admin-reports");
}catch{
res.redirect("/admin-reports");
}
});

/* ================= PHOTOS ================= */

app.get("/admin-photos",requireAdmin,async(req,res)=>{
try{

const users=await User.find({"photos.0":{$exists:true}}).lean();

res.send(adminLayout("Photos",`

${users.map(u=>`

<div class="card">

<b>${u.name||"User"}</b><br><br>

${(u.photos||[]).map((p,i)=>`
<div style="margin-bottom:14px">
<img src="${p.url}" width="160" style="border-radius:14px"><br>
<a href="/admin-delete-photo/${u._id}/${i}">
<button class="btn btn-danger">Delete Photo</button>
</a>
</div>
`).join("")}

</div>

`).join("")}

`));

}catch{
res.redirect("/admin-dashboard");
}
});

/* DELETE PHOTO */
app.get("/admin-delete-photo/:uid/:index",requireAdmin,async(req,res)=>{
try{

const {uid,index}=req.params;
const user=await User.findById(uid);
if(!user) return res.redirect("/admin-photos");

user.photos.splice(index,1);
await user.save();

res.redirect("/admin-photos");

}catch{
res.redirect("/admin-photos");
}
});

/* ================= LOGOUT ================= */

app.get("/admin-logout",(req,res)=>{
req.session.destroy(()=>res.redirect("/admin-login"));
});

};
