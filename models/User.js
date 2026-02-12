const mongoose = require("mongoose");

const PhotoSchema = new mongoose.Schema({
  url: String,
  likes: [
    { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  ],
  comments: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      text: String,
      date: { type: Date, default: Date.now }
    }
  ]
});

const UserSchema = new mongoose.Schema(
  {
    email: String,
    password: String,
    name: String,
    dob: String,
    gender: String,
    interestedIn: String,
    photo: String,
    photos: [PhotoSchema],

    likes: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: []
    },

    followers: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: []
    },

    following: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: []
    },

    matches: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: []
    },

    notifications: [
      {
        text: { type: String, required: true },
        link: { type: String, default: "/" },
        read: { type: Boolean, default: false },
        date: { type: Date, default: Date.now }
      }
    ],

    /* ================= ADMIN SYSTEM ================= */

    // role system (already yours, kept)
    role: { type: String, default: "user" }, // admin or user

    // 🔥 REQUIRED FOR ADMIN BAN BUTTONS
    banned: { type: Boolean, default: false },

    // 🔥 Optional but powerful (future proof)
    verified: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false },

    reports: [
      {
        reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        reason: String,
        date: { type: Date, default: Date.now }
      }
    ],

    /* ================= PRESENCE ================= */

    online: { type: Boolean, default: false },
    lastActive: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
