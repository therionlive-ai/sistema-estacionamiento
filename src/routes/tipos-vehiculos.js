const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const { sanitizeIdParam } = require('../utils/sanitize');

const TIPOS_OFICIALES = {
    automovil: 'Automóvil',
    motocicleta: 'Motocicleta'
};

async function verificarPropiedadTipo(req, res, next) {
    try {
        const [tipo] = await pool.query(
            'SELECT id_tipo, codigo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ?',
            [req.params.id, req.user.id_empresa]
        );
        if (!tipo.length || !TIPOS_OFICIALES[tipo[0].codigo]) {
            return res.status(404).json({ success: false, message: 'Tipo de vehículo no encontrado' });
        }
        req.tipoActual = tipo[0];
        next();
    } catch (error) {
        console.error('Error al verificar tipo de vehículo:', error);
        res.status(500).json({ success: false, message: 'Error al verificar el tipo de vehículo' });
    }
}

router.use(verifyToken);

router.get('/', async (req, res) => {
    try {
        const [tipos] = await pool.query(
            `SELECT tv.*,
                    COALESCE(ct.capacidad_total, 0) AS capacidad_total,
                    (SELECT COUNT(*) FROM vehiculos v WHERE v.id_tipo = tv.id_tipo AND v.id_empresa = tv.id_empresa) AS total_vehiculos,
                    (SELECT COUNT(*) FROM tarifas t WHERE t.id_tipo = tv.id_tipo AND t.id_empresa = tv.id_empresa AND t.activa = TRUE) AS tiene_tarifa_activa
             FROM tipos_vehiculos tv
             LEFT JOIN capacidades_tipo ct ON ct.id_tipo = tv.id_tipo AND ct.id_empresa = tv.id_empresa
             WHERE tv.id_empresa = ? AND tv.codigo IN ('automovil','motocicleta')
             ORDER BY FIELD(tv.codigo, 'automovil', 'motocicleta')`,
            [req.user.id_empresa]
        );
        res.json({ success: true, data: tipos });
    } catch (error) {
        console.error('Error al obtener tipos de vehículos:', error);
        res.status(500).json({ success: false, message: 'Error al obtener los tipos de vehículos' });
    }
});

router.get('/activos', async (req, res) => {
    try {
        const [tipos] = await pool.query(
            `SELECT id_tipo, nombre, codigo
             FROM tipos_vehiculos
             WHERE id_empresa = ? AND activo = TRUE AND codigo IN ('automovil','motocicleta')
             ORDER BY FIELD(codigo, 'automovil', 'motocicleta')`,
            [req.user.id_empresa]
        );
        res.json({ success: true, data: tipos });
    } catch (error) {
        console.error('Error al obtener tipos activos:', error);
        res.status(500).json({ success: false, message: 'Error al obtener los tipos activos' });
    }
});

router.get('/:id', sanitizeIdParam('id'), verificarPropiedadTipo, async (req, res) => {
    try {
        const [tipos] = await pool.query(
            `SELECT tv.*, COALESCE(ct.capacidad_total, 0) AS capacidad_total
             FROM tipos_vehiculos tv
             LEFT JOIN capacidades_tipo ct ON ct.id_tipo = tv.id_tipo AND ct.id_empresa = tv.id_empresa
             WHERE tv.id_tipo = ? AND tv.id_empresa = ?`,
            [req.params.id, req.user.id_empresa]
        );
        if (!tipos.length) return res.status(404).json({ success: false, message: 'Tipo de vehículo no encontrado' });
        res.json({ success: true, data: tipos[0] });
    } catch (error) {
        console.error('Error al obtener tipo de vehículo:', error);
        res.status(500).json({ success: false, message: 'Error al obtener el tipo de vehículo' });
    }
});

// LKCO trabaja únicamente con los dos tipos oficiales.
router.post('/', requireAdmin, async (_req, res) => {
    res.status(405).json({ success: false, message: 'Los tipos de vehículo están definidos por LKCO: Automóvil y Motocicleta.' });
});

router.put('/:id', requireAdmin, sanitizeIdParam('id'), verificarPropiedadTipo, async (req, res) => {
    try {
        const { activo, capacidad_total } = req.body;
        const capacidad = Number(capacidad_total);
        if (capacidad_total !== undefined && (!Number.isInteger(capacidad) || capacidad < 0)) {
            return res.status(400).json({ success: false, message: 'La capacidad debe ser un número entero mayor o igual a 0' });
        }

        const codigo = req.tipoActual.codigo;
        const nombre = TIPOS_OFICIALES[codigo];
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.query(
                `UPDATE tipos_vehiculos SET nombre = ?, codigo = ?, activo = ?
                 WHERE id_tipo = ? AND id_empresa = ?`,
                [nombre, codigo, activo === undefined ? true : !!activo, req.params.id, req.user.id_empresa]
            );
            if (capacidad_total !== undefined) {
                await conn.query(
                    `INSERT INTO capacidades_tipo (id_empresa, id_tipo, capacidad_total)
                     VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE capacidad_total = VALUES(capacidad_total)`,
                    [req.user.id_empresa, req.params.id, capacidad]
                );
            }
            await conn.commit();
            res.json({ success: true, message: 'Configuración del tipo actualizada' });
        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }
    } catch (error) {
        console.error('Error al actualizar tipo de vehículo:', error);
        res.status(500).json({ success: false, message: 'Error al actualizar el tipo de vehículo' });
    }
});

router.delete('/:id', requireAdmin, sanitizeIdParam('id'), verificarPropiedadTipo, async (_req, res) => {
    res.status(405).json({ success: false, message: 'Automóvil y Motocicleta son tipos oficiales y no se pueden eliminar.' });
});

module.exports = router;
