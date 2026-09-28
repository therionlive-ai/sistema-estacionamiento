const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const validateLoginData = require('../middleware/validateLogin');

// Middleware para registrar intentos de inicio de sesión
const logLoginAttempt = async (id_empresa, usuario, exitoso, ip) => {
    try {
        const query = `
            INSERT INTO login_attempts
                (id_empresa, usuario_login, exitoso, ip_address, fecha_intento)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;

        await pool.query(query, [
            id_empresa,
            usuario,
            exitoso,
            ip
        ]);
    } catch (error) {
        console.error('Error al registrar intento de login:', error);
    }
};

// Verificar intentos fallidos
const checkFailedAttempts = async (id_empresa, usuario, ip) => {
    try {
        const [attempts] = await pool.query(
            `SELECT COUNT(*) AS count
             FROM login_attempts
             WHERE id_empresa = ?
               AND (usuario_login = ? OR ip_address = ?)
               AND exitoso = false
               AND fecha_intento > DATE_SUB(NOW(), INTERVAL 15 MINUTE)`,
            [id_empresa, usuario, ip]
        );

        return attempts[0].count;
    } catch (error) {
        console.error('Error al verificar intentos fallidos:', error);
        return 0;
    }
};

// Login
// La empresa se determina automáticamente por el usuario.
// No se solicita NIT ni selección manual de establecimiento.
router.post('/login', validateLoginData, async (req, res) => {
    const usuario = typeof req.body.usuario === 'string'
        ? req.body.usuario.trim()
        : req.body.usuario;

    const password = req.body.password;
    const ip = req.ip || req.connection.remoteAddress;

    try {
        // Buscar el usuario y obtener automáticamente su empresa
        const [users] = await pool.query(
            `SELECT
                u.*,
                e.nombre AS nombre_empresa,
                e.nit,
                e.direccion,
                e.telefono,
                e.email,
                e.logo_url AS logo,
                e.activa
             FROM usuarios u
             INNER JOIN empresas e
                 ON e.id_empresa = u.id_empresa
             WHERE u.usuario_login = ?
               AND u.activo = TRUE
               AND e.activa = TRUE
             LIMIT 1`,
            [usuario]
        );

        if (users.length === 0) {
            // No conocemos la empresa cuando el usuario no existe,
            // por lo que registramos el intento sin id_empresa.
            return res.status(401).json({
                success: false,
                message: 'Usuario o contraseña incorrectos'
            });
        }

        const user = users[0];
        const id_empresa = user.id_empresa;

        // Verificar intentos fallidos para este usuario/empresa
        const failedAttempts = await checkFailedAttempts(
            id_empresa,
            usuario,
            ip
        );

        if (failedAttempts >= 5) {
            await logLoginAttempt(
                id_empresa,
                usuario,
                false,
                ip
            );

            return res.status(429).json({
                success: false,
                message: 'Demasiados intentos fallidos. Por favor, intente más tarde.'
            });
        }

        // Verificar contraseña
        const validPassword = await bcrypt.compare(
            password,
            user.contraseña
        );

        if (!validPassword) {
            await logLoginAttempt(
                id_empresa,
                usuario,
                false,
                ip
            );

            return res.status(401).json({
                success: false,
                message: 'Usuario o contraseña incorrectos'
            });
        }

        // Obtener configuración del establecimiento
        const [config] = await pool.query(
            `SELECT *
             FROM configuracion_empresa
             WHERE id_empresa = ?
             LIMIT 1`,
            [id_empresa]
        );

        // Datos públicos del establecimiento
        const empresa = {
            id_empresa: user.id_empresa,
            nombre: user.nombre_empresa,
            nit: user.nit,
            direccion: user.direccion,
            telefono: user.telefono,
            email: user.email,
            logo: user.logo
        };

        // Generar token JWT
        const token = jwt.sign(
    {
        id: user.id_usuario,
        nombre: user.nombre,
        rol: user.rol,
        id_empresa: user.id_empresa
    },
    process.env.JWT_SECRET,
    {
        expiresIn: '8h'
    }
);

        // Actualizar último acceso
        await pool.query(
            `UPDATE usuarios
             SET ultimo_acceso = CURRENT_TIMESTAMP
             WHERE id_usuario = ?`,
            [user.id_usuario]
        );

        // Registrar inicio de sesión exitoso
        await logLoginAttempt(
            id_empresa,
            usuario,
            true,
            ip
        );

        // Respuesta
        return res.json({
            success: true,
            data: {
                id: user.id_usuario,
                nombre: user.nombre,
                rol: user.rol,
                id_empresa: user.id_empresa,
                empresa: empresa,
                config: config[0] || null,
                token
            },
            message: 'Inicio de sesión exitoso'
        });

    } catch (error) {
        console.error('Error en login:', error);

        return res.status(500).json({
            success: false,
            message: 'Error en el servidor'
        });
    }
});

module.exports = router;
