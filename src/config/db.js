const mysql = require('mysql2/promise');
require('dotenv').config();

// Configuración de la conexión a la base de datos
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'estacionamiento',
    // Seguridad: evitar ejecución de múltiples sentencias por query
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // DATETIME naive como string "YYYY-MM-DD HH:mm:ss" (sin reinterpretar por TZ de Node)
    dateStrings: true
});

module.exports = pool;
