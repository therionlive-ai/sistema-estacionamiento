const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

// Obtener tarifas activas por tipo para la empresa
// Relacionado con: public/admin/tarifas.html, public/js/tarifas.js
router.get('/current', verifyToken, async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT t.*, tv.nombre as tipo_nombre, tv.codigo as tipo_codigo
             FROM tarifas t
             JOIN tipos_vehiculos tv ON t.id_tipo = tv.id_tipo
             WHERE t.id_empresa = ? AND t.activa = TRUE 
             ORDER BY tv.nombre`,
            [req.user.id_empresa]
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Error al obtener tarifas' });
    }
});

// Actualizar/crear nueva vigencia de tarifa por tipo
router.put('/', verifyToken, requireAdmin, async (req, res) => {
    try {
        let {
            id_tipo,
            valor_minuto,
            valor_hora,
            valor_dia_completo,
            modo_cobro = 'mixto',
            paso_minutos_a_horas = 0,
            paso_horas_a_dias = 0,
            redondeo_horas = 'arriba',
            redondeo_dias = 'arriba'
        } = req.body;

        if (!id_tipo) {
            return res.status(400).json({ success: false, message: 'id_tipo es requerido' });
        }

        // Verificar que el tipo pertenece a la empresa
        const [tipo] = await pool.query(
            'SELECT id_tipo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE',
            [id_tipo, req.user.id_empresa]
        );

        if (tipo.length === 0) {
            return res.status(400).json({ success: false, message: 'Tipo de vehículo no válido o inactivo' });
        }

        // Normalizar segun modo
        valor_minuto = Number(valor_minuto||0);
        valor_hora = Number(valor_hora||0);
        valor_dia_completo = Number(valor_dia_completo||0);
        if (modo_cobro === 'minuto') {
            if (valor_minuto <= 0) return res.status(400).json({success:false,message:'Debe definir valor por minuto > 0'});
            valor_hora = 0; valor_dia_completo = 0; paso_minutos_a_horas = 0; paso_horas_a_dias = 0;
        } else if (modo_cobro === 'hora') {
            if (valor_hora <= 0) return res.status(400).json({success:false,message:'Debe definir valor por hora > 0'});
            valor_minuto = 0; valor_dia_completo = 0; paso_minutos_a_horas = 0; paso_horas_a_dias = 0;
        } else if (modo_cobro === 'dia') {
            if (valor_dia_completo <= 0) return res.status(400).json({success:false,message:'Debe definir valor por día > 0'});
            valor_minuto = 0; valor_hora = 0; paso_minutos_a_horas = 0; paso_horas_a_dias = 0;
        } else { // mixto
            if (valor_minuto <= 0 || valor_hora <= 0 || valor_dia_completo <= 0) {
                return res.status(400).json({success:false,message:'En modo mixto todos los valores deben ser > 0'});
            }
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            // Desactivar vigencia actual de ese tipo
            await conn.query(
                `UPDATE tarifas SET activa = FALSE, fecha_vigencia_hasta = CURRENT_TIMESTAMP
                 WHERE id_empresa = ? AND id_tipo = ? AND activa = TRUE`,
                [req.user.id_empresa, id_tipo]
            );
            // Insertar nueva
            const [ins] = await conn.query(
                `INSERT INTO tarifas (
                    id_empresa, id_tipo, valor_hora, valor_minuto, valor_dia_completo,
                    fecha_vigencia_desde, activa, modo_cobro, paso_minutos_a_horas, paso_horas_a_dias,
                    redondeo_horas, redondeo_dias
                ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, TRUE, ?, ?, ?, ?, ?)`,
                [
                    req.user.id_empresa,
                    id_tipo,
                    valor_hora,
                    valor_minuto,
                    valor_dia_completo,
                    modo_cobro,
                    paso_minutos_a_horas,
                    paso_horas_a_dias,
                    redondeo_horas,
                    redondeo_dias
                ]
            );
            await conn.commit();
            res.json({ success: true, id_tarifa: ins.insertId, message: 'Tarifa actualizada' });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Error al guardar la tarifa' });
    }
});

module.exports = router;


