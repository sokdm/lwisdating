require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");

async function resetUsers() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Mongo connected");

    const result = await User.deleteMany({
      role: { $ne: "admin" }
    });

    console.log("🔥 Deleted users:", result.deletedCount);

    process.exit();

  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

resetUsers();
