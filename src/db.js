const { Sequelize, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');
const path = require('path');

// Initialize Sequelize with SQLite for local development
const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(__dirname, '../database.sqlite'),
    logging: false // Disable verbose SQL query logging
});

// Define User Model
const User = sequelize.define('User', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    username: { type: DataTypes.STRING, unique: true, allowNull: false },
    password_hash: { type: DataTypes.STRING, allowNull: false }
});

// Define Device Model
const Device = sequelize.define('Device', {
    device_id: { type: DataTypes.STRING, primaryKey: true },
    status: { type: DataTypes.ENUM('online', 'offline'), defaultValue: 'offline' },
    last_seen: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

// Define AuditLog Model
const AuditLog = sequelize.define('AuditLog', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    admin_username: { type: DataTypes.STRING, allowNull: false },
    target_device_id: { type: DataTypes.STRING, allowNull: true },
    action_type: { type: DataTypes.STRING, allowNull: false },
    timestamp: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
});

// Initialization Function
async function initDB() {
    try {
        await sequelize.authenticate();
        console.log('Database Connection established successfully.');

        // Sync all models (creates tables if they don't exist)
        await sequelize.sync();

        // Inject default admin if it doesn't exist
        const adminCount = await User.count();
        if (adminCount === 0) {
            console.log('No users found. Creating default admin...');
            const hashedPassword = await bcrypt.hash('password123', 10);
            await User.create({
                username: 'school_admin',
                password_hash: hashedPassword
            });
            console.log('Default admin created: school_admin / password123');
        }
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
}

module.exports = {
    sequelize,
    User,
    Device,
    AuditLog,
    initDB
};
